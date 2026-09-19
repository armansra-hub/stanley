"""Exercise the staging option consumed by the published single-record runner."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tools.tests.test_stage_tam_final_grades import SNAPSHOT, STAGER, record, write_jsonl


class ExactPayloadTests(unittest.TestCase):
    def test_exact_payload_matches_the_persisted_publish_queue(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stream, output = root / "validated.jsonl", root / "final"
            write_jsonl(stream, [record(30)])
            result = subprocess.run(
                [sys.executable, str(STAGER), "--validated", str(stream),
                 "--output-dir", str(output), "--snapshot-sha256", SNAPSHOT,
                 "--return-exact-payload", "123"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            returned = json.loads(result.stdout)
            queued = [json.loads(line) for line in
                      (output / "publish_queue.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(queued), 1)
            self.assertEqual(returned["exact_publish_payload"], queued[0])
            # The per-call payload is not copied into the durable aggregate manifest.
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertNotIn("exact_publish_payload", manifest)


if __name__ == "__main__":
    unittest.main()
