#!/usr/bin/env python3
"""
DOL Form 5500 (FULL / large-plan, 100+ participants) headcount ingest — companion
to ingest_dol5500.py (SF / small plans). Same signals, same merge-max semantics:
  1) headcount_growth_pct (active participants, TOT_ACT_PARTCP_BOY_CNT ->
     TOT_ACTIVE_PARTCP_CNT) — only ever RAISES an existing value.
  2) `headcount_50` trigger when a plan crossed 50 active participants within the
     year (ACA Applicable Large Employer threshold — public proxy for the
     non-public IRS 1094-C/1095-C obligation).
Matches the WHOLE monitored base (is_base=true). Safe to re-run; run after the SF
script (order doesn't actually matter). Recomputes touched priorities at the end.

Usage: F5500_CSV=/path/f_5500_2024_latest.csv YEAR=2024 python3 scripts/ingest_dol5500_full.py
Reads Supabase creds + CRON_SECRET from jarvis/.env.local.
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
YEAR = os.environ.get("YEAR", "2023")
MIN_BOY = 10
CAP_PCT = 400
DATASET_PAGE = "https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/public-disclosure/foia/form-5500-datasets"

NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the|and)\b")
def norm(s):
    s = (s or "").lower(); s = re.sub(r"&", " and ", s); s = re.sub(r"[^a-z0-9]+", " ", s); s = NOISE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()

# 1) whole monitored base: name -> id (+ existing pct for merge-max)
norm2id = {}; id2existing = {}; frm = 0
while True:
    b = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{URL}/rest/v1/companies?is_base=eq.true&select=id,name,headcount_growth_pct&limit=1000&offset={frm}", headers=H), context=CTX))
    for r in b:
        n = norm(r["name"])
        if n and len(n) >= 4 and n not in norm2id:
            norm2id[n] = r["id"]
        id2existing[r["id"]] = r.get("headcount_growth_pct")
    if len(b) < 1000: break
    frm += 1000
print("base names:", len(norm2id))

# 2) stream the full 5500: best growth + ACA-threshold crossings
best = {}; crossed = {}
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
    if boy <= 0 or eoy <= 0: continue
    for idx in (iS, iD):
        if idx < 0 or idx >= len(row): continue
        cid = norm2id.get(norm(row[idx]))
        if not cid: continue
        if boy >= MIN_BOY:
            pct = round(min(CAP_PCT, (eoy - boy) / boy * 100), 1)
            if pct > best.get(cid, -1): best[cid] = pct
        if boy < 50 <= eoy:
            crossed[cid] = (boy, eoy)
f.close()
print(f"scanned {rows} filings; matched {len(best)} base companies; >=25%: {sum(1 for v in best.values() if v >= 25)}; ACA-50 crossings: {len(crossed)}")

# 3) MERGE-MAX write
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
    if cur is not None and float(cur) >= pct: skipped += 1; continue
    bypct[pct].append(cid)
done = 0
for pct, ids in bypct.items(): patch(ids, pct); done += len(ids)
print(f"updated headcount_growth_pct on {done} (skipped {skipped} already >=)")

# 4) crossed-50 (ACA ALE) triggers
trig_rows = [{
    "company_id": cid, "type": "headcount_50", "strength": 72, "half_life_days": 365,
    "summary": f"Crossed the 50-employee ACA threshold in plan-year {YEAR} (active plan participants {boy}→{eoy}) — now an Applicable Large Employer: employer-mandate coverage + 1094-C/1095-C reporting kick in (DOL Form 5500)",
    "source_name": "DOL Form 5500", "source_url": f"{DATASET_PAGE}#aca50-{YEAR}-{cid[:8]}",
    "signal_date": f"{YEAR}-12-31T00:00:00",
} for cid, (boy, eoy) in crossed.items()]
# Plain per-row inserts (the dedupe index is partial — ON CONFLICT can't target it);
# a 409 unique-violation just means the trigger already exists.
ins = dup = 0
for t in trig_rows:
    req = urllib.request.Request(f"{URL}/rest/v1/triggers",
        data=json.dumps(t).encode(),
        headers={**H, "content-type": "application/json", "Prefer": "return=minimal"}, method="POST")
    try:
        urllib.request.urlopen(req, context=CTX).read(); ins += 1
    except urllib.error.HTTPError as e:
        if e.code == 409: dup += 1
        else: raise
print(f"headcount_50 triggers: {ins} new, {dup} already existed")

# 5) recompute touched priorities
try:
    SECRET = env("CRON_SECRET")
    APP = os.environ.get("APP_BASE_URL", "https://jarvis-sable-eta.vercel.app")
    touched = sorted(set(list(best.keys()) + list(crossed.keys())))
    for i in range(0, len(touched), 300):
        req = urllib.request.Request(f"{APP}/api/cron/recompute",
            data=json.dumps({"ids": touched[i:i+300]}).encode(),
            headers={"content-type": "application/json", "x-cron-secret": SECRET}, method="POST")
        print("recompute:", json.load(urllib.request.urlopen(req, context=CTX, timeout=75)))
except Exception as e:
    print("recompute deferred to daily cron:", e)
