#!/usr/bin/env python3
"""
SBA 7(a) + 504 loan ingest — the NATIONAL growth-financing signal (the CO-only UCC
watch, but for all states). An approved SBA loan = verified growth capital
(equipment, real estate, expansion, working capital) with a real dollar amount.

Matches loans to the WHOLE monitored base by normalized borrower NAME + STATE
(state required — kills same-name collisions across the country; dry-matched
2026-07-01: ~490 base companies all-time, 90 approvals since 2025). Approvals in
the last LOOKBACK_DAYS become `sba_loan` triggers (deduped by company+source_url).
Exported/reviewed leads whose export is >14 days old get resurfaced (status→new),
mirroring recordTrigger; dismissed never resurfaces. Then recomputes priorities.

Data (CKAN, refreshed ~quarterly — RE-RUN QUARTERLY):
  https://data.sba.gov/dataset/7-a-504-foia
  Download the "7(a) (FY2020-Present)" and "504 (FY2010-Present)" CSVs.

Usage: SBA_7A=/tmp/sba/foia-7a-....csv SBA_504=/tmp/sba/foia-504-....csv python3 scripts/ingest_sba.py
Reads Supabase creds + CRON_SECRET from jarvis/.env.local.
"""
import os, re, csv, ssl, json, glob, datetime, urllib.request
csv.field_size_limit(10**7)
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE

def env(k):
    for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local")):
        if line.startswith(k + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("missing " + k)

URL = env("NEXT_PUBLIC_SUPABASE_URL"); KEY = env("SUPABASE_SERVICE_ROLE_KEY")
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}
F7A = os.environ.get("SBA_7A") or next(iter(glob.glob("/tmp/sba/foia-7a-*.csv")), None)
F504 = os.environ.get("SBA_504") or next(iter(glob.glob("/tmp/sba/foia-504-*.csv")), None)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "548"))  # ~18mo; hl=180d keeps older ones ranked low
DATASET_PAGE = "https://data.sba.gov/dataset/7-a-504-foia"

GENERIC_TOKENS = {"financial","assistance","services","service","solutions","consulting","group","partners","management","capital","logistics","transport","transportation","express","national","american","associates","enterprises","systems","global","supply","medical","health","data","tech","technology","freight"}
NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the|and)\b")
def norm(s):
    s = (s or "").lower(); s = re.sub(r"&", " and ", s); s = re.sub(r"[^a-z0-9]+", " ", s); s = NOISE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()

# 1) base: (norm name, state) -> {id, status, exported_at}
key2co = {}; frm = 0
while True:
    b = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{URL}/rest/v1/companies?is_base=eq.true&select=id,name,state,city,status,exported_at&limit=1000&offset={frm}", headers=H), context=CTX))
    for r in b:
        n = norm(r["name"]); st = (r.get("state") or "").strip().upper()
        if n and len(n) >= 5 and st:
            key2co.setdefault((n, st), r)
    if len(b) < 1000: break
    frm += 1000
print("base name+state keys:", len(key2co))

# 2) scan both files for recent approvals on matched companies
cutoff = datetime.datetime.now() - datetime.timedelta(days=LOOKBACK_DAYS)
trig_rows = []; touched = set()
def scan(path, program):
    if not path or not os.path.exists(path):
        print(f"⚠ {program} file missing — skipped"); return
    rows = 0; dropped_ambiguous = 0
    with open(path, encoding="latin-1") as f:
        rd = csv.reader(f); hdr = [h.strip().lower() for h in next(rd)]
        iN = hdr.index("borrname"); iS = hdr.index("borrstate"); iC = hdr.index("borrcity")
        iD = hdr.index("approvaldate"); iG = hdr.index("grossapproval")
        iNa = hdr.index("naicsdescription") if "naicsdescription" in hdr else -1
        iB = hdr.index("bankname") if "bankname" in hdr else -1
        for row in rd:
            rows += 1
            if len(row) <= max(iN, iS, iD, iG): continue
            co = key2co.get((norm(row[iN]), row[iS].strip().upper()))
            if not co: continue
            try:
                dt = datetime.datetime.strptime(row[iD].strip(), "%m/%d/%Y")
            except ValueError:
                continue
            if dt < cutoff: continue

            # ── attribution confidence (audited 2026-07-02: name+state alone let a
            # Berkeley restaurant match an agency named "Hatch") ────────────────────
            # City corroboration: borrower city vs our record's city.
            cn = lambda c: re.sub(r"[^a-z]", "", (c or "").lower())
            co_city = co.get("city") or ""
            loan_city = row[iC].strip()
            city_match = bool(co_city and loan_city and cn(co_city) == cn(loan_city))
            city_differs = bool(co_city and loan_city and not city_match)
            # Generic-name test: all-common-word or a single short token = collision-prone.
            toks = norm(co["name"]).split()
            generic = (len(toks) == 1 and len(toks[0]) < 8) or all(t in GENERIC_TOKENS for t in toks)
            # DROP compounded ambiguity: generic name with no city corroboration.
            if generic and not city_match:
                dropped_ambiguous += 1; continue

            amt = row[iG].strip()
            try: amt_s = f"${int(float(amt)):,}"
            except ValueError: amt_s = f"${amt}"
            day = dt.strftime("%Y-%m-%d")
            # Verification evidence lives IN the summary: as-filed borrower name, the
            # city check result, lender, and NAICS industry — judge the match in-app.
            check = "✓ city verified" if city_match else (f"⚠ verify: loan filed in {loan_city.title()}, your record says {co_city}" if city_differs else "city unrecorded — check name/industry")
            naics = (row[iNa].strip() if iNa >= 0 else "")[:48]
            bank = (row[iB].strip() if iB >= 0 else "")[:40]
            detail = "; ".join(x for x in [f"filed as \"{row[iN].strip()}\" ({loan_city.title()}, {row[iS].upper()})", f"industry: {naics}" if naics else "", f"lender: {bank}" if bank else ""] if x)
            trig_rows.append({
                "company_id": co["id"], "type": "sba_loan", "strength": 75, "half_life_days": 180,
                "summary": f"SBA {program} loan approved {dt.strftime('%-m/%-d/%Y')} — {amt_s}. {check}. {detail}",
                "source_name": f"SBA {program} FOIA", "source_url": f"{DATASET_PAGE}#{program.lower().replace('(','').replace(')','')}-{co['id'][:8]}-{day}",
                "signal_date": f"{day}T00:00:00",
            })
            touched.add(co["id"])
    print(f"{program}: scanned {rows} loans, dropped {dropped_ambiguous} ambiguous (generic name, no city corroboration)")

