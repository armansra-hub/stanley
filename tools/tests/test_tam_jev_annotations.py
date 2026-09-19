import json
import re
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tam_evidence_index import build_index, digest
from tam_jev_annotations import prepare, evaluate, CRITERIA, QUESTION_VERSION

class AnnotationTests(unittest.TestCase):
    def setUp(self):
        source = b"Contact: Pat\nWe use QuickBooks.\nA seller sent an invitation.\n"
        self.raw = json.dumps(build_index(source, internal_id="123", source_sha256=digest(source))).encode()

    def test_only_explicit_lines_are_transmitted_and_exact_source_is_bound(self):
        prepared = prepare(self.raw, digest(self.raw), "123", ["record_text:1", "record_text:2"])
        self.assertNotIn("seller", prepared["payload"]["text"])
        self.assertEqual(prepared["spans"][1]["start"], len("Contact: Pat\n"))
        with self.assertRaises(ValueError): prepare(self.raw, digest(self.raw), "124", ["record_text:2"])
        with self.assertRaises(ValueError): prepare(self.raw, "0" * 64, "123", ["record_text:2"])

    def test_annotation_remains_navigation_only_and_rejects_model_drift(self):
        prepared = prepare(self.raw, digest(self.raw), "123", ["record_text:2"])
        response = {"ok": True, "model": "jev-1.13.0", "questionVersion": "stanley-evidence-v2", "criteria": {c["id"]: .5 for c in CRITERIA}}
        result = evaluate(prepared, "synthetic-token", lambda _: response)
        self.assertTrue(result["independent_full_validator_required"])
        self.assertEqual(result["binding"]["question_version"], "stanley-evidence-v2")
        response["questionVersion"] = "stanley-evidence-v1"
        with self.assertRaises(ValueError): evaluate(prepared, "synthetic-token", lambda _: response)
        response["questionVersion"] = "stanley-evidence-v2"
        response["model"] = "jev-2.0.0"
        with self.assertRaises(ValueError): evaluate(prepared, "synthetic-token", lambda _: response)

    def test_question_version_matches_the_typescript_endpoint_adapter(self):
        adapter = Path(__file__).resolve().parents[2] / "lib" / "intelligence" / "jev.ts"
        match = re.search(r'export const JEV_QUESTION_VERSION = "([^"]+)";', adapter.read_text(encoding="utf-8"))
        self.assertIsNotNone(match)
        self.assertEqual(QUESTION_VERSION, match.group(1))

if __name__ == "__main__": unittest.main()
