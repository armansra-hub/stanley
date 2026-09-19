"""Synthetic canonical-boundary tests; never run the grader or access CRM."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tools import run_tam_single_record as runner
from tools import tam_record_core as core


def package():
    text = "2026-09-17 Pat said budget is $5,000 monthly.\nOriginal complete last line."
    pages = ["===== PDF PAGE 1 OF 1 =====\nAll page content"]
    return {"capture": {"internal_id": "123", "status": "verified", "company": "Fixture",
                        "captured_at_utc": "2026-09-17T00:00:00Z", "snapshot_sha256": "a" * 64,
                        "record_text": {}, "pdf": {}},
            "record_text": text, "record_text_sha256": core.sha256_bytes(text.encode()),
            "pdf_text": pages[0], "pdf_page_texts": pages, "pdf_pages": 1, "pdf_sha256": "b" * 64}


class CanonicalNavigationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = mock.patch.multiple(runner, POOL_ROOT=self.root, ROUND_CONTEXT=None)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.corepatch = mock.patch.object(core, "ROUND_CONTEXT", None)
        self.corepatch.start()
        self.addCleanup(self.corepatch.stop)

    def test_fresh_navigation_changes_identity_but_preserves_full_prompts(self):
        evidence = package()
        before = runner.evidence_identity("123", evidence)
        receipt = runner.prepare_evidence_navigation("123", evidence)
        self.assertEqual(receipt["private_requests_sent"], 0)
        after = runner.evidence_identity("123", evidence)
        self.assertNotIn("evidenceNavigationSha256", before)
        self.assertIn("evidenceNavigationSha256", after)
        for key in before: self.assertEqual(before[key], after[key])
        reader = core.reader_prompt("123", evidence)
        validator = core.validator_prompt("123", evidence, {"synthetic": True})
        for prompt in (reader, validator):
            self.assertIn(evidence["record_text"], prompt)
            self.assertIn(evidence["pdf_text"], prompt)
            self.assertIn("LOCAL EVIDENCE NAVIGATION", prompt)
        self.assertEqual(reader.split("FIRST-PASS ROLE AND GRADING RULES")[0],
                         validator.split("INDEPENDENT VALIDATOR ROLE AND GRADING RULES")[0])

    def test_existing_completed_reader_keeps_eligible_identity_and_no_new_preparation(self):
        evidence = package()
        identity = runner.evidence_identity("123", evidence)
        candidate = self.root / "candidates" / f"123.{runner.evidence_key('123', evidence)}.json"
        core.atomic_json(candidate, {"synthetic": "completed-reader"})
        runner.write_artifact_receipt(candidate, identity, "reader", None, "direct-full-evidence")
        with mock.patch.object(runner.navigation_bridge, "prepare_package", side_effect=AssertionError("unneeded rebuild")):
            receipt = runner.prepare_evidence_navigation("123", evidence)
        self.assertEqual(receipt["status"], "preserved_existing_model_artifacts")
        self.assertEqual(identity, runner.evidence_identity("123", evidence))
        self.assertNotIn("evidence_navigation", evidence)

    def test_navigation_error_does_not_become_new_grade_gate(self):
        evidence = package()
        original = copy.deepcopy(evidence)
        with mock.patch.object(runner.navigation_bridge, "prepare_package", side_effect=OSError("synthetic cache outage")):
            result = runner.prepare_evidence_navigation("123", evidence)
        self.assertEqual(result["status"], "navigation_unavailable_full_evidence_retained")
        self.assertEqual(evidence, original)

    def test_canonical_claim_and_accepted_publish_recovery_order_preserved(self):
        source = Path(runner.__file__).read_text(encoding="utf-8")
        normal = source.split('stage = "claim"', 1)[1].split("def parse_args", 1)[0]
        self.assertLess(normal.index("claimed_record = claim("), normal.index("prepare_evidence_navigation("))
        self.assertLess(normal.index("attach_identity_review("), normal.index("prepare_evidence_navigation("))
        recovery = source.split("def recover_accepted_publish", 1)[1].split("def run_one", 1)[0]
        self.assertNotIn("prepare_evidence_navigation", recovery)
        self.assertNotIn("get_or_run_reader", recovery)
        self.assertNotIn("publish_once", recovery)


if __name__ == "__main__": unittest.main()
