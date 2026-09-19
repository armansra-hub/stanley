"""Offline contract tests; no private evidence, credentials or grader execution."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tam_navigation_bridge as bridge


def fixture():
    text = "Contact: Pat\r\n2026-09-17 Pat said we use QuickBooks.\r\nBudget is $5,000 monthly.\r\nLast note.\n"
    return {"capture": {"internal_id": "123"}, "record_text": text,
            "record_text_sha256": bridge.indexer.digest(text.encode()),
            "pdf_pages": 2, "pdf_page_texts": ["===== PDF PAGE 1 OF 2 =====\nPage one", "===== PDF PAGE 2 OF 2 =====\nPage two"]}


class NavigationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def prepare(self, package=None, evidence=None):
        package = package or fixture()
        with mock.patch.object(bridge.annotations, "evaluate", side_effect=AssertionError("must never dispatch")):
            receipt = bridge.prepare_package("123", package, evidence=evidence or {"rubric": "version1"}, root=self.root)
        return package, receipt

    def test_cache_reuses_index_without_regex_rebuild_or_model_request(self):
        package, first = self.prepare()
        with mock.patch.object(bridge.indexer, "build_index", side_effect=AssertionError("unneeded rebuild")):
            second_package, second = self.prepare()
        self.assertFalse(first["reused"])
        self.assertTrue(second["reused"])
        self.assertEqual(first["navigation_sha256"], second["navigation_sha256"])
        self.assertEqual(package["evidence_navigation"], second_package["evidence_navigation"])
        self.assertEqual(second["private_requests_sent"], 0)
        self.assertGreater(first["jev_request_count"], 0)

    def test_source_context_and_id_bindings_are_required(self):
        _, first = self.prepare()
        package = fixture()
        package["record_text"] += "New actual source text."
        package["record_text_sha256"] = bridge.indexer.digest(package["record_text"].encode())
        _, changed = self.prepare(package)
        _, context = self.prepare(evidence={"rubric": "version2"})
        self.assertEqual(len({first["path"], changed["path"], context["path"]}), 3)
        package["capture"]["internal_id"] = "124"
        with self.assertRaises(ValueError): self.prepare(package)

    def test_all_evidence_characters_pages_and_supplement_preserved(self):
        package = fixture()
        package["supplemental_company_context"] = {"note": "Separate dated context"}
        original = copy.deepcopy(package)
        _, receipt = self.prepare(package)
        index = json.loads(Path(receipt["path"]).read_bytes())
        documents = {item["id"]: item for item in index["documents"]}
        self.assertEqual("".join(line["text"] for line in documents["record_text"]["lines"]), original["record_text"])
        for number, text in enumerate(original["pdf_page_texts"], 1):
            self.assertEqual("".join(line["text"] for line in documents[f"pdf_{number}"]["lines"]), text)
        for key, value in original.items(): self.assertEqual(package[key], value)
        self.assertIn("supplemental_company_context", documents)

    def test_corrupt_cached_index_is_rebuilt(self):
        _, first = self.prepare()
        Path(first["path"]).write_bytes(b"invalid json")
        _, second = self.prepare()
        self.assertFalse(second["reused"])
        self.assertEqual(first["index_sha256"], second["index_sha256"])

    def test_completed_jev_results_are_reused_and_raw_values_preserved(self):
        _, first = self.prepare()
        folder = Path(first["path"]).parent
        request = json.loads((folder / "jev-request-0001.json").read_bytes())
        raw_result = {"ok": True, "model": "jev-1.13.0", "questionVersion": bridge.annotations.QUESTION_VERSION,
                      "criteria": {c["id"]: .42 for c in bridge.annotations.CRITERIA}, "rawAnswers": {"native": "unchanged"}}
        result = bridge.annotations.evaluate(request, "synthetic-token", lambda _: raw_result)
        output = folder / "jev-result-0001.json"
        bridge.atomic_json(output, result)
        bridge.atomic_json(output.with_name(output.name + ".request.json"),
                           {"status": "complete", "output_sha256": bridge.indexer.digest(output.read_bytes())})
        package, second = self.prepare()
        self.assertEqual(second["jev_annotation_count"], 1)
        self.assertEqual(package["evidence_navigation"]["jev_annotations"][0]["annotations"], raw_result["criteria"])
        self.assertEqual(json.loads(output.read_bytes())["provider_result"], raw_result)
        self.assertNotEqual(first["navigation_sha256"], second["navigation_sha256"])
        result["binding"]["internal_id"] = "124"
        bridge.atomic_json(output, result)
        bridge.atomic_json(output.with_name(output.name + ".request.json"),
                           {"status": "complete", "output_sha256": bridge.indexer.digest(output.read_bytes())})
        _, third = self.prepare()
        self.assertEqual(third["jev_annotation_count"], 0)

    def test_preparation_packets_include_nearby_context_and_respect_caps(self):
        _, receipt = self.prepare()
        request = json.loads((Path(receipt["path"]).parent / "jev-request-0001.json").read_bytes())
        self.assertIn("Last note", request["payload"]["text"])
        self.assertLessEqual(len(request["binding"]["references"]), 40)
        self.assertLessEqual(len(request["payload"]["text"].encode()), 12000)

    def test_stage_measurements_are_direct_and_compatible_with_report(self):
        clock = bridge.StageTimings(self.root, "123")
        self.assertEqual(clock.call("reader", lambda: ({}, Path("fixture.json"), True))[2], True)
        with self.assertRaises(RuntimeError):
            clock.call("validator", lambda: (_ for _ in ()).throw(RuntimeError("synthetic")))
        report = bridge.indexer.stage_report([(str(clock.path), clock.path.read_bytes())])
        self.assertEqual(report["stages"]["reader"]["reused_samples"], 1)
        self.assertEqual(report["stages"]["validator"]["outcomes"]["failed"], 1)
        self.assertEqual(report["stages"]["publication"]["samples"], 0)


if __name__ == "__main__": unittest.main()
