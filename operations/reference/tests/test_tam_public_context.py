import copy
import json
from pathlib import Path
import tempfile
import unittest

from tools import tam_public_context as context


def public():
    return {"schema": "stanley-public-account-context", "version": 1, "internalId": "123",
            "observations": [{"id": "new", "eventDate": "2026-09-18", "observedAt": "2026-09-19", "relationship": "related"},
                             {"id": "old", "eventDate": "2026-01-01", "observedAt": "2026-09-19"},
                             {"id": "unknown", "eventDate": None, "observedAt": "2026-09-19"}],
            "coverage": {"partial": True, "scope": "latest_current_public_observations"}}


class PublicContextTests(unittest.TestCase):
    def test_compares_source_event_dates_without_relabeling_observed_at(self):
        validated = {"validation_status": "passed", "newest_human_interaction_date": "2026-09-01", "newest_human_interaction_summary": "Synthetic buyer statement"}
        result = context.compare("123", validated, public(), validator_sha256="a" * 64)
        rows = {row["id"]: row for row in result["observations"]}
        self.assertEqual(rows["new"]["daysAfterInteraction"], 17)
        self.assertEqual(rows["new"]["relationship"], "related")
        self.assertEqual(rows["old"]["crmComparison"], "before_last_substantive_interaction")
        self.assertEqual(rows["unknown"]["crmComparison"], "unknown_event_date")
        self.assertTrue(result["coverage"]["partial"])

    def test_no_missing_crm_date_inference_and_exact_identity_required(self):
        validated = {"validation_status": "passed", "newest_human_interaction_date": None}
        result = context.compare("123", validated, public(), validator_sha256="a" * 64)
        self.assertEqual(result["observations"][0]["crmComparison"], "unknown_crm_date")
        with self.assertRaises(ValueError): context.compare("124", validated, public(), validator_sha256="a" * 64)
        with self.assertRaises(ValueError): context.compare("123", {**validated, "validation_status": "hold"}, public(), validator_sha256="a" * 64)

    def test_only_exact_id_reaches_transport_and_private_report_stays_local(self):
        validation = {"validation_status": "passed", "newest_human_interaction_date": "2026-09-01", "newest_human_interaction_summary": "Synthetic private CRM"}
        original = copy.deepcopy(validation)
        calls = []
        with tempfile.TemporaryDirectory() as folder:
            def fetch(internal_id, token, bypass):
                calls.append(internal_id)
                return public()
            result = context.refresh_comparison("123", validation, validator_sha256="a" * 64, root=folder, token="synthetic", fetch=fetch)
            report = json.loads(Path(result["path"]).read_bytes())
            self.assertEqual(report["last_substantive_interaction"]["summary"], "Synthetic private CRM")
        self.assertEqual(calls, ["123"])
        self.assertEqual(validation, original)
        self.assertEqual(result["private_requests_sent"], 0)

    def test_source_failure_is_nonblocking_and_hook_occurs_after_publication(self):
        result = context.refresh_comparison("123", {}, validator_sha256="a" * 64, root="unused", token="synthetic",
                                           fetch=lambda *_: (_ for _ in ()).throw(TimeoutError("unavailable")))
        self.assertEqual(result["status"], "public_context_unavailable_grade_unchanged")
        here = Path(__file__).resolve()
        candidates = [here.parents[1] / "run_tam_single_record.py",
                      here.parents[1] / "tools/run_tam_single_record.py",
                      here.parents[2] / "operations/reference/tools/run_tam_single_record.py"]
        source = next(path for path in candidates if path.is_file()).read_text(encoding="utf-8")
        normal = source.split('stage = "claim"', 1)[1].split("def parse_args", 1)[0]
        self.assertLess(normal.index("verify_publish_event("), normal.index("public_context.refresh_comparison("))
        recovery = source.split("def recover_accepted_publish", 1)[1].split("def run_one", 1)[0]
        self.assertNotIn("public_context.refresh_comparison", recovery)


if __name__ == "__main__": unittest.main()
