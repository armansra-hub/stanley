#!/usr/bin/env python3
"""Checkpointed NetSuite-TAM sweep over the official SBA 7(a)/504 bulk files."""
import argparse, copy, csv, datetime, hashlib, json, os, re, ssl, tempfile, urllib.request
from foundation_app_http import open_app_request

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
    with open_app_request(req, context=CTX, timeout=180) as response:
        return json.load(response)

def atomic_write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="sba-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.flush(); os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def source_hash(path):
    with open(path, "rb") as handle: return hashlib.file_digest(handle, "sha256").hexdigest()

def exact_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)

def require_no_pending(prior):
    if "pendingBatch" in prior:
        raise SystemExit("unresolved SBA pending batch; preserve checkpoint and obtain explicit durable source-bound readback reconciliation before resume or reset")

def validate_expected(path, observations):
    if not path: return None
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError("duplicate key in expected SBA observations")
            result[key] = value
        return result
    digest = source_hash(path)
    with open(path, encoding="utf-8-sig") as handle:
        expected = json.load(handle, object_pairs_hook=unique_object)
    if (not isinstance(expected, dict) or set(expected) != {"observations"}
        or not isinstance(expected["observations"], list)
        or exact_json(expected) != exact_json({"observations": observations})):
        raise SystemExit("actual ordered SBA observations differ from the approved exact payload; no checkpoint reset or write permitted")
    if source_hash(path) != digest: raise SystemExit("approved SBA payload changed during validation")
    return {"path": os.path.abspath(path), "sha256": digest}

def require_expected_unchanged(expected):
    if expected and source_hash(expected["path"]) != expected["sha256"]:
        raise SystemExit("approved SBA payload changed; no checkpoint reset or request permitted")

def archive_prior(path, archive_path):
    """Preserve exact old checkpoint bytes before atomic replacement; never delete it."""
    with open(path, "rb") as handle: body = handle.read()
    os.makedirs(os.path.dirname(os.path.abspath(archive_path)), exist_ok=True)
    with open(archive_path, "xb") as handle:
        handle.write(body); handle.flush(); os.fsync(handle.fileno())
    if source_hash(path) != hashlib.sha256(body).hexdigest() or source_hash(archive_path) != hashlib.sha256(body).hexdigest():
        raise SystemExit("SBA checkpoint archive failed exact byte verification")
    return {"path": os.path.abspath(archive_path), "sha256": hashlib.sha256(body).hexdigest()}