scan(F7A, "7(a)"); scan(F504, "504")
# De-dupe WITHIN the batch (same company + same approval day = same dedupe URL —
# Postgres rejects "ON CONFLICT ... affect row a second time" inside one statement).
seen = set(); deduped = []
for t in trig_rows:
    k = (t["company_id"], t["source_url"])
    if k in seen: continue
    seen.add(k); deduped.append(t)
trig_rows = deduped
print(f"recent-approval triggers to insert: {len(trig_rows)} across {len(touched)} companies")

# 3) insert (deduped vs EXISTING rows by the (company_id, source_url) unique index)
# Plain per-row inserts, mirroring recordTrigger: the dedupe index is partial, so
# ON CONFLICT can't target it — a unique-violation (409) just means "already have it".
ins = dup = 0
for t in trig_rows:
    req = urllib.request.Request(f"{URL}/rest/v1/triggers",
        data=json.dumps(t).encode(),
        headers={**H, "content-type": "application/json", "Prefer": "return=minimal"}, method="POST")
    try:
        urllib.request.urlopen(req, context=CTX).read(); ins += 1
    except urllib.error.HTTPError as e:
        if e.code == 409: dup += 1
        else: raise SystemExit(f"insert failed: {e.code} {e.read().decode()[:300]}")
print(f"inserted {ins} new, {dup} already existed")

# 4) resurface exported/reviewed leads (>14d after export; dismissed stays hidden) —
#    mirrors recordTrigger's rule for the online sweeps.
resurface = []
for cid in touched:
    co = next((c for c in key2co.values() if c["id"] == cid), None)
    if not co: continue
    s = co.get("status")
    if s in ("exported_csv", "exported_sql", "reviewed"):
        exp = co.get("exported_at")
        old = True
        if exp:
            try: old = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(exp.replace("Z", "+00:00"))).days > 14
            except ValueError: pass
        if old: resurface.append(cid)
for i in range(0, len(resurface), 100):
    idlist = ",".join(resurface[i:i+100])
    req = urllib.request.Request(f"{URL}/rest/v1/companies?id=in.({idlist})",
        data=json.dumps({"status": "new", "has_new_signal": True}).encode(),
        headers={**H, "content-type": "application/json", "Prefer": "return=minimal"}, method="PATCH")
    urllib.request.urlopen(req, context=CTX).read()
print(f"resurfaced {len(resurface)} exported/reviewed leads")

# 5) recompute priorities for touched companies
try:
    SECRET = env("CRON_SECRET")
    APP = os.environ.get("APP_BASE_URL", "https://jarvis-sable-eta.vercel.app")
    ids = sorted(touched)
    for i in range(0, len(ids), 300):
        req = urllib.request.Request(f"{APP}/api/cron/recompute",
            data=json.dumps({"ids": ids[i:i+300]}).encode(),
            headers={"content-type": "application/json", "x-cron-secret": SECRET}, method="POST")
        print("recompute:", json.load(urllib.request.urlopen(req, context=CTX, timeout=75)))
except Exception as e:
    print("recompute deferred to daily cron:", e)
