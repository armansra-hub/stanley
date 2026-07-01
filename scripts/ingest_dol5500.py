#!/usr/bin/env python3
"""
DOL Form 5500 headcount-growth ingest (run AFTER migration 0028).

Matches claimable (NetSuite-TAM) leads to their Form 5500-SF retirement-plan filing
by normalized company name, computes within-year active-participant growth
(EOY vs BOY), and writes headcount_growth_pct onto the matching company. Attaches
the % to everyone it matches (never filters); leads at >=25% surface in Triggered
(see listTriggered + recomputePriority). Re-run annually (new 5500 file) or after a
TAM refresh.

Prereqs: download + unzip the 5500-SF file, e.g.
  curl -sL "https://www.askebsa.dol.gov/FOIA Files/2023/Latest/F_5500_SF_2023_Latest.zip" -o sf.zip
  unzip sf.zip -d sf
Then: SF_CSV=sf/f_5500_sf_2023_latest.csv python3 scripts/ingest_dol5500.py
Reads SBURL/SBKEY from jarvis/.env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
"""
import os, re, csv, ssl, json, urllib.request
csv.field_size_limit(10**7)
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE

def env(k):
    for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local")):
        if line.startswith(k + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("missing " + k)

URL = env("NEXT_PUBLIC_SUPABASE_URL"); KEY = env("SUPABASE_SERVICE_ROLE_KEY")
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}
SF = os.environ.get("SF_CSV", "/tmp/sf/f_5500_sf_2023_latest.csv")
MIN_BOY = 10        # ignore tiny denominators (noise)
CAP_PCT = 400       # cap absurd deltas

NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the|and)\b")
def norm(s):
    s = (s or "").lower(); s = re.sub(r"&", " and ", s); s = re.sub(r"[^a-z0-9]+", " ", s); s = NOISE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()

# 1) claimable name -> id
norm2id = {}; frm = 0
while True:
    b = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{URL}/rest/v1/companies?is_base=eq.true&claimable=eq.true&select=id,name&limit=1000&offset={frm}", headers=H), context=CTX))
    for r in b:
        n = norm(r["name"])
        if n and len(n) >= 4 and n not in norm2id:  # first wins (dedupe)
            norm2id[n] = r["id"]
    if len(b) < 1000: break
    frm += 1000
print("claimable names:", len(norm2id))

# 2) stream 5500-SF, best growth per matched company
best = {}  # company_id -> pct
f = open(SF, encoding="latin-1"); rd = csv.reader(f); hdr = next(rd)
iS = hdr.index("SF_SPONSOR_NAME"); iD = hdr.index("SF_SPONSOR_DFE_DBA_NAME") if "SF_SPONSOR_DFE_DBA_NAME" in hdr else -1
iB = hdr.index("SF_TOT_ACT_PARTCP_BOY_CNT"); iE = hdr.index("SF_TOT_ACT_PARTCP_EOY_CNT")
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

# 3) write headcount_growth_pct (chunked PATCH per value group keeps it simple)
def patch(ids, pct):
    for i in range(0, len(ids), 100):
        chunk = ids[i:i+100]
        idlist = ",".join(chunk)
        req = urllib.request.Request(f"{URL}/rest/v1/companies?id=in.({idlist})",
            data=json.dumps({"headcount_growth_pct": pct}).encode(),
            headers={**H, "content-type": "application/json", "Prefer": "return=minimal"}, method="PATCH")
        urllib.request.urlopen(req, context=CTX).read()

from collections import defaultdict
bypct = defaultdict(list)
for cid, pct in best.items(): bypct[pct].append(cid)
done = 0
for pct, ids in bypct.items():
    patch(ids, pct); done += len(ids)
print("updated headcount_growth_pct on", done, "companies")