def commit_batch(state_path, state, batch, app, secret):
    require_no_pending(state)
    require_expected_unchanged(state.get("expectedObservations"))
    start = state["ingestOffset"]
    payload = {"observations": batch}
    body = json.dumps(payload).encode()
    prepared = copy.deepcopy(state)
    prepared["pendingBatch"] = {
        "version": 1, "status": "pending_request", "startOffset": start, "endOffset": start + len(batch),
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "requestUrl": f"{app}/api/cron/public-growth/sba-loans", "requestMethod": "POST",
        "requestBodyUtf8": body.decode(), "requestBodySha256": hashlib.sha256(body).hexdigest(), "requestBodyBytes": len(body),
        "observationsSha256": state["observationsSha256"], "tamHash": state["tamHash"],
        "expectedObservations": state.get("expectedObservations"), "checkpointSha256Before": source_hash(state_path),
    }
    atomic_write(state_path, prepared)
    state.clear(); state.update(prepared)
    require_expected_unchanged(state.get("expectedObservations"))
    # request_json has exactly one transport attempt. Any exception or invalid
    # acknowledgment retains the durable intent and original offset.
    receipt = request_json(prepared["pendingBatch"]["requestUrl"], secret, payload)
    if (not isinstance(receipt, dict)
        or any(type(receipt.get(key)) is not int or receipt[key] < 0 for key in ("received", "accepted", "rejected", "triggers", "companies"))
        or receipt["received"] != len(batch) or receipt["accepted"] != len(batch) or receipt["rejected"] != 0 or receipt["triggers"] > len(batch)
        or receipt["companies"] != len({row["companyId"] for row in batch})):
        raise RuntimeError("SBA response did not acknowledge the complete exact batch")
    committed = copy.deepcopy(state)
    for key in ("accepted", "rejected", "triggers"):
        committed["totals"][key] = int(committed["totals"].get(key, 0)) + receipt[key]
    committed["totals"]["companies"] = None
    committed["ingestOffset"] = start + len(batch)
    committed["lastReceipt"] = receipt
    committed["lastAcknowledgedBatch"] = {"startOffset": start, "endOffset": start + len(batch), "requestBodySha256": prepared["pendingBatch"]["requestBodySha256"], "acknowledgedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    del committed["pendingBatch"]
    atomic_write(state_path, committed)
    state.clear(); state.update(committed)
    return receipt

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
    parser.add_argument("--expected-observations", help="approved JSON payload; require exact ordered observations before writes")
    parser.add_argument("--reset-checkpoint-archive", help="exclusive archive of the prior checkpoint after exact payload validation; requires --expected-observations")
    args = parser.parse_args()
    if not args.secret: raise SystemExit("CRON_SECRET is required")
    state_path = os.path.abspath(args.state_file)
    prior = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as handle: prior = json.load(handle)
    if not isinstance(prior, dict): raise SystemExit("invalid SBA checkpoint")
    require_no_pending(prior)
    if args.reset_checkpoint_archive and not args.expected_observations:
        raise SystemExit("SBA checkpoint reset requires an approved exact observations payload")
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
    expected_path = args.expected_observations or (prior.get("expectedObservations") or {}).get("path")
    expected = validate_expected(expected_path, observations)
    if prior.get("expectedObservations") and not args.reset_checkpoint_archive:
        require_expected_unchanged(prior["expectedObservations"])
    observations_sha = hashlib.sha256(exact_json({"observations": observations}).encode()).hexdigest()
    archived = None
    if args.reset_checkpoint_archive:
        if not prior: raise SystemExit("SBA reset requires the existing prior checkpoint")
        if prior.get("tamCount") == len(tam): raise SystemExit("SBA checkpoint already has the current TAM size; review its scope before reset")
        require_expected_unchanged(expected)
        archived = archive_prior(state_path, args.reset_checkpoint_archive)
        prior = {}
    if prior and prior.get("tamHash") != tam_hash: raise SystemExit("checkpoint TAM scope differs from the current exact NetSuite TAM")
    if prior.get("observationsSha256") and prior["observationsSha256"] != observations_sha:
        raise SystemExit("SBA ordered source observations changed; preserve checkpoint for explicit review")
    offset = int(prior.get("ingestOffset", 0))
    if offset < 0 or offset > len(observations): raise SystemExit("SBA checkpoint offset is outside the actual observations")
    totals = prior.get("totals", {"accepted": 0, "rejected": 0, "triggers": 0, "companies": 0})
    state = {"status": "running", "tamCount": len(tam), "tamHash": tam_hash, "cutoff": cutoff.isoformat(), "sevenAScanned": seven_scanned, "fiveOhFourScanned": five_scanned, "ambiguous": seven_ambiguous + five_ambiguous, "candidateCount": len(observations), "ingestOffset": offset, "totals": totals}
    state.update({"observationsSha256": observations_sha, "expectedObservations": expected})
    if archived: state["priorCheckpointArchive"] = archived
    elif prior.get("priorCheckpointArchive"): state["priorCheckpointArchive"] = prior["priorCheckpointArchive"]
    for retained in ("lastAcknowledgedBatch", "lastReceipt"):
        if retained in prior: state[retained] = prior[retained]
    require_expected_unchanged(expected)
    atomic_write(state_path, state)
    while offset < len(observations):
        batch = observations[offset:offset + 100]
        receipt = commit_batch(state_path, state, batch, args.app.rstrip('/'), args.secret)
        offset = state["ingestOffset"]
        print(json.dumps({"offset": offset, "total": len(observations), **receipt}), flush=True)
    state["status"] = "complete"; state["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    atomic_write(state_path, state)
    print(json.dumps(state, sort_keys=True), flush=True)

if __name__ == "__main__": main()
