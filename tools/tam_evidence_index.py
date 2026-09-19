#!/usr/bin/env python3
"""Explicit-file, local-only TAM navigation indexes and compact stage timing reports.

This module deliberately imports no canonical coordinator, grader, model client,
credentials, or HTTP library. It cannot claim, grade, validate, or publish a lead.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
import time
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

VERSION = 1
MODEL = "none-deterministic"
RULES_VERSION = "lexical-navigation-v2"
MAX_SOURCE_BYTES = 32 * 1024 * 1024
STAGES = ("preparation", "reader", "validator", "staging", "publication")
PATTERNS = {
    "interaction": r"\b(?:call(?:ed|ing)?|spoke|said|replied|reply|email(?:ed)?|meeting|voicemail|conversation|qualification|intro call)\b",
    "system": r"\b(?:NetSuite|QuickBooks|Sage|Intacct|Dynamics|SAP|Oracle|Xero|Acumatica|Epicor|ERP|CRM|accounting system|current software|spreadsheet|Excel)\b",
    "budget": r"\b(?:budget|afford(?:able|ability)?|pricing|price|cost|dollars?|USD|per month|monthly|annually)\b|\$\s*\d[\d,.]*(?:\s*[kKmM]\b)?",
    "timing": r"\b(?:timing|evaluat(?:e|ing|ion)|renew(?:al|ing)?|contract expires|next (?:week|month|quarter|year)|this (?:week|month|quarter|year)|Q[1-4]\s+\d{4})\b",
    "speaker_label": r"\b(?:author|speaker|contact|from|owner)\s*:\s*[^\r\n\f]+",
}
MONTH = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
DATE_PATTERN = re.compile(
    rf"\b(?:\d{{4}}-\d{{2}}-\d{{2}}|\d{{1,2}}/\d{{1,2}}/\d{{4}}|{MONTH}\s+\d{{1,2}},?\s+\d{{4}}|\d{{1,2}}\s+{MONTH}\s+\d{{4}})\b", re.I)
AMOUNT_PATTERN = re.compile(r"(?P<currency>USD\s*\$?|US\$|\$)\s*(?P<value>\d[\d,]*(?:\.\d+)?)(?:\s*(?P<multiplier>thousand|million|[kKmM])\b)?", re.I)
PERIOD_PATTERN = re.compile(r"^\s*(?:/\s*|per\s+)?(?P<period>months?|mo\b|monthly|years?|yr\b|annually|annual)\b", re.I)


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


RULES_SHA256 = digest(encoded({"version": RULES_VERSION, "patterns": PATTERNS, "dates": DATE_PATTERN.pattern,
                              "amounts": AMOUNT_PATTERN.pattern, "periods": PERIOD_PATTERN.pattern}))


def need(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def exact_id(value: Any) -> str:
    need(isinstance(value, str) and re.fullmatch(r"[1-9]\d{0,19}", value) is not None, "internal_id must be one exact positive decimal NetSuite ID")
    return value


def hash_value(value: Any, label: str) -> str:
    need(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None, f"{label} must be a lowercase SHA-256")
    return value


def fields(value: Any, allowed: set[str], required: set[str], label: str) -> dict[str, Any]:
    need(isinstance(value, dict) and required <= set(value) <= allowed, f"invalid {label} fields")
    return value


def source_documents(raw: bytes, internal_id: str, source_format: str) -> list[dict[str, Any]]:
    need(0 < len(raw) <= MAX_SOURCE_BYTES, "source must contain 1..33554432 bytes")
    text = raw.decode("utf-8", errors="strict")  # No newline normalization or replacement characters.
    if source_format == "text":
        return [{"id": "record_text", "kind": "record_text", "page": None, "text": text}]
    need(source_format == "artifact", "source format must be text or artifact")
    value = fields(json.loads(text), {"schema", "version", "internal_id", "documents", "expected_pdf_pages"},
                   {"schema", "version", "internal_id", "documents"}, "source artifact")
    need(value["schema"] == "tam-evidence-input" and value["version"] == VERSION, "unsupported source artifact schema")
    need(exact_id(value["internal_id"]) == internal_id, "artifact exact ID differs from caller")
    documents = value["documents"]
    need(isinstance(documents, list) and 1 <= len(documents) <= 10000, "artifact must have 1..10000 explicit documents")
    result, ids, pages = [], set(), []
    for document in documents:
        row = fields(document, {"id", "kind", "page", "text"}, {"id", "kind", "text"}, "source document")
        need(isinstance(row["id"], str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", row["id"]) is not None and row["id"] not in ids, "invalid or duplicate document ID")
        need(row["kind"] in ("record_text", "pdf_page", "supplemental"), "unsupported source document kind")
        need(isinstance(row["text"], str), "document text must be a string")
        page = row.get("page")
        if row["kind"] == "pdf_page":
            need(type(page) is int and page > 0, "PDF document needs its explicit original page number")
            pages.append(page)
        else:
            need(page is None, "only an explicit PDF page may have a page number")
        ids.add(row["id"])
        result.append({"id": row["id"], "kind": row["kind"], "page": page, "text": row["text"]})
    if pages:
        need(pages == list(range(1, len(pages) + 1)), "PDF pages must be complete, unique, and ordered from 1")
        need(type(value.get("expected_pdf_pages")) is int and value["expected_pdf_pages"] == len(pages), "explicit expected PDF page count required and must match")
    else:
        need(value.get("expected_pdf_pages", 0) == 0, "artifact declares PDF pages but supplies none")
    return result


def normalized_date(raw: str, date_order: str) -> tuple[str | None, str]:
    formats = ["%Y-%m-%d", "%b %d %Y", "%B %d %Y", "%d %b %Y", "%d %B %Y"]
    if "/" in raw:
        if date_order == "unspecified":
            return None, "numeric_order_unspecified"
        formats = ["%m/%d/%Y" if date_order == "mdy" else "%d/%m/%Y"]
    for pattern in formats:
        try:
            return datetime.strptime(raw.replace(",", ""), pattern).date().isoformat(), "calendar_date_only"
        except ValueError:
            pass
    return None, "invalid_calendar_date"


def amount_mentions(line, span):
    values = []
    for match in AMOUNT_PATTERN.finditer(line):
        value = Decimal(match["value"].replace(",", ""))
        multiplier = (match["multiplier"] or "").lower()
        value *= 1000000 if multiplier in ("m", "million") else 1000 if multiplier in ("k", "thousand") else 1
        period_match = PERIOD_PATTERN.match(line[match.end():])
        token = period_match["period"].lower() if period_match else ""
        period = "month" if token.startswith("mo") else "year" if token else None
        end = match.end() + (period_match.end() if period_match else 0)
        # A naked dollar sign does not establish USD. No period means no
        # monthly conversion, even if an amount resembles typical pricing.
        currency = "USD" if match["currency"].upper().startswith("US") else "$-unspecified"
        monthly = value if period == "month" else value / 12 if period == "year" else None
        values.append({"raw": line[match.start():end], "amount": str(value), "currency": currency,
                       "period": period, "monthly_equivalent": str(monthly) if monthly is not None else None,
                       "span": {**span, "start": span["start"] + match.start(), "end": span["start"] + end,
                                "utf8_start": span["utf8_start"] + len(line[:match.start()].encode("utf-8")),
                                "utf8_end": span["utf8_start"] + len(line[:end].encode("utf-8"))},
                       "interpretation": "source_amount_only_not_confirmed_budget_or_affordability"})
    return values


def build_index(raw: bytes, *, internal_id: str, source_sha256: str, source_format: str = "text",
                context_sha256: str | None = None, date_order: str = "unspecified") -> dict[str, Any]:
    exact_id(internal_id)
    hash_value(source_sha256, "source_sha256")
    need(digest(raw) == source_sha256, "source hash differs from the caller's pinned artifact")
    if context_sha256 is not None:
        hash_value(context_sha256, "context_sha256")
    need(date_order in ("unspecified", "mdy", "dmy"), "invalid date order")
    documents = source_documents(raw, internal_id, source_format)
    binding = {"internal_id": internal_id, "source_sha256": source_sha256, "source_format": source_format,
               "model": MODEL, "version": VERSION, "rules_sha256": RULES_SHA256,
               "context_sha256": context_sha256, "date_order": date_order}
    indexed, candidates, dates, amounts = [], [], [], []
    for document in documents:
        text = document["text"]
        lines, start, byte_start = [], 0, 0
        for number, line in enumerate(text.splitlines(keepends=True), start=1):
            end, byte_end = start + len(line), byte_start + len(line.encode("utf-8"))
            span = {"document_id": document["id"], "page": document["page"], "line": number,
                    "start": start, "end": end, "utf8_start": byte_start, "utf8_end": byte_end}
            lines.append({**span, "text": line})
            amounts.extend(amount_mentions(line, span))
            line_dates = []
            for match in DATE_PATTERN.finditer(line):
                normalized, status = normalized_date(match.group(), date_order)
                mention_id = f"{document['id']}:date:{start + match.start()}"
                dates.append({"id": mention_id, "raw": match.group(), "normalized_date": normalized,
                              "status": status, "span": {**span, "start": start + match.start(), "end": start + match.end(),
                              "utf8_start": byte_start + len(line[:match.start()].encode("utf-8")),
                              "utf8_end": byte_start + len(line[:match.end()].encode("utf-8"))}})
                line_dates.append(mention_id)
            for category, pattern in PATTERNS.items():
                matches = list(re.finditer(pattern, line, re.I))
                if not matches:
                    continue
                candidates.append({"category": category, "span": span,
                    "matches": [{"raw": m.group(), "start": start + m.start(), "end": start + m.end()} for m in matches],
                    "date_mention_ids": line_dates,
                    "date_relationship": "same_source_line_only_not_verified_event_date",
                    "interpretation": "unreviewed_navigation_candidate"})
            start, byte_start = end, byte_end
        need("".join(line["text"] for line in lines) == text, "lossless line coverage failed")
        indexed.append({"id": document["id"], "kind": document["kind"], "page": document["page"],
                        "text_sha256": digest(text.encode("utf-8")), "character_count": len(text),
                        "utf8_byte_count": len(text.encode("utf-8")), "lines": lines})
    return {"schema": "tam-evidence-navigation-index", "version": VERSION, "cache_key": digest(encoded(binding)),
            "binding": binding, "navigation_only": True, "full_reader_required": True,
            "independent_full_validator_required": True, "coverage_scope": "all_supplied_text_only",
            "identity_binding": "artifact_and_caller" if source_format == "artifact" else "caller_supplied",
            "offset_units": "zero_based_unicode_codepoints_and_utf8_bytes_end_exclusive",
            "page_mapping": "caller_supplied_pdf_documents" if any(d["page"] is not None for d in documents) else "unavailable",
            "semantic_client": {"enabled": False, "model": MODEL}, "source_byte_count": len(raw),
            "documents": indexed, "date_mentions": dates, "amount_mentions": amounts, "candidates": candidates}


def evaluate_private_candidates(*_args: Any, **_kwargs: Any) -> None:
    """Future private-client boundary; deliberately disabled, with no credential loading."""
    raise RuntimeError("Private semantic evaluation is disabled; retain canonical full-read behavior")


def timestamp(value: Any) -> datetime:
    need(isinstance(value, str), "stage timestamp must be an explicit timezone-aware ISO value")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    need(parsed.tzinfo is not None, "stage timestamp must include timezone")
    return parsed


def stage_report(receipt_files: list[tuple[str, bytes]]) -> dict[str, Any]:
    """Sum explicit stage measurements; never infer duration from a completion timestamp."""
    need(1 <= len(receipt_files) <= 100, "supply 1..100 exact compact receipt files")
    unique, sources, duplicates = {}, [], 0
    allowed = {"receipt_id", "internal_id", "attempt_id", "stage", "outcome", "reused", "duration_ms", "started_at", "ended_at"}
    required = {"receipt_id", "internal_id", "attempt_id", "stage", "outcome", "reused"}
    for label, raw in receipt_files:
        need(0 < len(raw) <= 1024 * 1024, "compact receipt file must contain 1..1048576 bytes")
        source = fields(json.loads(raw.decode("utf-8")), {"schema", "version", "receipts"}, {"schema", "version", "receipts"}, "timing input")
        need(source["schema"] == "tam-stage-timings" and source["version"] == VERSION, "unsupported timing schema")
        need(isinstance(source["receipts"], list) and len(source["receipts"]) <= 10000, "invalid compact receipt list")
        sources.append({"file": label, "sha256": digest(raw)})
        for value in source["receipts"]:
            row = fields(value, allowed, required, "stage receipt")
            exact_id(row["internal_id"])
            for key in ("receipt_id", "attempt_id"):
                need(isinstance(row[key], str) and 0 < len(row[key]) <= 200, f"invalid {key}")
            need(row["stage"] in STAGES and row["outcome"] in ("completed", "failed", "held") and type(row["reused"]) is bool, "invalid stage result")
            if "duration_ms" in row:
                need("started_at" not in row and "ended_at" not in row, "use one duration measurement representation")
                duration = row["duration_ms"]
                need(type(duration) in (int, float) and math.isfinite(duration) and duration >= 0, "invalid stage duration")
                basis = "explicit_elapsed"
            else:
                need("started_at" in row and "ended_at" in row, "both stage timestamps are required; completion alone is not a duration")
                duration = (timestamp(row["ended_at"]) - timestamp(row["started_at"])).total_seconds() * 1000
                need(duration >= 0, "stage interval runs backwards")
                basis = "explicit_wall_clock_interval"
            if row["receipt_id"] in unique:
                need(unique[row["receipt_id"]][0] == row, "conflicting duplicate stage receipt")
                duplicates += 1
                continue
            unique[row["receipt_id"]] = (row, float(duration), basis)
    stages = {}
    for stage in STAGES:
        rows = [value for value in unique.values() if value[0]["stage"] == stage]
        durations = sorted(value[1] for value in rows)
        stages[stage] = {"samples": len(rows), "sum_ms": sum(durations),
                         "median_ms": statistics.median(durations) if durations else None,
                         "p90_ms": durations[math.ceil(len(durations) * .9) - 1] if durations else None,
                         "fresh_sum_ms": sum(ms for row, ms, _ in rows if not row["reused"]),
                         "reused_sum_ms": sum(ms for row, ms, _ in rows if row["reused"]),
                         "reused_samples": sum(row["reused"] for row, _, _ in rows),
                         "outcomes": {outcome: sum(row["outcome"] == outcome for row, _, _ in rows) for outcome in ("completed", "failed", "held")}}
    return {"schema": "tam-stage-duration-report", "version": VERSION, "sources": sources,
            "unique_receipts": len(unique), "duplicate_receipts_ignored": duplicates,
            "unique_records": len({row["internal_id"] for row, _, _ in unique.values()}),
            "unique_attempts": len({(row["internal_id"], row["attempt_id"]) for row, _, _ in unique.values()}),
            "measurement_bases": sorted({basis for _, _, basis in unique.values()}), "stages": stages,
            "limits": ["Sums measure supplied stage effort, not end-to-end elapsed time; parallel stages can overlap.",
                       "Missing stages are unmeasured, not zero-time operations.",
                       "No throughput or index speedup is established by this report alone."]}


def read_explicit(path: Path, limit: int) -> bytes:
    need(path.is_file(), "an explicit existing local file is required")
    need(path.stat().st_size <= limit, "explicit input exceeds supported size")
    with path.open("rb") as handle:
        raw = handle.read(limit + 1)
    need(len(raw) <= limit, "explicit input exceeds supported size")
    return raw


def write_new(path: Path, value: Any) -> None:
    # Exclusive creation prevents replacing a source, receipt, or active artifact.
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    index = commands.add_parser("index", help="Index one explicit, caller-pinned record artifact")
    index.add_argument("--id", required=True)
    index.add_argument("--input", required=True, type=Path)
    index.add_argument("--source-sha256", required=True)
    index.add_argument("--format", choices=("text", "artifact"), default="text")
    index.add_argument("--context-sha256")
    index.add_argument("--date-order", choices=("unspecified", "mdy", "dmy"), default="unspecified")
    timing = commands.add_parser("timings", help="Summarize only explicitly supplied compact stage receipts")
    timing.add_argument("--receipt", required=True, action="append", type=Path)
    for command in (index, timing):
        command.add_argument("--output", required=True, type=Path, help="New local output path; existing files are never overwritten")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    try:
        if args.command == "index":
            result = build_index(read_explicit(args.input, MAX_SOURCE_BYTES), internal_id=args.id,
                                 source_sha256=args.source_sha256, source_format=args.format,
                                 context_sha256=args.context_sha256, date_order=args.date_order)
            summary = {"schema": result["schema"], "internal_id": args.id, "cache_key": result["cache_key"],
                       "documents": len(result["documents"]), "candidate_references": len(result["candidates"])}
        else:
            result = stage_report([(path.name, read_explicit(path, 1024 * 1024)) for path in args.receipt])
            summary = {"schema": result["schema"], "unique_receipts": result["unique_receipts"], "stages": result["stages"]}
        write_new(args.output, result)
        print(json.dumps({**summary, "local_processing_ms": round((time.perf_counter() - started) * 1000, 3)}))
        return 0
    except (ValueError, OSError, RuntimeError) as error:
        # Do not echo source lines, raw artifacts, environment, or provider data.
        print(json.dumps({"error": type(error).__name__, "detail": "local input validation or exclusive output creation failed"}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
