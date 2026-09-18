from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from tools import tam_evidence_index as helper


def index(text: str, **options):
    raw = text.encode("utf-8")
    return helper.build_index(raw, internal_id="123", source_sha256=helper.digest(raw), **options)


class EvidenceIndexTests(unittest.TestCase):
    def test_lossless_unicode_newlines_and_exact_byte_character_offsets(self):
        original = "\ufeff2026-09-18 Speaker: Zoë 😀\r\nDiscussed QuickBooks; $1,500 monthly.\f\nLast line"
        result = index(original)
        lines = result["documents"][0]["lines"]
        self.assertEqual("".join(line["text"] for line in lines), original)
        for line in lines:
            self.assertEqual(original[line["start"]:line["end"]], line["text"])
            self.assertEqual(original.encode()[line["utf8_start"]:line["utf8_end"]].decode(), line["text"])
        self.assertEqual(result["page_mapping"], "unavailable")
        self.assertTrue(all(line["page"] is None for line in lines))
        self.assertNotIn("full_record_read", result)
        self.assertTrue(result["full_reader_required"] and result["independent_full_validator_required"])

    def test_dates_are_mentions_and_never_inherited_as_event_dates(self):
        result = index("2026-09-18\nCalled about budget on 09/10/2026.\nJan 5, 2025 Email mentions SAP.\n2026-02-31 Meeting\n")
        self.assertEqual(result["date_mentions"][0]["normalized_date"], "2026-09-18")
        self.assertEqual(result["date_mentions"][1]["status"], "numeric_order_unspecified")
        self.assertIsNone(result["date_mentions"][1]["normalized_date"])
        self.assertEqual(result["date_mentions"][2]["normalized_date"], "2025-01-05")
        self.assertEqual(result["date_mentions"][3]["status"], "invalid_calendar_date")
        candidate = next(row for row in result["candidates"] if row["category"] == "interaction")
        self.assertEqual(candidate["date_mention_ids"], [result["date_mentions"][1]["id"]])
        self.assertEqual(candidate["date_relationship"], "same_source_line_only_not_verified_event_date")
        self.assertEqual(index("09/10/2026", date_order="mdy")["date_mentions"][0]["normalized_date"], "2026-09-10")
        self.assertEqual(index("09/10/2026", date_order="dmy")["date_mentions"][0]["normalized_date"], "2026-10-09")

    def test_candidates_preserve_negation_and_exact_amount_context(self):
        text = "2025-01-02 Buyer said no budget discussion; competitor costs $1,500 monthly.\nWe do not use NetSuite."
        result = index(text)
        budget = next(row for row in result["candidates"] if row["category"] == "budget")
        self.assertIn("$1,500", [row["raw"] for row in budget["matches"]])
        self.assertEqual(text[budget["span"]["start"]:budget["span"]["end"]], text.splitlines(keepends=True)[0])
        self.assertTrue(all(row["interpretation"] == "unreviewed_navigation_candidate" for row in result["candidates"]))
        self.assertNotIn("score", result)

    def test_cache_binds_exact_source_id_rules_model_context_and_date_order(self):
        result = index("ERP\n")
        self.assertEqual(result, index("ERP\n"))
        self.assertNotEqual(result["cache_key"], index("ERP\r\n")["cache_key"])
        self.assertNotEqual(result["cache_key"], index("ERP\n", context_sha256="a" * 64)["cache_key"])
        self.assertNotEqual(result["cache_key"], index("ERP\n", date_order="mdy")["cache_key"])
        raw = b"ERP\n"
        other = helper.build_index(raw, internal_id="124", source_sha256=helper.digest(raw))
        self.assertNotEqual(result["cache_key"], other["cache_key"])
        self.assertEqual(result["binding"]["model"], "none-deterministic")
        self.assertEqual(result["binding"]["rules_sha256"], helper.RULES_SHA256)
        with self.assertRaises(ValueError):
            helper.build_index(raw, internal_id="123", source_sha256="a" * 64)

    def test_artifact_has_explicit_page_pointers_and_lossless_page_content(self):
        artifact = {"schema": "tam-evidence-input", "version": 1, "internal_id": "123", "expected_pdf_pages": 2,
                    "documents": [{"id": "raw", "kind": "record_text", "text": "Raw\r\n"},
                                  {"id": "pdf1", "kind": "pdf_page", "page": 1, "text": "Page 1 budget\n"},
                                  {"id": "pdf2", "kind": "pdf_page", "page": 2, "text": ""}]}
        result = index(json.dumps(artifact), source_format="artifact")
        self.assertEqual(result["page_mapping"], "caller_supplied_pdf_documents")
        self.assertEqual(result["documents"][1]["lines"][0]["page"], 1)
        self.assertEqual(result["documents"][2]["character_count"], 0)
        for document, original in zip(result["documents"], artifact["documents"]):
            self.assertEqual("".join(line["text"] for line in document["lines"]), original["text"])
        for mutation in ({"internal_id": "999"}, {"expected_pdf_pages": 3}, {"private_extra": "not an allowed envelope"}):
            with self.assertRaises(ValueError):
                index(json.dumps({**artifact, **mutation}), source_format="artifact")
        artifact["documents"][2]["page"] = 3
        with self.assertRaises(ValueError):
            index(json.dumps(artifact), source_format="artifact")

    def test_disabled_private_hook_never_loads_config_or_calls_an_endpoint(self):
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            helper.evaluate_private_candidates({"not": "sent"})

    def test_cli_writes_new_only_and_stdout_never_contains_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "source.txt", root / "index.json"
            source.write_bytes(b"PRIVATE SECRET: Called about ERP on 2026-09-18\r\n")
            arguments = ["index", "--id", "123", "--input", str(source), "--source-sha256", helper.digest(source.read_bytes()), "--output", str(output)]
            log = io.StringIO()
            with contextlib.redirect_stdout(log):
                self.assertEqual(helper.main(arguments), 0)
            original = output.read_bytes()
            self.assertNotIn("PRIVATE SECRET", log.getvalue())
            with contextlib.redirect_stderr(log):
                self.assertEqual(helper.main(arguments), 2)
            self.assertEqual(output.read_bytes(), original)


