#!/usr/bin/env python3
"""Download DOL Form 5500 public files and ingest matched current NetSuite TAM plans."""
import argparse, csv, io, json, os, re, time, urllib.error, urllib.request, zipfile
from collections import defaultdict

DATASET_PAGE = "https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/public-disclosure/foia/form-5500-datasets"
NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the)\b")

def norm(value):
    value = re.sub(r"&", " and ", str(value or "").lower())
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", NOISE.sub(" ", value)).strip()

def env_file(name):
    path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None

def request_json(url, secret, payload=None, attempts=4):
    body = None if payload is None else json.dumps(payload).encode()
    method = "GET" if body is None else "POST"
    req = urllib.request.Request(url, data=body, method=method, headers={"x-cron-secret": secret, "content-type": "application/json", "user-agent": "Stanley-TAM-Form5500/1.0"})
    last = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            last = error
            status = getattr(error, "code", None)
            if status not in (429, 500, 502, 503, 504) or attempt + 1 >= attempts:
                raise
            time.sleep(2 ** attempt)
    raise last

def load_tam(app, secret):
    companies, offset = [], 0
    while True:
        page = request_json(f"{app}/api/cron/public-growth/form5500?offset={offset}&limit=1000", secret)
        companies.extend(page["companies"])
        if page["done"]: return companies
        offset = page["nextOffset"]

def first(row, names, default=""):
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return default

def integer(value):
    try: return int(float(str(value or 0).strip()))
    except ValueError: return None

def date_value(value):
    value = str(value or "").strip()
    if re.fullmatch(r"\d{8}", value): return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value): return value
    return None

def match_company(row, index):
    sponsor = first(row, ["SPONSOR_DFE_NAME", "SF_SPONSOR_NAME"])
    dba = first(row, ["SPONS_DFE_DBA_NAME", "SF_SPONSOR_DFE_DBA_NAME"])
    state = first(row, ["SPONS_DFE_MAIL_US_STATE", "SF_SPONS_US_STATE", "SPONS_DFE_LOC_US_STATE", "SF_SPONS_LOC_US_STATE"]).upper()
    city = norm(first(row, ["SPONS_DFE_MAIL_US_CITY", "SF_SPONS_US_CITY", "SPONS_DFE_LOC_US_CITY", "SF_SPONS_LOC_US_CITY"]))
    candidates = {}
    for name in (sponsor, dba):
        key = norm(name)
        if len(key) >= 4:
            for company in index.get(key, []): candidates[company["id"]] = company
    if not candidates: return None
    if state:
        scoped = {cid: c for cid, c in candidates.items() if str(c.get("state") or "").upper() == state}
        if scoped: candidates = scoped
    if city and len(candidates) > 1:
        scoped = {cid: c for cid, c in candidates.items() if norm(c.get("city")) == city}
        if scoped: candidates = scoped
    if len(candidates) != 1: return None
    cid = next(iter(candidates))
    return cid, ("exact_name_state_city" if state and city else "unique_exact_name"), (0.98 if state and city else 0.91)

def rows_from_zip(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "Stanley-TAM-Form5500/1.0"}), timeout=300) as response:
        blob = response.read()
    archive = zipfile.ZipFile(io.BytesIO(blob))
    csv_names = [n for n in archive.namelist() if n.lower().endswith((".csv", ".txt"))]
    if not csv_names: raise RuntimeError(f"no CSV in {url}")
    name = max(csv_names, key=lambda n: archive.getinfo(n).file_size)
    with archive.open(name) as raw, io.TextIOWrapper(raw, encoding="latin-1", newline="") as text:
        yield from csv.DictReader(text)

