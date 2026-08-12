#!/usr/bin/env python3
"""Verify the 2026 Inc. 5000 against the exact current NetSuite TAM and publish matches."""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser

STATE_VERSION = 1
LEGAL_SUFFIX = re.compile(r"\b(the|and|co|company|corp|corporation|inc|incorporated|llc|ltd|limited|lp|llp|pllc|pc|group|holdings?)\b")
EXCLUDED_DOMAINS = ("inc.com", "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "tiktok.com")
STATE_NAMES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
}


def env_file(name: str) -> str | None:
    path = os.path.join(os.path.dirname(__file__), "..", ".env.production.local")
    try:
        for line in open(path, encoding="utf-8"):
            if line.startswith(name + "="): return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError: pass
    return None


def request_json(url: str, secret: str, body=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request(url, data=data, headers={"x-cron-secret": secret, "content-type": "application/json", "user-agent": "Stanley-Inc5000-Foundation/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=240) as response: return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{error.code} {error.read().decode('utf-8', 'replace')[:1000]}") from error


def load_tam(app: str, secret: str):
    rows, offset = [], 0
    while True:
        page = request_json(f"{app}/api/cron/public-growth/inc5000?offset={offset}&limit=1000", secret)
        rows.extend(page.get("companies", []))
        if page.get("done"): return rows
        offset = int(page["nextOffset"])


def norm_name(value: str | None) -> str:
    value = (value or "").lower().replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", LEGAL_SUFFIX.sub(" ", value)).strip()


def norm_domain(value: str | None) -> str | None:
    value = (value or "").strip().lower()
    if not value: return None
    parsed = urllib.parse.urlparse(value if "://" in value else "https://" + value)
    return (parsed.hostname or value.split("/", 1)[0]).removeprefix("www.").rstrip(".") or None


class ProfileParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.links = []; self.text = []
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href: self.links.append(href)
    def handle_data(self, data):
        if data.strip(): self.text.append(data.strip())


def parse_profile(page: str):
    parser = ProfileParser(); parser.feed(page)
    text = re.sub(r"\s+", " ", html.unescape(" ".join(parser.text)))
    website = None
    for link in parser.links:
        domain = norm_domain(link)
        if not domain or any(domain == blocked or domain.endswith("." + blocked) for blocked in EXCLUDED_DOMAINS): continue
        if link.startswith(("http://", "https://")): website = link; break
    rank_match = re.search(r"\bNo\.\s*([0-9,]{1,6})\b", text, re.I)
    growth_match = re.search(r"([0-9][0-9,]*(?:\.[0-9]+)?)%\s*(?:3[- ]Year|three[- ]year)\s+Growth", text, re.I)
    state = city = None
    for full, abbreviation in STATE_NAMES.items():
        match = re.search(rf"\b([A-Za-z .'-]{{2,50}}),\s*{re.escape(full)}\b", text, re.I)
        if match:
            city, state = match.group(1).strip().split(" ")[-1], abbreviation
            break
    return {
        "website": website,
        "domain": norm_domain(website),
        "city": city,
        "state": state,
        "rank": int(rank_match.group(1).replace(",", "")) if rank_match else None,
        "growthPct": float(growth_match.group(1).replace(",", "")) if growth_match else None,
    }


def fetch_profile(url: str):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0 (compatible; StanleyGrowthResearch/1.0)"})
            with urllib.request.urlopen(req, timeout=45) as response:
                return {"ok": True, **parse_profile(response.read().decode("utf-8", "replace"))}
        except urllib.error.HTTPError as error:
            if error.code in (403, 404): return {"ok": False, "error": f"HTTPError: HTTP Error {error.code}"}
            if attempt == 3: return {"ok": False, "error": f"HTTPError: {str(error)[:160]}"}
            time.sleep(2 ** attempt)
        except Exception as error:
            if attempt == 3: return {"ok": False, "error": f"{type(error).__name__}: {str(error)[:160]}"}
            time.sleep(2 ** attempt)


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--app", default=os.getenv("APP_BASE_URL") or env_file("APP_BASE_URL") or "https://jarvis-sable-eta.vercel.app")
    parser.add_argument("--secret", default=os.getenv("TAM_GROWTH_SWEEP_SECRET") or env_file("TAM_GROWTH_SWEEP_SECRET") or os.getenv("CRON_SECRET") or env_file("CRON_SECRET"))
    parser.add_argument("--state-dir", default=os.path.join(root, ".foundation-run", "inc5000-2026"))
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.secret: raise SystemExit("CRON_SECRET is required")
    os.makedirs(args.state_dir, exist_ok=True)
    lock_path = os.path.join(args.state_dir, "run.lock")
    try:
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY); os.write(lock, str(os.getpid()).encode()); os.close(lock)
    except FileExistsError: raise SystemExit(f"another Inc. 5000 run owns {lock_path}")
    try:
        app = args.app.rstrip("/")
        tam = load_tam(app, args.secret)
        with open(args.csv, newline="", encoding="utf-8-sig") as handle:
            inc_rows = [{"company_name": row["company_name"].strip(), "inc_profile_url": row["inc_profile_url"].strip()} for row in csv.DictReader(handle)]
        by_domain, by_name = {}, {}
        for company in tam:
            domain = norm_domain(company.get("domain") or company.get("website_raw")); name = norm_name(company.get("name"))
            if domain: by_domain.setdefault(domain, []).append(company)
            if name: by_name.setdefault(name, []).append(company)
        candidate_rows = []
        for row in inc_rows:
            slug = urllib.parse.urlparse(row["inc_profile_url"]).path.rstrip("/").rsplit("/", 1)[-1].replace("-", " ")
            if by_name.get(norm_name(row["company_name"])) or by_name.get(norm_name(slug)): candidate_rows.append(row)

        cache_path = os.path.join(args.state_dir, "profiles.sqlite")
        db = sqlite3.connect(cache_path); db.execute("create table if not exists profiles(url text primary key, payload text not null, fetched_at text not null)")
        cached = {url: json.loads(payload) for url, payload in db.execute("select url,payload from profiles")}
        pending = [row["inc_profile_url"] for row in candidate_rows if row["inc_profile_url"] not in cached]
        write_lock = threading.Lock()
        with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 12))) as pool:
            futures = {pool.submit(fetch_profile, url): url for url in pending}
            for index, future in enumerate(as_completed(futures), 1):
                url, payload = futures[future], future.result(); cached[url] = payload
                with write_lock:
                    db.execute("insert or replace into profiles values(?,?,?)", (url, json.dumps(payload, separators=(",", ":")), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
                    if index % 25 == 0: db.commit()
                if index % 100 == 0: print(json.dumps({"phase": "profiles", "completed": index, "pending": len(pending)}), flush=True)
        db.commit(); db.close()

        proposals, ambiguous = [], 0
        for row in candidate_rows:
            profile = cached.get(row["inc_profile_url"], {})
            candidates = []
            if profile.get("domain"): candidates.extend(by_domain.get(profile["domain"], []))
            candidates.extend(by_name.get(norm_name(row["company_name"]), []))
            slug = urllib.parse.urlparse(row["inc_profile_url"]).path.rstrip("/").rsplit("/", 1)[-1].replace("-", " ")
            candidates.extend(by_name.get(norm_name(slug), []))
            unique = {str(company["id"]): company for company in candidates}
            if len(unique) != 1:
                if len(unique) > 1: ambiguous += 1
                continue
            company = next(iter(unique.values()))
            proposals.append({
                "companyId": str(company["id"]), "companyName": company["name"], "incName": row["company_name"],
                "profileUrl": row["inc_profile_url"], "incWebsite": profile.get("website"), "incCity": profile.get("city"),
                "incState": profile.get("state"), "rank": profile.get("rank"), "growthPct": profile.get("growthPct"),
            })
        state = {"version": STATE_VERSION, "csv": os.path.abspath(args.csv), "csvSha256": sha256(args.csv), "tamCount": len(tam),
                 "incCount": len(inc_rows), "candidateProfiles": len(candidate_rows), "profilesFetched": len(cached), "profileFailures": sum(not p.get("ok") for p in cached.values()),
                 "proposals": len(proposals), "ambiguous": ambiguous, "inserted": 0, "duplicates": 0, "rejected": 0,
                 "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        matches_path = os.path.join(args.state_dir, "proposed-matches.jsonl")
        with open(matches_path + ".tmp", "w", encoding="utf-8") as handle:
            for proposal in proposals: handle.write(json.dumps(proposal, sort_keys=True, separators=(",", ":")) + "\n")
        os.replace(matches_path + ".tmp", matches_path)
        if not args.dry_run:
            for offset in range(0, len(proposals), 100):
                receipt = request_json(f"{app}/api/cron/public-growth/inc5000", args.secret, {"matches": proposals[offset:offset + 100]})
                for key in ("inserted", "duplicates", "rejected"): state[key] += int(receipt.get(key, 0))
                print(json.dumps({"phase": "publish", "offset": offset + len(proposals[offset:offset + 100]), **{key: state[key] for key in ("inserted", "duplicates", "rejected")}}), flush=True)
        state["status"] = "dry_run" if args.dry_run else "complete"; state["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        receipt_path = os.path.join(args.state_dir, "receipt.json")
        with open(receipt_path + ".tmp", "w", encoding="utf-8") as handle: json.dump(state, handle, indent=2, sort_keys=True)
        os.replace(receipt_path + ".tmp", receipt_path)
        print(json.dumps({"done": True, **state}), flush=True)
    finally:
        try: os.unlink(lock_path)
        except FileNotFoundError: pass


if __name__ == "__main__": main()
