#!/usr/bin/env python3
"""
DOL Form 5500 (FULL / large-plan) headcount-growth ingest — companion to
ingest_dol5500.py (which covers the SF / small-plan file, <100 participants).

The full Form 5500 is filed by employers whose plan has 100+ participants — i.e.
your LARGER, later-stage targets that the SF file misses. Same signal, same column
(headcount_growth_pct), same >=25% surfacing in Triggered.

Matches claimable (NetSuite-TAM) leads by normalized sponsor name and computes
within-year ACTIVE-participant growth: TOT_ACT_PARTCP_BOY_CNT (active, beginning of
year) -> TOT_ACTIVE_PARTCP_CNT (active, end of year) — the same active-participant
basis as the SF file. MERGE-MAX: only raises a company's headcount_growth_pct (never
lowers an existing SF value), so it's safe to run after the SF ingest and re-runnable.

Prereqs: download + unzip the full 5500 file, e.g.
  curl -sL "https://askebsa.dol.gov/FOIA Files/2023/Latest/F_5500_2023_Latest.zip" -o f.zip
  unzip f.zip -d f5500
Then: F5500_CSV=f5500/f_5500_2023_latest.csv python3 scripts/ingest_dol5500_full.py
Reads SBURL/SBKEY from jarvis/.env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
"""
import os, re, csv, ssl, json, urllib.request
from collections import defaultdict
csv.field_size_limit(10**7)
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE

def env(k):
    for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local")):
        if line.startswith(k + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("missing " + k)

URL = env("NEXT_PUBLIC_SUPABASE_URL"); KEY = env("SUPABASE_SERVICE_ROLE_KEY")
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}
F5 = os.environ.get("F5500_CSV", "/tmp/f5500/f_5500_2023_latest.csv")
MIN_BOY = 10        # ignore tiny denominators (noise)
CAP_PCT = 400       # cap absurd deltas

NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the|and)\b")
def norm(s):
    s = (s or "").lower(); s = re.sub(r"&", " and ", s); s = re.sub(r"[^a-z0-9]+", " ", s); s = NOISE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()

# 1) claimable name -> id, plus id -> existing headcount_growth_pct (for merge-max)
norm2id = {}; id2existing = {}; frm = 0
while True:
    b = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{URL}/rest/v1/companies?is_base=eq.true&claimable=eq.true&select=id,name,headcount_growth_pct&limit=1000&offset={frm}", headers=H), context=CTX))
    for r in b:
        n = norm(r["name"])
        if n and len(n) >= 4 and n not in norm2id:  # first wins (dedupe)
            norm2id[n] = r["id"]
        id2existing[r["id"]] = r.get("headcount_growth_pct")
    if len(b) < 1000: break
    frm += 1000
print("claimable names:", len(norm2id))

# 2) stream the full 5500, best ACTIVE-participant growth per matched company
best = {}  # company_id -> pct
f = open(F5, encoding="latin-1"); rd = csv.reader(f); hdr = next(rd)
iS = hdr.index("SPONSOR_DFE_NAME"); iD = hdr.index("SPONS_DFE_DBA_NAME") if "SPONS_DFE_DBA_NAME" in hdr else -1
iB = hdr.index("TOT_ACT_PARTCP_BOY_CNT"); iE = hdr.index("TOT_ACTIVE_PARTCP_CNT")
rows = 0
for row in rd:
    rows += 1
    if len(row) <= max(iS, iB, iE): continue
    try:
        boy = int(float(row[iB] or 0)); eoy = int(float(row[iE] or 0))
    except ValueError:
        continue
    if boy < MIN_BOY or eoy <= 0: continue
    pct = round(min(CAP_PCT, (eoy - boy) / boy * 100), 1)
    for idx in (iS, iD):
        if idx < 0 or idx >= len(row): continue
        cid = norm2id.get(norm(row[idx]))
        if cid and pct > best.get(cid, -1):
            best[cid] = pct
f.close()
print(f"scanned {rows} filings; matched {len(best)} claimable companies; >=25% growth: {sum(1 for v in best.values() if v >= 25)}")

# 3) MERGE-MAX write: only raise headcount_growth_pct above the current value
def patch(ids, pct):
    for i in range(0, len(ids), 100):
        idlist = ",".join(ids[i:i+100])
        req = urllib.request.Request(f"{URL}/rest/v1/companies?id=in.({idlist})",
            data=json.dumps({"headcount_growth_pct": pct}).encode(),
            headers={**H, "content-type": "application/json", "Prefer": "return=minimal"}, method="PATCH")
        urllib.request.urlopen(req, context=CTX).read()

bypct = defaultdict(list); skipped = 0
for cid, pct in best.items():
    cur = id2existing.get(cid)
    if cur is not None and float(cur) >= pct:
        skipped += 1; continue   # SF (or a prior run) already has an equal/higher value
    bypct[pct].append(cid)
done = 0
for pct, ids in bypct.items():
    patch(ids, pct); done += len(ids)
print(f"updated headcount_growth_pct on {done} companies (skipped {skipped} already >= via SF/prior run)")
