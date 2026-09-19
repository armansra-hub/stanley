"""Explicit-file offline navigation benchmark; no model or grading actions."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics

from tam_navigation_bridge import prepare_package, atomic_json


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--capture-sha256", required=True)
    parser.add_argument("--pdf-text-cache", type=Path, required=True)
    parser.add_argument("--context-sha256", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.output_dir.exists():
        raise ValueError("Use a new explicit output directory")
    if sha(args.capture) != args.capture_sha256:
        raise ValueError("Capture hash mismatch")
    capture = json.loads(args.capture.read_bytes())
    internal_id = str(capture["internal_id"])
    text_path, pdf_path = args.capture.parent / "record_text.txt", args.capture.parent / "print.pdf"
    if capture["status"] != "verified" or sha(text_path) != capture["record_text"]["sha256"] or sha(pdf_path) != capture["pdf"]["sha256"]:
        raise ValueError("Source provenance mismatch")
    cache = json.loads(args.pdf_text_cache.read_bytes())
    pages = cache["pages"]
    if (cache["exact_id"] != internal_id or cache["pdf_sha256"] != capture["pdf"]["sha256"]
            or cache["page_count"] != capture["pdf"]["page_count"] or len(pages) != cache["page_count"]
            or not all(page.startswith(f"===== PDF PAGE {number} OF {len(pages)} =====\n") for number, page in enumerate(pages, 1))):
        raise ValueError("Existing PDF text cache mismatch")
    package = {"capture": capture, "record_text": text_path.read_bytes().decode("utf-8"),
               "record_text_sha256": capture["record_text"]["sha256"], "pdf_page_texts": pages,
               "pdf_pages": len(pages), "pdf_sha256": capture["pdf"]["sha256"]}
    evidence = {"contextSha256": args.context_sha256, "captureSha256": args.capture_sha256,
                "pdfSha256": package["pdf_sha256"], "pdfTextCacheSha256": sha(args.pdf_text_cache)}
    receipts = [prepare_package(internal_id, package, evidence=evidence, root=args.output_dir / "navigation") for _ in range(4)]
    fresh, reused = receipts[0], receipts[1:]
    if fresh["reused"] or not all(row["reused"] for row in reused):
        raise ValueError("Benchmark did not establish fresh versus cached preparation")
    median = statistics.median(row["duration_ms"] for row in reused)
    report = {"schema": "tam-navigation-offline-benchmark", "version": 1, "internal_id": internal_id,
              "evidence": evidence, "record_characters": len(package["record_text"]), "pdf_pages": len(pages),
              "pdf_text_characters": sum(len(page) for page in pages), "fresh_ms": fresh["duration_ms"],
              "cached_ms": [row["duration_ms"] for row in reused], "cached_median_ms": median,
              "preparation_speedup": fresh["duration_ms"] / median if median else None,
              "private_requests_sent": 0, "model_calls": 0, "claims": 0, "publications": 0,
              "receipts": receipts,
              "scope": "One explicit already-captured record; navigation preparation only. This is not live grading throughput."}
    atomic_json(args.output_dir / "benchmark.json", report)
    print(json.dumps({key: report[key] for key in ("internal_id", "record_characters", "pdf_pages", "pdf_text_characters",
                                                  "fresh_ms", "cached_ms", "cached_median_ms", "preparation_speedup",
                                                  "model_calls", "claims", "publications")}))


if __name__ == "__main__": main()
