#!/usr/bin/env python3
"""Checkpointed NetSuite-TAM sweep over the official SBA 7(a)/504 bulk files."""
import argparse, csv, datetime, hashlib, json, os, re, ssl, tempfile, urllib.request

CTX = ssl.create_default_context()
NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the|and)\b")
GENERIC = {"financial","assistance","services","service","solutions","consulting","group","partners","management","capital","logistics","transport","transportation","express","national","american","associates","enterprises","systems","global","supply","medical","health","data","tech","technology","freight"}
SOURCE_URL = "https://data.sba.gov/dataset/7a-504-foia"

def norm(value):
    value = re.sub(r"[^a-z0-9]+", " ", (value or "").lower().replace("&", " and "))
    return re.sub(r"\s+", " ", NOISE.sub(" ", value)).strip()

def city_norm(value): return re.sub(r"[^a-z]", "", (value or "").lower())

def parse_date(value):
    raw = (value or "").strip()
    for pattern in ("%Y-%m-%d", "%m/%d/%Y"):
        try: return datetime.datetime.strptime(raw, pattern).date()
        except ValueError: pass
    return None

def request_json(url, secret, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"x-cron-secret": secret, "content-type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, context=CTX, timeout=180) as response:
        return json.load(response)

def atomic_write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="sba-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle: json.dump(value, handle, indent=2, sort_keys=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def load_tam(app, secret):
    rows, offset = [], 0
    while True:
        page = request_json(f"{app}/api/cron/public-growth/sba-loans?offset={offset}&limit=1000", secret)
        rows.extend(page.get("companies", []))
        if page.get("done"): return rows
        offset = page["nextOffset"]

def scan_file(path, program, index, cutoff):
    observations, scanned, ambiguous = [], 0, 0
    with open(path, encoding="latin-1", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            scanned += 1
            approved = parse_date(row.get("ApprovalDate"))
            if approved is None: continue
            if approved < cutoff: continue
            state = (row.get("BorrState") or "").strip().upper()
            name = (row.get("BorrName") or "").strip()
            candidates = index.get((norm(name), state), [])
            if not candidates: continue
            loan_city = (row.get("BorrCity") or "").strip()
            city_matches = [c for c in candidates if city_norm(c.get("city")) and city_norm(c.get("city")) == city_norm(loan_city)]
            if len(city_matches) == 1: company, method, confidence = city_matches[0], "exact_name_city_state", 0.98
            elif len(candidates) == 1:
                company, method, confidence = candidates[0], "exact_name_state", 0.86
                tokens = norm(name).split()
                if (len(tokens) == 1 and len(tokens[0]) < 8) or (tokens and all(token in GENERIC for token in tokens)):
                    ambiguous += 1; continue
            else:
                ambiguous += 1; continue
            try: amount = float((row.get("GrossApproval") or "0").replace(",", ""))
            except ValueError: continue
            observations.append({
                "companyId": company["id"], "program": program,
                "locationId": (row.get("LocationID") or f"{name}-{approved}").strip(),
                "borrowerName": name, "borrowerCity": loan_city or None, "borrowerState": state,
                "approvalDate": approved.isoformat(), "grossApproval": amount,
                "lender": (row.get("BankName") or row.get("ThirdPartyLender_Name") or row.get("CDC_Name") or "").strip() or None,
                "naicsCode": (row.get("NaicsCode") or "").strip() or None,
                "naicsDescription": (row.get("NaicsDescription") or "").strip() or None,
                "matchMethod": method, "matchConfidence": confidence, "sourceUrl": SOURCE_URL,
            })
    return observations, scanned, ambiguous

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="https://jarvis-sable-eta.vercel.app")
    parser.add_argument("--secret", default=os.environ.get("CRON_SECRET"))
    parser.add_argument("--seven-a", required=True)
    parser.add_argument("--five-oh-four", required=True)
    parser.add_argument("--lookback-days", type=int, default=548)
    parser.add_argument("--state-file", default=os.path.join(os.path.dirname(__file__), "..", ".foundation-run", "sba-foundation.json"))
    args = parser.parse_args()
    if not args.secret: raise SystemExit("CRON_SECRET is required")
    state_path = os.path.abspath(args.state_file)
    tam = load_tam(args.app.rstrip("/"), args.secret)
    tam_hash = hashlib.sha256("\n".join(sorted(str(c["id"]) for c in tam)).encode()).hexdigest()
    index = {}
    for company in tam:
        key = (norm(company.get("name")), (company.get("state") or "").strip().upper())
        if key[0] and key[1]: index.setdefault(key, []).append(company)
    cutoff = datetime.date.today() - datetime.timedelta(days=args.lookback_days)
    seven, seven_scanned, seven_ambiguous = scan_file(args.seven_a, "7(a)", index, cutoff)
    five, five_scanned, five_ambiguous = scan_file(args.five_oh_four, "504", index, cutoff)
    deduped = {}
    for row in seven + five:
        key = (row["companyId"], row["program"], row["locationId"], row["approvalDate"], row["grossApproval"])
        deduped[key] = row
    observations = list(deduped.values())
    prior = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as handle: prior = json.load(handle)
    if prior and prior.get("tamHash") != tam_hash: raise SystemExit("checkpoint TAM scope differs from the current exact NetSuite TAM")
    offset = int(prior.get("ingestOffset", 0))
    totals = prior.get("totals", {"accepted": 0, "rejected": 0, "triggers": 0, "companies": 0})
    state = {"status": "running", "tamCount": len(tam), "tamHash": tam_hash, "cutoff": cutoff.isoformat(), "sevenAScanned": seven_scanned, "fiveOhFourScanned": five_scanned, "ambiguous": seven_ambiguous + five_ambiguous, "candidateCount": len(observations), "ingestOffset": offset, "totals": totals}
    atomic_write(state_path, state)
    while offset < len(observations):
        batch = observations[offset:offset + 100]
        receipt = request_json(f"{args.app.rstrip('/')}/api/cron/public-growth/sba-loans", args.secret, {"observations": batch})
        for key in ("accepted", "rejected", "triggers"): totals[key] = int(totals.get(key, 0)) + int(receipt.get(key, 0))
        totals["companies"] = None
        offset += len(batch)
        state.update({"ingestOffset": offset, "totals": totals, "lastReceipt": receipt})
        atomic_write(state_path, state)
        print(json.dumps({"offset": offset, "total": len(observations), **receipt}), flush=True)
    state["status"] = "complete"; state["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    atomic_write(state_path, state)
    print(json.dumps(state, sort_keys=True), flush=True)

if __name__ == "__main__": main()