def observation(row, company_id, method, confidence, year, form_type, url):
    prefix = "SF_" if form_type == "5500-SF" else ""
    filing = first(row, [prefix + "ACK_ID", prefix + "FILING_ID", "ACK_ID", "FILING_ID"])
    ein = first(row, [prefix + "SPONSOR_EIN", "SPONS_DFE_EIN", "SPONSOR_DFE_EIN"])
    plan = first(row, [prefix + "PLAN_NUM", "PLAN_NUM"], "000")
    sponsor = first(row, [prefix + "SPONSOR_NAME", "SPONSOR_DFE_NAME"])
    boy = integer(first(row, [prefix + "TOT_ACT_PARTCP_BOY_CNT", "TOT_ACT_PARTCP_BOY_CNT"]))
    eoy = integer(first(row, ["SF_TOT_ACT_PARTCP_EOY_CNT", "TOT_ACTIVE_PARTCP_CNT", "TOT_ACT_PARTCP_EOY_CNT"]))
    if not filing: filing = f"{year}:{ein}:{plan}:{norm(sponsor)}"
    return {"companyId": company_id, "filingId": str(filing), "formType": form_type, "sponsorEin": str(ein) or None, "sponsorName": sponsor, "sponsorDba": first(row, ["SF_SPONSOR_DFE_DBA_NAME", "SPONS_DFE_DBA_NAME"]) or None, "sponsorCity": first(row, ["SF_SPONS_US_CITY", "SPONS_DFE_MAIL_US_CITY"]) or None, "sponsorState": first(row, ["SF_SPONS_US_STATE", "SPONS_DFE_MAIL_US_STATE"]) or None, "sponsorZip": first(row, ["SF_SPONS_US_ZIP", "SPONS_DFE_MAIL_US_ZIP"]) or None, "planNumber": str(plan), "planName": first(row, [prefix + "PLAN_NAME", "PLAN_NAME"]) or None, "formYear": year, "planYearBegin": date_value(first(row, [prefix + "PLAN_YEAR_BEGIN_DATE", "PLAN_YEAR_BEGIN_DATE"])), "planYearEnd": date_value(first(row, [prefix + "PLAN_YEAR_END_DATE", "PLAN_YEAR_END_DATE"])), "activeParticipantsBoy": boy, "activeParticipantsEoy": eoy, "matchMethod": method, "matchConfidence": confidence, "sourceUrl": url, "evidence": {"datasetPage": DATASET_PAGE}}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default=os.getenv("APP_BASE_URL") or env_file("APP_BASE_URL") or "https://jarvis-sable-eta.vercel.app")
    parser.add_argument("--secret", default=os.getenv("CRON_SECRET") or env_file("CRON_SECRET"))
    parser.add_argument("--years", nargs="+", type=int, default=[2023, 2024, 2025])
    parser.add_argument("--batch-size", type=int, default=10)
    args = parser.parse_args()
    if not args.secret: raise SystemExit("CRON_SECRET is required")
    companies = load_tam(args.app.rstrip("/"), args.secret)
    index = defaultdict(list)
    for company in companies:
        key = norm(company["name"])
        if len(key) >= 4: index[key].append(company)
    total = matched = stored = triggers = 0
    for year in sorted(args.years):
        for form_type, stem in (("5500", "F_5500"), ("5500-SF", "F_5500_SF")):
            url = f"https://askebsa.dol.gov/FOIA%20Files/{year}/Latest/{stem}_{year}_Latest.zip"
            batch = []
            for row in rows_from_zip(url):
                total += 1
                hit = match_company(row, index)
                if not hit: continue
                matched += 1
                batch.append(observation(row, *hit, year, form_type, url))
                if len(batch) >= args.batch_size:
                    receipt = request_json(f"{args.app.rstrip('/')}/api/cron/public-growth/form5500", args.secret, {"observations": batch})
                    stored += receipt["stored"]; triggers += receipt["triggers"]; batch = []
            if batch:
                receipt = request_json(f"{args.app.rstrip('/')}/api/cron/public-growth/form5500", args.secret, {"observations": batch})
                stored += receipt["stored"]; triggers += receipt["triggers"]
            print(json.dumps({"year": year, "form": form_type, "scanned": total, "matched": matched, "stored": stored, "triggers": triggers}))
    print(json.dumps({"done": True, "tam": len(companies), "scanned": total, "matched": matched, "stored": stored, "triggers": triggers}))

if __name__ == "__main__": main()
