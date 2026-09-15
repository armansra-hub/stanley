"""Offline crash-boundary tests; no credentials, sockets, or production calls."""
import copy
import hashlib
import io
import json
import tempfile
import types
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

import foundation_form5500 as subject

ORIGIN = "https://jarvis-sable-eta.vercel.app"
KEY = "2023:5500-SF"


class Form5500CheckpointTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = str(Path(temporary.name) / "state.json")
        self.stop = self.path + ".stop"
        self.state = {"version": 1, "app": ORIGIN, "years": [2023],
                      "tamSignature": "a" * 64, "tamCount": 1,
                      "datasets": {KEY: {"scanned": 100, "matched": 4, "stored": 4,
                                         "triggers": 2, "archiveSha256": "b" * 64}}}
        self.batch = [{"companyId": "local-company", "filingId": "local-filing", "sponsorName": "Caf\u00e9"}]
        self.ack = {"received": 1, "stored": 1, "rejected": 0, "triggers": 3, "companies": 1}
        subject.atomic_json(self.path, self.state)
        guard = patch("socket.create_connection", side_effect=AssertionError("No network in tests"))
        guard.start(); self.addCleanup(guard.stop)

    def read(self):
        return json.loads(Path(self.path).read_text(encoding="utf-8"))

    def commit(self):
        return subject.commit_batch(self.path, self.state, KEY, 108, 1, self.batch, "local-fixture-secret", self.stop)

    def test_exact_durable_intent_precedes_transport_and_ack_commits_all_fields(self):
        before = hashlib.sha256(Path(self.path).read_bytes()).hexdigest()

        def transport(request, **kwargs):
            saved = self.read()
            pending = saved["pendingBatch"]
            self.assertEqual(saved["datasets"][KEY]["scanned"], 100)
            self.assertEqual(pending["requestBodyUtf8"].encode(), request.data)
            self.assertEqual(pending["requestBodySha256"], hashlib.sha256(request.data).hexdigest())
            self.assertEqual(pending["requestBodyBytes"], len(request.data))
            self.assertEqual(pending["checkpointSha256Before"], before)
            self.assertEqual((pending["datasetKey"], pending["startScannedExclusive"], pending["endScannedInclusive"]), (KEY, 100, 108))
            self.assertEqual(pending["archiveSha256"], "b" * 64)
            self.assertEqual(pending["tamSignature"], "a" * 64)
            self.assertNotIn("local-fixture-secret", Path(self.path).read_text())
            return io.BytesIO(json.dumps(self.ack).encode())

        with patch.object(subject, "open_app_request", side_effect=transport) as opened:
            self.assertEqual(self.commit(), self.ack)
        self.assertEqual(opened.call_count, 1)
        saved = self.read()
        self.assertNotIn("pendingBatch", saved)
        self.assertEqual({name: saved["datasets"][KEY][name] for name in ("scanned", "matched", "stored", "triggers")},
                         {"scanned": 108, "matched": 5, "stored": 5, "triggers": 5})
        self.assertEqual(saved["lastAcknowledgedBatch"]["response"], self.ack)
        self.assertEqual(saved, self.state)

    def test_post_transient_errors_never_retry_even_when_caller_requests_more_attempts(self):
        errors = [urllib.error.HTTPError(ORIGIN, code, "fixture", {}, None) for code in (429, 500, 502, 503, 504)]
        errors += [urllib.error.URLError("fixture"), TimeoutError("fixture")]
        for error in errors:
            with self.subTest(error=type(error).__name__, status=getattr(error, "code", None)):
                with patch.object(subject, "open_app_request", side_effect=error) as opened, patch.object(subject.time, "sleep", side_effect=AssertionError("No POST retry")):
                    with self.assertRaises(type(error)):
                        subject.request_json(ORIGIN + "/api/test", "mock", {"observations": self.batch}, attempts=7)
                self.assertEqual(opened.call_count, 1)

    def test_failed_post_preserves_body_boundary_and_sanitized_error(self):
        error = urllib.error.HTTPError(ORIGIN, 503, "sensitive-fixture-do-not-store", {}, None)
        with patch.object(subject, "open_app_request", side_effect=error) as opened:
            with self.assertRaises(urllib.error.HTTPError): self.commit()
        self.assertEqual(opened.call_count, 1)
        saved = self.read()
        self.assertEqual(saved["datasets"][KEY], self.state["datasets"][KEY])
        self.assertEqual(saved["datasets"][KEY]["scanned"], 100)
        self.assertEqual(json.loads(saved["pendingBatch"]["requestBodyUtf8"]), {"observations": self.batch})
        self.assertEqual(saved["pendingBatch"]["failure"], {"type": "HTTPError", "httpStatus": 503})
        self.assertNotIn("sensitive-fixture", json.dumps(saved))
        with patch.object(subject, "request_json", side_effect=AssertionError("No replay")):
            with self.assertRaises(SystemExit): self.commit()

    def test_incomplete_or_malformed_acknowledgment_never_advances_offset(self):
        replies = [{}, {**self.ack, "stored": 0}, {**self.ack, "received": 2},
                   {**self.ack, "rejected": 1}, {**self.ack, "companies": 0},
                   {**self.ack, "triggers": -1}, {**self.ack, "stored": True}, None]
        for reply in replies:
            with self.subTest(reply=reply):
                self.state.pop("pendingBatch", None)
                subject.atomic_json(self.path, self.state)
                with patch.object(subject, "request_json", return_value=reply):
                    with self.assertRaises(RuntimeError): self.commit()
                self.assertEqual(self.read()["datasets"][KEY]["scanned"], 100)
                self.assertIn("pendingBatch", self.read())

    def test_invalid_json_response_keeps_pending_after_single_transport(self):
        with patch.object(subject, "open_app_request", return_value=io.BytesIO(b"accepted but body incomplete")) as opened:
            with self.assertRaises(json.JSONDecodeError): self.commit()
        self.assertEqual(opened.call_count, 1)
        self.assertIn("pendingBatch", self.read())

    def test_pending_write_failure_prevents_transport(self):
        before = Path(self.path).read_bytes()
        with patch.object(subject, "atomic_json", side_effect=OSError("disk full")), patch.object(subject, "request_json") as request:
            with self.assertRaises(OSError): self.commit()
        request.assert_not_called()
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_ack_checkpoint_failure_leaves_durable_pending_and_old_offset(self):
        atomic = subject.atomic_json

        def persist(path, value):
            if "pendingBatch" not in value: raise OSError("crash after acknowledgment")
            atomic(path, value)

        with patch.object(subject, "atomic_json", side_effect=persist), patch.object(subject, "request_json", return_value=self.ack) as request:
            with self.assertRaises(OSError): self.commit()
        request.assert_called_once()
        saved = subject.load_state(self.path)
        self.assertEqual(saved["datasets"][KEY]["scanned"], 100)
        with self.assertRaises(SystemExit): subject.require_no_pending_batch(saved)

    def test_stop_before_intent_preserves_checkpoint_without_request(self):
        Path(self.stop).write_text("stop")
        before = Path(self.path).read_bytes()
        with patch.object(subject, "request_json") as request:
            with self.assertRaises(SystemExit): self.commit()
        request.assert_not_called()
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_stop_between_intent_and_request_never_dispatches(self):
        atomic = subject.atomic_json

        def persist(path, value):
            atomic(path, value)
            Path(self.stop).write_text("stop")

        with patch.object(subject, "atomic_json", side_effect=persist), patch.object(subject, "request_json") as request:
            with self.assertRaises(SystemExit): self.commit()
        request.assert_not_called()
        self.assertIn("pendingBatch", self.read())
        self.assertEqual(self.read()["datasets"][KEY]["scanned"], 100)

    def test_empty_scanned_span_needs_no_post_or_pending_request(self):
        with patch.object(subject, "request_json") as request:
            subject.commit_batch(self.path, self.state, KEY, 108, 0, [], "mock", self.stop)
        request.assert_not_called()
        self.assertNotIn("pendingBatch", self.read())
        self.assertEqual(self.read()["datasets"][KEY]["scanned"], 108)
        self.assertEqual(self.read()["datasets"][KEY]["stored"], 4)

    def test_startup_and_reset_cannot_bypass_any_pending_marker(self):
        for marker in (None, {}, {"status": "pending_request"}):
            for reset in ([], ["--reset"]):
                with self.subTest(marker=marker, reset=reset):
                    self.state["pendingBatch"] = marker
                    subject.atomic_json(self.path, self.state)
                    before = Path(self.path).read_bytes()
                    argv = ["foundation_form5500.py", "--state-file", self.path, "--secret", "fixture", *reset]
                    with patch("sys.argv", argv), patch.object(subject, "env_file", return_value=None), patch.object(subject, "load_tam") as load:
                        with self.assertRaises(SystemExit): subject.main()
                    load.assert_not_called()
                    self.assertEqual(Path(self.path).read_bytes(), before)
                    self.assertFalse(Path(self.path + ".lock").exists())

    def test_existing_version_one_checkpoint_without_pending_is_backward_compatible(self):
        loaded = subject.load_state(self.path)
        subject.require_no_pending_batch(loaded)
        self.assertEqual(loaded, self.state)

    def test_main_commits_multiple_batches_and_rebinds_dataset_reference(self):
        companies = [{"id": "local-company", "name": "Acme Fixtures", "state": "CO", "city": "Denver"}]
        state = copy.deepcopy(self.state)
        state["tamSignature"] = subject.tam_signature(companies)
        url = "https://askebsa.dol.gov/FOIA%20Files/2023/Latest/F_5500_SF_2023_Latest.zip"
        state["datasets"][KEY].update({"sourceUrl": url, "scanned": 0, "matched": 0, "stored": 0, "triggers": 0})
        state["datasets"]["2023:5500"] = {"status": "complete", "sourceUrl": url.replace("F_5500_SF", "F_5500")}
        subject.atomic_json(self.path, state)
        rows = [{"SF_ACK_ID": str(i), "SF_SPONSOR_NAME": "Acme Fixtures"} for i in (1, 2)]
        argv = ["foundation_form5500.py", "--state-file", self.path, "--secret", "fixture", "--years", "2023", "--batch-size", "1"]
        with patch("sys.argv", argv), patch.object(subject, "env_file", return_value=None), patch.object(subject, "load_tam", return_value=companies), patch.object(subject, "ensure_archive", return_value="b" * 64), patch.object(subject, "rows_from_zip", return_value=iter(rows)), patch.object(subject, "request_json", return_value=self.ack) as request, patch("builtins.print"):
            subject.main()
        self.assertEqual(request.call_count, 2)
        saved = self.read()
        self.assertNotIn("pendingBatch", saved)
        self.assertEqual(saved["datasets"][KEY]["stored"], 2)
        self.assertEqual(saved["datasets"][KEY]["scanned"], 2)
        self.assertEqual(saved["datasets"][KEY]["status"], "complete")
        self.assertEqual(saved["lastAcknowledgedBatch"]["startScannedExclusive"], 1)

    def test_windows_liveness_uses_only_zero_timeout_synchronize_handle(self):
        for wait_result, expected in ((0x102, True), (0, False)):
            kernel = types.SimpleNamespace(OpenProcess=Mock(return_value=1234), WaitForSingleObject=Mock(return_value=wait_result), CloseHandle=Mock())
            with self.subTest(wait_result=wait_result), patch("ctypes.WinDLL", return_value=kernel), patch.object(subject.os, "kill", side_effect=AssertionError("No Windows signals")):
                self.assertEqual(subject.windows_process_alive(4567), expected)
            kernel.OpenProcess.assert_called_once_with(0x00100000, False, 4567)
            kernel.WaitForSingleObject.assert_called_once_with(1234, 0)
            kernel.CloseHandle.assert_called_once_with(1234)

    def test_windows_liveness_failures_preserve_lock_ambiguity(self):
        kernel = types.SimpleNamespace(OpenProcess=Mock(return_value=None), WaitForSingleObject=Mock(), CloseHandle=Mock())
        with patch("ctypes.WinDLL", return_value=kernel), patch("ctypes.get_last_error", return_value=5):
            with self.assertRaises(SystemExit): subject.windows_process_alive(4567)
        kernel.WaitForSingleObject.assert_not_called()
        kernel.CloseHandle.assert_not_called()
        with patch("ctypes.WinDLL", return_value=kernel), patch("ctypes.get_last_error", return_value=87):
            self.assertFalse(subject.windows_process_alive(4567))
        kernel.OpenProcess.return_value = 1234
        kernel.WaitForSingleObject.return_value = 0xffffffff
        with patch("ctypes.WinDLL", return_value=kernel):
            with self.assertRaises(SystemExit): subject.windows_process_alive(4567)
        kernel.CloseHandle.assert_called_once_with(1234)

    def test_liveness_routes_windows_to_handle_query_and_keeps_posix_signal_zero(self):
        with patch.object(subject.os, "name", "nt"), patch.object(subject, "windows_process_alive", return_value=True) as query, patch.object(subject.os, "kill", side_effect=AssertionError("No Windows signals")):
            self.assertTrue(subject.process_alive("4567"))
        query.assert_called_once_with(4567)
        with patch.object(subject.os, "name", "posix"), patch.object(subject.os, "kill") as signal:
            self.assertTrue(subject.process_alive("4567"))
        signal.assert_called_once_with(4567, 0)


if __name__ == "__main__":
    unittest.main()
