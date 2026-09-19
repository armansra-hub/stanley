from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[1]
STAGER = TOOLS / "stage_tam_final_grades.py"
SNAPSHOT = "1" * 64


def canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.write_bytes(
        b"".join(canonical_bytes(record) + b"\n" for record in records)
    )


def record(score: int) -> dict[str, object]:
    return {
        "exact_id": "123",
        "reader_candidate_score": 40,
        "final_score": score,
        "score_adjust_note": "test",
        "record_digest": f"complete digest at score {score}",
        "pdf_sha256": "2" * 64,
        "pdf_page_count": 4,
        "record_text_sha256": "3" * 64,
        "candidate_file_sha256": "4" * 64,
        "validation": {
            "status": "passed",
            "validated_by": "test-validator",
            "validated_at": "2026-07-29T00:00:00+00:00",
        },
    }


class StageRevisionTest(unittest.TestCase):
    def run_stager(self, stream: Path, output: Path) -> dict[str, object]:
        result = subprocess.run(
            [
                sys.executable,
                str(STAGER),
                "--validated",
                str(stream),
                "--output-dir",
                str(output),
                "--snapshot-sha256",
                SNAPSHOT,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_confirmed_revision_supersedes_old_stream_record(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stream = root / "validated.jsonl"
            output = root / "final"
            original = record(30)
            write_jsonl(stream, [original])
            first = self.run_stager(stream, output)
            self.assertEqual(first["staged_final_count"], 1)

            existing = json.loads(
                (output / "final_assessments.jsonl")
                .read_text(encoding="utf-8")
                .strip()
            )
            revised = {
                **record(48),
                "revision_sequence": 1,
                "revision": {
                    "status": "confirmed",
                    "prior_final_sha256": sha256(canonical_bytes(existing)),
                    "third_pass_audit_sha256": "a" * 64,
                    "adjudication_sha256": "b" * 64,
                },
            }
            write_jsonl(stream, [original, revised])
            second = self.run_stager(stream, output)
            self.assertEqual(second["revised_ids"], ["123"])
            current = json.loads(
                (output / "final_assessments.jsonl")
                .read_text(encoding="utf-8")
                .strip()
            )
            self.assertEqual(current["final_score"], 48)
            self.assertEqual(current["revision_sequence"], 1)
            self.assertEqual(
                len(list((output / "revision_history" / "123").glob("*.json"))),
                1,
            )

            third = self.run_stager(stream, output)
            self.assertEqual(third["superseded_ids"], ["123"])
            self.assertEqual(third["unchanged_ids"], ["123"])

    def test_manifest_accepts_only_a_current_exact_live_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stream = root / "validated.jsonl"
            output = root / "final"
            write_jsonl(stream, [record(30)])

            first = self.run_stager(stream, output)
            self.assertEqual(
                first["production_publish_status"],
                "current_aggregate_not_reconciled",
            )

            reconciliation = {
                "generatedAt": "2026-08-11T00:00:00+00:00",
                "canonicalFinals": 1,
                "liveExactIds": 1,
                "mismatchCountAfter": 0,
                "allCanonicalFinalsLive": True,
            }
            (output / "live_final_reconciliation_latest.json").write_text(
                json.dumps(reconciliation), encoding="utf-8"
            )
            reconciled = self.run_stager(stream, output)
            self.assertEqual(
                reconciled["production_publish_status"],
                "exact_live_reconciliation_passed",
            )
            self.assertEqual(reconciled["production_reconciliation_finals"], 1)

            reconciliation["canonicalFinals"] = 2
            (output / "live_final_reconciliation_latest.json").write_text(
                json.dumps(reconciliation), encoding="utf-8"
            )
            stale = self.run_stager(stream, output)
            self.assertEqual(
                stale["production_publish_status"],
                "current_aggregate_not_reconciled",
            )


if __name__ == "__main__":
    unittest.main()
