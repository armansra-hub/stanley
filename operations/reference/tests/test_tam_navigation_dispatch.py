"""Synthetic preparation/dispatch tests. No network, private data or grading."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tools import tam_navigation_bridge as bridge


def fixture():
    text = "Contact: Pat\n2026-09-17 Pat said budget is USD 36,000 annually.\nBudget is USD 4k/month.\nUnknown $500.\n"
    return {"capture": {"internal_id": "123"}, "record_text": text,
            "record_text_sha256": bridge.indexer.digest(text.encode()),
            "pdf_pages": 1, "pdf_page_texts": ["Complete page"],
            "assessment_context": {"assessment_date": "2026-09-19"}}


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def prepare(self, package=None, dispatch=True):
        package = package or fixture()
        receipt = bridge.prepare_package("123", package, evidence={"rubric": "fixture"}, root=self.root,
                                         dispatch={"token": "synthetic-token"} if dispatch else None)
        return package, receipt

    def response(self, prepared, token, **kwargs):
        return bridge.annotations.evaluate(prepared, token, transport=lambda _: {
            "ok": True, "model": "jev-1.13.0", "questionVersion": bridge.annotations.QUESTION_VERSION,
            "criteria": {criterion["id"]: .75 for criterion in bridge.annotations.CRITERIA},
            "metadata": {"rawAnswers": {"native": {"yes": .75, "no": .25}}}})

    def test_disabled_route_sends_nothing_and_does_not_block_complete_evidence(self):
        with mock.patch.object(bridge.annotations, "route_ready", return_value=False), mock.patch.object(bridge.annotations, "evaluate") as evaluate:
            package, receipt = self.prepare()
        evaluate.assert_not_called()
        self.assertEqual(receipt["private_requests_sent"], 0)
        self.assertEqual(receipt["status"], "route_not_ready_no_private_content_sent")
        self.assertEqual(package["record_text"], fixture()["record_text"])

    def test_route_probe_has_no_content_and_requires_both_authorizations(self):
        calls = []
        def probe(body, token, bypass):
            calls.append(body)
            return 400, {"error": "invalid_excerpt"}
        self.assertTrue(bridge.annotations.route_ready("synthetic-token", transport=probe))
        self.assertEqual(calls, [{}])
        self.assertFalse(bridge.annotations.route_ready("synthetic-token", transport=lambda *_: (409, {"error": "privacy_not_authorized"})))

    def test_exact_raw_result_frozen_and_reused_without_another_probe(self):
        original_evaluate = bridge.annotations.evaluate
        def response(prepared, token, **kwargs):
            return original_evaluate(prepared, token, transport=lambda _: {
                "ok": True, "model": "jev-1.13.0", "questionVersion": bridge.annotations.QUESTION_VERSION,
                "criteria": {criterion["id"]: .75 for criterion in bridge.annotations.CRITERIA},
                "metadata": {"rawAnswers": {"native": {"yes": .75, "no": .25}}}})
        with mock.patch.object(bridge.annotations, "route_ready", return_value=True), mock.patch.object(bridge.annotations, "evaluate", side_effect=response) as evaluate:
            package, first = self.prepare()
        self.assertEqual(evaluate.call_count, 1)
        self.assertEqual(first["private_requests_sent"], 1)
        self.assertEqual(package["evidence_navigation"]["jev_annotations"][0]["raw_answers"], {"native": {"yes": .75, "no": .25}})
        with mock.patch.object(bridge.annotations, "route_ready", side_effect=AssertionError("must reuse")), mock.patch.object(bridge.annotations, "evaluate", side_effect=AssertionError("must reuse")):
            resumed, second = self.prepare(dispatch=False)
        self.assertEqual(first["navigation_sha256"], second["navigation_sha256"])
        self.assertEqual(package["evidence_navigation"], resumed["evidence_navigation"])
        self.assertEqual(second["private_requests_sent"], 0)

    def test_uncertain_attempt_is_not_retried(self):
        with mock.patch.object(bridge.annotations, "route_ready", return_value=True), mock.patch.object(bridge.annotations, "evaluate", side_effect=TimeoutError("synthetic")) as evaluate:
            _, first = self.prepare()
            _, second = self.prepare()
        self.assertEqual(evaluate.call_count, 1)
        self.assertEqual(first["status"], "annotation_unavailable_or_uncertain")
        self.assertEqual(second["private_requests_sent"], 0)
        outcome = json.loads((Path(first["path"]).parent / "jev-result-0001.json.request.json").read_bytes())
        self.assertEqual(outcome["status"], "pending_or_uncertain")

    def test_monthly_arithmetic_and_date_deltas_do_not_assign_budget_judgment(self):
        package, _ = self.prepare(dispatch=False)
        view = package["evidence_navigation"]
        amounts = view["amount_locations"]
        self.assertEqual([value["monthly_equivalent"] for value in amounts], ["3000", "4000", None])
        self.assertEqual(view["amount_comparisons"][0]["right_minus_left_monthly"], "1000")
        self.assertEqual(view["date_locations"][0]["days_before_assessment"], 2)
        self.assertEqual(amounts[2]["currency"], "$-unspecified")


if __name__ == "__main__": unittest.main()
