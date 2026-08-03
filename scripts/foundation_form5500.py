#!/usr/bin/env python3
"""Download DOL Form 5500 public files and ingest matched current NetSuite TAM plans.

The foundation files are large enough that a run can outlive a shell or network
connection. Progress is therefore committed to an atomic local checkpoint only
after the corresponding API write succeeds. Replaying the uncommitted tail is
safe because the server upserts observations and deduplicates derived triggers.
"""
import argparse, csv, hashlib, json, os, re, time, urllib.error, urllib.request, zipfile
from collections import defaultdict

DATASET_PAGE = "https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/public-disclosure/foia/form-5500-datasets"
NOISE = re.compile(r"\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the)\b")
STATE_VERSION = 1
USER_AGENT = "Stanley-TAM-Form5500/1.0"

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
    req = urllib.request.Request(url, data=body, method=method, headers={"x-cron-secret": secret, "content-type": "application/json", "user-agent": USER_AGENT})
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

def tam_signature(companies):
    """Hash the exact matching inputs so a changed TAM cannot reuse stale offsets."""
    rows = [{key: company.get(key) for key in ("id", "name", "city", "state")} for company in companies]
    rows.sort(key=lambda row: str(row.get("id") or ""))
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()

def atomic_json(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)

def load_state(path):
    if not os.path.exists(path): return None
    try:
        with open(path, encoding="utf-8") as handle: state = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"checkpoint is unreadable ({path}): {error}")
    if state.get("version") != STATE_VERSION or not isinstance(state.get("datasets"), dict):
        raise SystemExit(f"unsupported checkpoint schema in {path}; use --reset only after reviewing it")
    return state

def process_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False

