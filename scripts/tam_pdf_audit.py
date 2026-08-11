#!/usr/bin/env python3
"""Trusted, serial PDF identity audit for tam-local-evidence-sync.mjs.

Input is one JSON object on stdin: {"records": [{"netsuiteInternalId", "pdfPath"}, ...]}.
Output is one bounded JSON object. The helper never writes files or uses the network.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
from typing import Any

from pypdf import PdfReader


SCHEMA = "tam-trusted-pdf-audit"
VERSION = 1
ID_RE = re.compile(r"^[0-9]+$")


def fingerprint(result: os.stat_result) -> tuple[int, int, int, int]:
    return (result.st_dev, result.st_ino, result.st_size, result.st_mtime_ns)


def audit_record(record: dict[str, Any]) -> dict[str, Any]:
    internal_id = str(record.get("netsuiteInternalId", "")).strip()
    pdf_path = str(record.get("pdfPath", "")).strip()
    if not ID_RE.fullmatch(internal_id):
        raise ValueError("exact numeric netsuiteInternalId is required")
    if not pdf_path:
        raise ValueError(f"PDF path is required for {internal_id}")

    before = os.stat(pdf_path, follow_symlinks=True)
    if not os.path.isfile(pdf_path) or before.st_size < 10:
        raise ValueError(f"PDF {internal_id} is not a non-empty regular file")
    with open(pdf_path, "rb") as handle:
        pdf_bytes = handle.read()
    if len(pdf_bytes) != before.st_size:
        raise ValueError(f"PDF {internal_id} changed length while being read")
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError(f"PDF {internal_id} signature is missing")
    if re.search(rb"%%EOF\s*$", pdf_bytes[-4096:]) is None:
        raise ValueError(f"PDF {internal_id} EOF marker is missing or not terminal")

    sha256 = hashlib.sha256(pdf_bytes).hexdigest()
    reader = PdfReader(io.BytesIO(pdf_bytes), strict=False)
    page_count = len(reader.pages)
    if page_count < 1:
        raise ValueError(f"PDF {internal_id} has no parsed pages")
    after = os.stat(pdf_path, follow_symlinks=True)
    if fingerprint(before) != fingerprint(after):
        raise ValueError(f"PDF {internal_id} changed during hash/page-count verification")
    return {
        "netsuiteInternalId": internal_id,
        "sha256": sha256,
        "pageCount": page_count,
        "bytes": before.st_size,
        "stableStat": {
            "size": before.st_size,
            "mtimeNs": before.st_mtime_ns,
            "device": before.st_dev,
            "inode": before.st_ino,
        },
    }


def main() -> int:
    request = json.load(sys.stdin)
    records = request.get("records") if isinstance(request, dict) else None
    if not isinstance(records, list) or not records:
        raise ValueError("records must be a non-empty array")
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_record in records:
        if not isinstance(raw_record, dict):
            raise ValueError("every PDF audit record must be an object")
        result = audit_record(raw_record)
        internal_id = result["netsuiteInternalId"]
        if internal_id in seen:
            raise ValueError(f"PDF audit repeats exact Internal ID {internal_id}")
        seen.add(internal_id)
        results.append(result)
    json.dump(
        {"schema": SCHEMA, "version": VERSION, "results": results},
        sys.stdout,
        ensure_ascii=True,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # Fail once with the exact first blocker; never retry.
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