def receipt(identity="a", **patch):
    return {"receipt_id": identity, "internal_id": "123", "attempt_id": "attempt1", "stage": "reader",
            "outcome": "completed", "reused": False, "duration_ms": 1200, **patch}


def timing_file(rows):
    return ("explicit-receipt.json", json.dumps({"schema": "tam-stage-timings", "version": 1, "receipts": rows}).encode())


class StageTimingTests(unittest.TestCase):
    def test_explicit_samples_count_attempts_failures_reuse_and_duplicate_copies(self):
        report = helper.stage_report([timing_file([receipt(), receipt("b", duration_ms=800),
            receipt("c", duration_ms=50, reused=True, attempt_id="attempt2"),
            receipt("d", stage="publication", duration_ms=200, outcome="failed")]), timing_file([receipt()])])
        self.assertEqual(report["unique_receipts"], 4)
        self.assertEqual(report["duplicate_receipts_ignored"], 1)
        self.assertEqual(report["unique_records"], 1)
        self.assertEqual(report["unique_attempts"], 2)
        self.assertEqual(report["stages"]["reader"]["sum_ms"], 2050)
        self.assertEqual(report["stages"]["reader"]["median_ms"], 800)
        self.assertEqual(report["stages"]["reader"]["fresh_sum_ms"], 2000)
        self.assertEqual(report["stages"]["reader"]["reused_sum_ms"], 50)
        self.assertEqual(report["stages"]["publication"]["outcomes"]["failed"], 1)
        self.assertIsNone(report["stages"]["validator"]["median_ms"])
        self.assertIn("not end-to-end", report["limits"][0])

    def test_interval_requires_timezone_and_does_not_treat_completion_as_duration(self):
        row = receipt()
        row.pop("duration_ms")
        row.update(started_at="2026-09-18T12:00:00Z", ended_at="2026-09-18T12:00:01.500Z")
        self.assertEqual(helper.stage_report([timing_file([row])])["stages"]["reader"]["sum_ms"], 1500)
        for patch in ({"started_at": "2026-09-18T12:00:00"}, {"ended_at": "2026-09-18T11:00:00Z"}):
            with self.assertRaises(ValueError):
                helper.stage_report([timing_file([{**row, **patch}])])
        row.pop("started_at")
        with self.assertRaisesRegex(ValueError, "completion alone"):
            helper.stage_report([timing_file([row])])

    def test_rejects_conflicting_duplicates_narratives_nonfinite_and_boolean_durations(self):
        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            helper.stage_report([timing_file([receipt(), receipt(duration_ms=100)])])
        for patch in ({"duration_ms": True}, {"duration_ms": float("nan")}, {"duration_ms": -1},
                      {"narrative": "Do not consume this as a timing receipt"}, {"stage": "grade"}):
            with self.assertRaises(ValueError):
                helper.stage_report([timing_file([receipt(**patch)])])

    def test_cli_summarizes_only_explicit_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / "timing.json", Path(temporary) / "report.json"
            source.write_bytes(timing_file([receipt()])[1])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(helper.main(["timings", "--receipt", str(source), "--output", str(output)]), 0)
            self.assertEqual(json.loads(output.read_text())["unique_receipts"], 1)


if __name__ == "__main__":
    unittest.main()
