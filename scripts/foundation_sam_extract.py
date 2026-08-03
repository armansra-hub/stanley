#!/usr/bin/env python3
"""Match the official SAM public monthly extract to the exact current NetSuite TAM.

The large source file is scanned once into a compact, deterministic candidate
ledger. Publishing that ledger is independently checkpointed and idempotent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict

STATE_VERSION = 1
SUFFIX = re.compile(r"\b(the|and|co|company|corp|corporation|inc|incorporated|llc|ltd|limited|lp|llp|pllc|pc|group|holdings?)\b")


def env_file(name: str) -> str | None:
    path = os.path.join(os.path.dirname(__file__), "..", ".env.production.local")
    try:
        for line in open(path, encoding="utf-8"):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return None


def request_json(url: str, secret: str, body=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request(url, data=data, headers={"x-cron-secret": secret, "content-type": "application/json", "user-agent": "Stanley-SAM-Foundation/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=240) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{error.code} {error.read().decode('utf-8', 'replace')[:1000]}") from error


def load_pages(app: str, secret: str, kind: str, key: str):
    rows, offset = [], 0
    while True:
        page = request_json(f"{app}/api/cron/public-growth/sam-extract?kind={kind}&offset={offset}&limit=1000", secret)
        rows.extend(page.get(key, []))
        if page.get("done"): return rows
        offset = int(page["nextOffset"])


def norm_name(value: str | None) -> str:
    value = (value or "").lower().replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", SUFFIX.sub(" ", value)).strip()


def norm_domain(value: str | None) -> str | None:
    value = (value or "").strip().lower()
    if not value: return None
    parsed = urllib.parse.urlparse(value if "://" in value else "https://" + value)
    host = (parsed.hostname or value.split("/", 1)[0]).removeprefix("www.").rstrip(".")
    return host or None


def date8(value: str) -> str | None:
    return f"{value[:4]}-{value[4:6]}-{value[6:8]}" if len(value) == 8 and value.isdigit() and value != "00000000" else None


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: str, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.flush(); os.fsync(handle.fileno())
    os.replace(temp, path)


def tam_signature(companies) -> str:
    payload = "\n".join(f"{row['id']}|{row.get('netsuite_internal_id','')}" for row in sorted(companies, key=lambda row: row["id"]))
    return hashlib.sha256(payload.encode()).hexdigest()


def compact_entity(parts):
    primary = parts[32].strip()
    exceptions = {}
    for item in parts[113].split("~"):
        item = item.strip("~")
        if len(item) >= 7: exceptions[item[:6]] = item[6:10].ljust(4)
    naics = []
    for item in parts[34].split("~"):
        item = item.strip()
        if len(item) < 6: continue
        code, indicator = item[:6], item[6:7].upper()
        if indicator == "E":
            flags = exceptions.get(code, "")
            emitted = False
            for index, flag in enumerate(flags):
                if flag.upper() in ("Y", "N"):
                    naics.append({"code": code, "name": None, "isPrimary": code == primary, "isSmallBusiness": flag.upper(), "hasSizeChanged": False, "hasSbaProtest": False, "exceptionCounter": str(index + 1)})
                    emitted = True
            if not emitted:
                naics.append({"code": code, "name": None, "isPrimary": code == primary, "isSmallBusiness": "E", "hasSizeChanged": False, "hasSbaProtest": False, "exceptionCounter": "E"})
        else:
            naics.append({"code": code, "name": None, "isPrimary": code == primary, "isSmallBusiness": indicator, "hasSizeChanged": False, "hasSbaProtest": False, "exceptionCounter": ""})
    website = parts[26].strip() or None
    return {
        "uei": parts[0].strip() or None, "cageCode": parts[3].strip() or None,
        "legalName": parts[11].strip(), "dbaName": parts[12].strip() or None,
        "registrationStatus": {"A": "Active", "E": "Expired"}.get(parts[5].strip(), parts[5].strip() or None),
        "registrationDate": date8(parts[7]), "expirationDate": date8(parts[8]),
        "lastUpdateDate": date8(parts[9]), "entityStartDate": date8(parts[24]),
        "website": website, "domain": norm_domain(website), "address": parts[15].strip() or None,
        "city": parts[17].strip() or None, "state": parts[18].strip() or None,
        "postalCode": parts[19].strip() or None, "countryCode": parts[21].strip() or None,
        "parentUei": None, "parentName": None, "naics": naics,
        "psc": [item for item in parts[36].split("~") if item],
        "businessTypes": [item for item in (parts[31] + "~" + parts[117]).split("~") if item],
    }


def build_candidates(archive: str, companies, links, output: str):
    by_name, by_domain, by_uei, by_cage = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    company_by_id = {row["id"]: row for row in companies}
    for company in companies:
        name = norm_name(company.get("name"))
        domain = norm_domain(company.get("domain") or company.get("website_raw"))
        if len(name) >= 4: by_name[name].append(company["id"])
        if domain: by_domain[domain].append(company["id"])
    for link in links:
        entity = link.get("government_entities") or {}
        if entity.get("uei"): by_uei[str(entity["uei"]).upper()].append(link["company_id"])
        if entity.get("cage_code"): by_cage[str(entity["cage_code"]).upper()].append(link["company_id"])

    scanned, matched, seen = 0, 0, set()
    temp = output + ".tmp"
    with zipfile.ZipFile(archive) as source, source.open(source.namelist()[0]) as raw, open(temp, "w", encoding="utf-8") as target:
        raw.readline()
        for binary in raw:
            line = binary.decode("utf-8-sig", "replace").rstrip("\r\n")
            if not line or line.startswith("EOF PUBLIC"): continue
            parts = line.split("|")
            if len(parts) < 142 or parts[141] != "!end": continue
            scanned += 1
            sam = compact_entity(parts)
            candidate_ids, method = [], None
            if sam["uei"] and by_uei.get(sam["uei"].upper()): candidate_ids, method = by_uei[sam["uei"].upper()], "uei"
            elif sam["cageCode"] and by_cage.get(sam["cageCode"].upper()): candidate_ids, method = by_cage[sam["cageCode"].upper()], "cage"
            elif sam["domain"] and by_domain.get(sam["domain"]): candidate_ids, method = by_domain[sam["domain"]], "domain"
            else:
                ids = set(by_name.get(norm_name(sam["legalName"]), [])) | set(by_name.get(norm_name(sam["dbaName"]), []))
                candidate_ids, method = sorted(ids), "name"
            for company_id in candidate_ids:
                company = company_by_id.get(company_id)
                if not company: continue
                key = (company_id, sam["uei"] or sam["cageCode"] or sam["legalName"])
                if key in seen: continue
                seen.add(key)
                target.write(json.dumps({"companyId": company_id, "matchMethod": method, "sam": sam}, separators=(",", ":")) + "\n")
                matched += 1
        target.flush(); os.fsync(target.fileno())
    os.replace(temp, output)
    return scanned, matched


def main():
    parser = argparse.ArgumentParser()
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    parser.add_argument("--app", default=os.getenv("APP_BASE_URL") or env_file("APP_BASE_URL") or "https://jarvis-sable-eta.vercel.app")
    parser.add_argument("--secret", default=os.getenv("CRON_SECRET") or env_file("CRON_SECRET"))
    parser.add_argument("--archive", default=os.path.join(root, ".foundation-run", "sam-cache", "SAM_PUBLIC_UTF-8_MONTHLY_V2_20260802.zip"))
    parser.add_argument("--state-file", default=os.path.join(root, ".foundation-run", "sam-extract-foundation.json"))
    parser.add_argument("--batch-size", type=int, default=10)
    args = parser.parse_args()
    if not args.secret: raise SystemExit("CRON_SECRET is required")
    app, archive, state_path = args.app.rstrip("/"), os.path.abspath(args.archive), os.path.abspath(args.state_file)
    candidates = os.path.splitext(state_path)[0] + "-candidates.jsonl"
    lock = state_path + ".lock"
    try:
        handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY); os.write(handle, str(os.getpid()).encode()); os.close(handle)
    except FileExistsError: raise SystemExit(f"another SAM foundation run owns {lock}")
    try:
        companies = load_pages(app, args.secret, "companies", "companies")
        links = load_pages(app, args.secret, "links", "links")
        fingerprint, signature = sha256(archive), tam_signature(companies)
        try: state = json.load(open(state_path, encoding="utf-8"))
        except FileNotFoundError: state = {"version": STATE_VERSION, "app": app, "archive": archive, "archiveSha256": fingerprint, "tamSignature": signature, "tamCount": len(companies), "status": "pending", "ingestOffset": 0, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        if state.get("archiveSha256") != fingerprint or state.get("tamSignature") != signature or state.get("app") != app:
            raise SystemExit("checkpoint scope differs from the current extract or exact TAM")
        if not os.path.exists(candidates) or state.get("status") == "pending":
            scanned, count = build_candidates(archive, companies, links, candidates)
            state.update({"status": "ingesting", "scanned": scanned, "candidateCount": count, "ingestOffset": 0, "matched": 0, "ambiguous": 0, "entities": 0, "naics": 0, "triggers": 0, "errors": 0})
            atomic_json(state_path, state)
            print(json.dumps({"phase": "matched", "tam": len(companies), "scanned": scanned, "candidates": count}), flush=True)
        offset = int(state.get("ingestOffset", 0)); batch = []
        with open(candidates, encoding="utf-8") as handle:
            for index, line in enumerate(handle):
                if index < offset: continue
                batch.append(json.loads(line))
                if len(batch) < args.batch_size: continue
                receipt = request_json(f"{app}/api/cron/public-growth/sam-extract", args.secret, {"observations": batch})
                if int(receipt.get("errors", 0)):
                    state["errors"] = int(state.get("errors", 0)) + int(receipt["errors"]); atomic_json(state_path, state)
                    raise RuntimeError(f"SAM ingest batch {offset} returned errors: {receipt.get('receipts')}")
                offset += len(batch)
                for key in ("matched", "ambiguous", "entities", "naics", "triggers"): state[key] = int(state.get(key, 0)) + int(receipt.get(key, 0))
                state["ingestOffset"] = offset; state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); atomic_json(state_path, state)
                print(json.dumps({"phase": "ingest", "offset": offset, **{key: state.get(key, 0) for key in ("candidateCount", "matched", "ambiguous", "entities", "naics", "triggers")}}), flush=True)
                batch = []
            if batch:
                receipt = request_json(f"{app}/api/cron/public-growth/sam-extract", args.secret, {"observations": batch})
                if int(receipt.get("errors", 0)): raise RuntimeError(f"SAM final ingest returned errors: {receipt.get('receipts')}")
                offset += len(batch)
                for key in ("matched", "ambiguous", "entities", "naics", "triggers"): state[key] = int(state.get(key, 0)) + int(receipt.get(key, 0))
                state["ingestOffset"] = offset
        state.update({"status": "complete", "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}); atomic_json(state_path, state)
        print(json.dumps({"done": True, **state}), flush=True)
    finally:
        try: os.unlink(lock)
        except FileNotFoundError: pass


if __name__ == "__main__": main()