def acquire_lock(state_path):
    """Prevent two foundation runs from advancing the same checkpoint."""
    lock_path = state_path + ".lock"
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    for _ in range(2):
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({"pid": os.getpid(), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, handle)
                handle.flush(); os.fsync(handle.fileno())
            return lock_path
        except FileExistsError:
            try:
                with open(lock_path, encoding="utf-8") as handle: owner = json.load(handle)
            except (OSError, json.JSONDecodeError):
                owner = {}
            if process_alive(owner.get("pid")):
                raise SystemExit(f"another Form 5500 foundation run owns {lock_path} (pid {owner.get('pid')})")
            try: os.unlink(lock_path)
            except FileNotFoundError: pass
    raise SystemExit(f"could not acquire foundation lock {lock_path}")

def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()

def ensure_archive(url, path, expected_sha=None, attempts=4):
    """Download once to an atomic cache file and verify the pinned archive."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if os.path.exists(path):
        if not zipfile.is_zipfile(path): raise RuntimeError(f"cached archive is invalid: {path}")
        digest = file_sha256(path)
        if expected_sha and digest != expected_sha:
            raise RuntimeError(f"cached archive changed for checkpointed dataset: {path}")
        return digest
    temporary = path + ".part"
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=300) as response, open(temporary, "wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk: break
                    handle.write(chunk)
                handle.flush(); os.fsync(handle.fileno())
            if not zipfile.is_zipfile(temporary): raise RuntimeError(f"download is not a ZIP archive: {url}")
            digest = file_sha256(temporary)
            if expected_sha and digest != expected_sha: raise RuntimeError(f"downloaded archive differs from checkpoint for {url}")
            os.replace(temporary, path)
            return digest
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as error:
            last = error
            try: os.unlink(temporary)
            except FileNotFoundError: pass
            status = getattr(error, "code", None)
            if status not in (None, 429, 500, 502, 503, 504) or attempt + 1 >= attempts: raise
            time.sleep(2 ** attempt)
    raise last

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

def rows_from_zip(path):
    with zipfile.ZipFile(path) as archive:
        csv_names = [name for name in archive.namelist() if name.lower().endswith((".csv", ".txt"))]
        if not csv_names: raise RuntimeError(f"no CSV in {path}")
        name = max(csv_names, key=lambda item: archive.getinfo(item).file_size)
        with archive.open(name) as raw:
            # TextIOWrapper closes with the archive member at the end of this scope.
            import io
            with io.TextIOWrapper(raw, encoding="latin-1", newline="") as text:
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
    default_state = os.path.join(os.path.dirname(__file__), "..", ".foundation-run", "form5500-foundation.json")
    parser.add_argument("--state-file", default=default_state)
    parser.add_argument("--cache-dir", default=None, help="archive cache (default: <state-dir>/form5500-cache)")
    parser.add_argument("--checkpoint-every", type=int, default=5000, help="maximum scanned rows between durable checkpoints")
    parser.add_argument("--reset", action="store_true", help="start a new checkpoint; cached immutable ZIPs are retained")
    args = parser.parse_args()
    if not args.secret: raise SystemExit("CRON_SECRET is required")
    if args.batch_size < 1 or args.batch_size > 250: raise SystemExit("--batch-size must be between 1 and 250")
    if args.checkpoint_every < args.batch_size: raise SystemExit("--checkpoint-every must be at least --batch-size")
    app = args.app.rstrip("/")
    state_path = os.path.abspath(args.state_file)
    cache_dir = os.path.abspath(args.cache_dir or os.path.join(os.path.dirname(state_path), "form5500-cache"))
    lock_path = acquire_lock(state_path)
    try:
        if args.reset:
            try: os.unlink(state_path)
            except FileNotFoundError: pass
        companies = load_tam(app, args.secret)
        signature = tam_signature(companies)
        requested_years = sorted(set(args.years))
        state = load_state(state_path)
        if state is None:
            state = {"version": STATE_VERSION, "app": app, "years": requested_years, "tamSignature": signature, "tamCount": len(companies), "datasets": {}, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            atomic_json(state_path, state)
        elif state.get("app") != app or state.get("years") != requested_years or state.get("tamSignature") != signature:
            raise SystemExit("checkpoint scope differs from the current app, years, or exact TAM; review it and use --reset to begin a new foundation sweep")

        index = defaultdict(list)
        for company in companies:
            key = norm(company["name"])
            if len(key) >= 4: index[key].append(company)

        for year in requested_years:
            for form_type, stem in (("5500", "F_5500"), ("5500-SF", "F_5500_SF")):
                key = f"{year}:{form_type}"
                url = f"https://askebsa.dol.gov/FOIA%20Files/{year}/Latest/{stem}_{year}_Latest.zip"
                dataset = state["datasets"].setdefault(key, {"year": year, "form": form_type, "sourceUrl": url, "status": "pending", "scanned": 0, "matched": 0, "stored": 0, "triggers": 0})
                if dataset.get("sourceUrl") != url: raise SystemExit(f"checkpoint URL mismatch for {key}")
                if dataset.get("status") == "complete":
                    print(json.dumps({"year": year, "form": form_type, "resumed": True, **{name: dataset.get(name, 0) for name in ("scanned", "matched", "stored", "triggers")}}))
                    continue
                archive_path = os.path.join(cache_dir, f"{stem}_{year}_Latest.zip")
                digest = ensure_archive(url, archive_path, dataset.get("archiveSha256"))
                dataset.update({"archivePath": archive_path, "archiveSha256": digest, "status": "in_progress"})
                atomic_json(state_path, state)

                committed = int(dataset.get("scanned", 0))
                batch, pending_matched, current = [], 0, committed

                def commit():
                    nonlocal batch, pending_matched
                    receipt = {"stored": 0, "triggers": 0}
                    if batch:
                        receipt = request_json(f"{app}/api/cron/public-growth/form5500", args.secret, {"observations": batch})
                    dataset["scanned"] = current
                    dataset["matched"] = int(dataset.get("matched", 0)) + pending_matched
                    dataset["stored"] = int(dataset.get("stored", 0)) + int(receipt.get("stored", 0))
                    dataset["triggers"] = int(dataset.get("triggers", 0)) + int(receipt.get("triggers", 0))
                    dataset["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    atomic_json(state_path, state)
                    batch, pending_matched = [], 0

                for row_number, row in enumerate(rows_from_zip(archive_path), start=1):
                    if row_number <= committed: continue
                    current = row_number
                    hit = match_company(row, index)
                    if hit:
                        pending_matched += 1
                        batch.append(observation(row, *hit, year, form_type, url))
                    if len(batch) >= args.batch_size or current - int(dataset.get("scanned", 0)) >= args.checkpoint_every:
                        commit()
                if current > int(dataset.get("scanned", 0)) or batch: commit()
                dataset["status"] = "complete"
                dataset["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                atomic_json(state_path, state)
                print(json.dumps({"year": year, "form": form_type, **{name: dataset.get(name, 0) for name in ("scanned", "matched", "stored", "triggers")}}))

        totals = {name: sum(int(dataset.get(name, 0)) for dataset in state["datasets"].values()) for name in ("scanned", "matched", "stored", "triggers")}
        state["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_json(state_path, state)
        print(json.dumps({"done": True, "tam": len(companies), **totals, "checkpoint": state_path}))
    finally:
        try: os.unlink(lock_path)
        except FileNotFoundError: pass

if __name__ == "__main__": main()
