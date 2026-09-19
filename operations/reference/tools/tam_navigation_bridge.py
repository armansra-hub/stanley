"""Local-only preparation at the canonical runner's verified-evidence boundary.

No corpus discovery, credentials, network, claims, grades or PDF extraction.
The caller supplies the complete package it has already verified and claimed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
from uuid import uuid4

try:
    from . import tam_evidence_index as indexer
    from . import tam_jev_annotations as annotations
except ImportError:
    import tam_evidence_index as indexer
    import tam_jev_annotations as annotations

VERSION = "canonical-navigation-v1"


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid4().hex[:8] + ".tmp")
    try:
        temporary.write_bytes(indexer.encoded(value))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def envelope(internal_id, package):
    indexer.exact_id(internal_id)
    indexer.need(str(package["capture"]["internal_id"]) == internal_id, "package identity mismatch")
    indexer.need(indexer.digest(package["record_text"].encode("utf-8")) == package["record_text_sha256"], "record changed")
    pages = package["pdf_page_texts"]
    indexer.need(len(pages) == package["pdf_pages"] and len(pages) > 0, "incomplete pages")
    documents = [{"id": "record_text", "kind": "record_text", "text": package["record_text"]}]
    documents.extend({"id": f"pdf_{number}", "kind": "pdf_page", "page": number, "text": page}
                     for number, page in enumerate(pages, 1))
    for key in ("supplemental_company_context", "identity_review"):
        if package.get(key) is not None:
            documents.append({"id": key, "kind": "supplemental", "text": json.dumps(package[key], ensure_ascii=True, sort_keys=True)})
    return indexer.encoded({"schema": "tam-evidence-input", "version": 1, "internal_id": internal_id,
                            "expected_pdf_pages": len(pages), "documents": documents})


def navigation(index):
    # Locations only: never introduce a summary, label a candidate as a fact, or
    # propagate a date to adjacent text. Full evidence remains in both prompts.
    categories = {}
    for item in index["candidates"]:
        span = item["span"]
        categories.setdefault(item["category"], []).append({key: span[key] for key in ("document_id", "page", "line", "start", "end")})
    ordered_dates = sorted(index["date_mentions"], key=lambda item: (item["normalized_date"] or "", item["id"]), reverse=True)
    return {"version": VERSION, "index_key": index["cache_key"], "navigation_only": True,
            "total_candidates": len(index["candidates"]), "total_date_mentions": len(ordered_dates),
            "category_locations": {key: value[:12] for key, value in sorted(categories.items())},
            "date_locations": [{key: item[key] for key in ("raw", "normalized_date", "status", "span")} for item in ordered_dates[:24]],
            "bounded_pointer_list": True,
            "instructions": "Pointers are lexical navigation aids, not confirmed interactions or facts. A date is only a source mention. Read all original text and every PDF page independently; unlisted evidence is equally authoritative."}


def excerpt_requests(index, index_raw):
    """Prepare contextual packets locally; dispatch remains an explicit command."""
    wanted = set()
    by_ref = {}
    for document in index["documents"]:
        for line in document["lines"]:
            by_ref[(document["id"], line["line"])] = line
    for item in index["candidates"]:
        span = item["span"]
        for number in range(max(1, span["line"] - 1), span["line"] + 2):
            if (span["document_id"], number) in by_ref:
                wanted.add((span["document_id"], number))
    packets, refs, byte_count = [], [], 0
    for key in by_ref:  # preserve document and line order, including neighbors
        if key not in wanted:
            continue
        reference = f"{key[0]}:{key[1]}"
        size = len((f"[{reference}] {by_ref[key]['text']}\n").encode("utf-8"))
        if size > 12000:
            continue  # full line remains in the local index and full prompts
        if refs and (len(refs) == 40 or byte_count + size > 12000):
            packets.append(refs)
            refs, byte_count = [], 0
        refs.append(reference)
        byte_count += size
    if refs:
        packets.append(refs)
    return [annotations.prepare(index_raw, indexer.digest(index_raw), index["binding"]["internal_id"], refs) for refs in packets]


def prepare_package(internal_id, package, *, evidence, root):
    started = time.perf_counter()
    raw = envelope(internal_id, package)
    context = {"evidence": evidence, "bridge": VERSION, "rules": indexer.RULES_SHA256,
               "question_version": annotations.QUESTION_VERSION, "criteria": annotations.CRITERIA}
    context_hash = indexer.digest(indexer.encoded(context))
    source_hash = indexer.digest(raw)
    key = indexer.digest(indexer.encoded({"context": context_hash, "source": source_hash}))
    folder = Path(root) / internal_id / key[:24]
    receipt_path, index_path = folder / "receipt.json", folder / "index.json"
    reused = False
    if receipt_path.is_file() and index_path.is_file():
        receipt = json.loads(receipt_path.read_bytes())
        index_raw = index_path.read_bytes()
        if (receipt.get("key") == key and receipt.get("index_sha256") == indexer.digest(index_raw)
                and receipt.get("source_sha256") == source_hash and receipt.get("context_sha256") == context_hash):
            index = json.loads(index_raw)
            reused = index.get("binding", {}).get("context_sha256") == context_hash
    if not reused:
        index = indexer.build_index(raw, internal_id=internal_id, source_sha256=source_hash,
                                    source_format="artifact", context_sha256=context_hash)
        index_raw = indexer.encoded(index)
        atomic_json(index_path, index)
        requests = excerpt_requests(index, index_raw)
        request_hashes = []
        for number, request in enumerate(requests, 1):
            atomic_json(folder / f"jev-request-{number:04}.json", request)
            request_hashes.append(indexer.digest(indexer.encoded(request)))
        receipt = {"schema": "tam-canonical-navigation-cache", "version": 1,
                                   "key": key, "index_sha256": indexer.digest(index_raw),
                                   "source_sha256": source_hash, "context_sha256": context_hash,
                                   "request_sha256": request_hashes}
        atomic_json(receipt_path, receipt)
    view = navigation(index)
    cached_annotations = []
    # Only already completed, hash-bound local results enter the prompts. This
    # path never dispatches Jev or retries a pending/uncertain request.
    for number, request_hash in enumerate(receipt.get("request_sha256", []), 1):
        result_path = folder / f"jev-result-{number:04}.json"
        outcome_path = result_path.with_name(result_path.name + ".request.json")
        if not result_path.is_file() or not outcome_path.is_file():
            continue
        request_raw = (folder / f"jev-request-{number:04}.json").read_bytes()
        if indexer.digest(request_raw) != request_hash:
            continue
        request = json.loads(request_raw)
        result_raw = result_path.read_bytes()
        outcome = json.loads(outcome_path.read_bytes())
        if outcome.get("status") != "complete" or outcome.get("output_sha256") != indexer.digest(result_raw):
            continue
        value = json.loads(result_raw)
        if (value.get("schema") != "tam-jev-excerpt-annotations" or value.get("binding") != request["binding"]
                or value.get("cache_key") != request["cache_key"] or value.get("spans") != request["spans"]):
            continue
        cached_annotations.append({"references": request["binding"]["references"],
                                   "annotations": value["annotations"], "model": request["binding"]["model"],
                                   "question_version": request["binding"]["question_version"],
                                   "result_sha256": indexer.digest(result_raw)})
    view["jev_annotation_count"] = len(cached_annotations)
    view["jev_annotations"] = cached_annotations[:16]
    package["evidence_navigation"] = view
    return {"version": VERSION, "path": str(index_path), "index_sha256": indexer.digest(index_raw),
            "navigation_sha256": indexer.digest(indexer.encoded(view)), "reused": reused,
            "duration_ms": (time.perf_counter() - started) * 1000,
            "document_count": len(index["documents"]), "candidate_count": len(index["candidates"]),
            "date_mention_count": len(index["date_mentions"]), "private_requests_sent": 0,
            "jev_request_count": len(receipt.get("request_sha256", [])), "jev_annotation_count": len(cached_annotations)}


class StageTimings:
    """Compact local timing receipts; telemetry failure never changes grading."""
    def __init__(self, root, internal_id):
        self.internal_id = internal_id
        self.attempt = uuid4().hex
        self.path = Path(root) / internal_id / f"{self.attempt}.json"
        self.rows = []
        self.active = None

    def start(self, stage):
        self.active = (stage, time.perf_counter())

    def finish(self, outcome="completed", reused=False):
        if self.active is None:
            return
        stage, started = self.active
        self.active = None
        self.rows.append({"receipt_id": f"{self.attempt}-{len(self.rows)}", "internal_id": self.internal_id,
                          "attempt_id": self.attempt, "stage": stage, "outcome": outcome,
                          "reused": bool(reused), "duration_ms": (time.perf_counter() - started) * 1000})
        try:
            atomic_json(self.path, {"schema": "tam-stage-timings", "version": 1, "receipts": self.rows})
        except OSError:
            pass

    def call(self, stage, function, *args, **kwargs):
        self.start(stage)
        try:
            result = function(*args, **kwargs)
        except Exception:
            self.finish("failed")
            raise
        held = (stage == "validator" and isinstance(result, tuple) and isinstance(result[0], dict)
                and result[0].get("validation_status") == "hold")
        self.finish("held" if held else "completed", reused=isinstance(result, tuple) and len(result) == 3 and result[2] is True)
        return result
