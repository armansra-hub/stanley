"""Offline approved-payload, archive and uncertain-write boundaries."""
import copy
import hashlib
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import foundation_sba as subject

class SbaCheckpointTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.path = str(self.directory / 'state.json')
        self.expected = str(self.directory / 'expected.json')
        self.archive = str(self.directory / 'prior.json')
        self.tam = [{'id': 'company1', 'name': 'Acme Fixtures', 'city': 'Denver', 'state': 'CO'}]
        self.rows = [{'companyId': 'company1', 'program': '7(a)', 'locationId': str(i), 'approvalDate': '2026-01-01', 'grossApproval': 25000.0, 'evidence': {'exact': True}} for i in (1, 2)]
        self.write_expected(self.rows)
        self.ack = {'received': 2, 'accepted': 2, 'rejected': 0, 'triggers': 2, 'companies': 1}
        self.old = {'tamCount': 6949, 'tamHash': 'prior-scope', 'ingestOffset': 0, 'totals': {'accepted': 0, 'rejected': 0, 'triggers': 0, 'companies': None}}
        subject.atomic_write(self.path, self.old)
        guard = patch('socket.create_connection', side_effect=AssertionError('No network'))
        guard.start(); self.addCleanup(guard.stop)

    def write_expected(self, rows):
        Path(self.expected).write_text(json.dumps({'observations': rows}), encoding='utf-8')

    def main(self, reset=True, expected=True):
        args = ['foundation_sba.py', '--secret', 'local-fixture', '--seven-a', 'fixture-seven', '--five-oh-four', 'fixture-five', '--state-file', self.path]
        if expected: args += ['--expected-observations', self.expected]
        if reset: args += ['--reset-checkpoint-archive', self.archive]
        with patch('sys.argv', args), patch.object(subject, 'load_tam', return_value=self.tam), patch.object(subject, 'scan_file', side_effect=[(copy.deepcopy(self.rows), 15, 0), ([], 12, 0)]), patch('builtins.print'):
            subject.main()

    def state(self): return json.loads(Path(self.path).read_text(encoding='utf-8'))

    def prepared(self):
        state = {'ingestOffset': 0, 'tamHash': 'fixture', 'observationsSha256': 'a'*64, 'totals': {'accepted': 0, 'rejected': 0, 'triggers': 0}, 'expectedObservations': subject.validate_expected(self.expected, self.rows)}
        subject.atomic_write(self.path, state)
        return state

    def test_actual_ordered_payload_checked_before_archive_reset_or_write(self):
        mutations = [list(reversed(self.rows)), self.rows[:1], [{**self.rows[0], 'companyId': 'foreign'}, self.rows[1]], [{**self.rows[0], 'evidence': {'exact': True, 'extra': 1}}, self.rows[1]]]
        for expected in mutations:
            with self.subTest(expected=expected):
                self.write_expected(expected)
                before = Path(self.path).read_bytes()
                with patch.object(subject, 'request_json') as request, patch.object(subject, 'atomic_write') as write:
                    with self.assertRaises(SystemExit): self.main()
                request.assert_not_called(); write.assert_not_called()
                self.assertEqual(Path(self.path).read_bytes(), before)
                self.assertFalse(Path(self.archive).exists())

    def test_exact_match_archives_old_bytes_then_persists_body_before_single_post(self):
        original = Path(self.path).read_bytes()
        def transport(request, **kwargs):
            self.assertEqual(Path(self.archive).read_bytes(), original)
            saved = self.state(); pending = saved['pendingBatch']
            self.assertEqual(pending['requestBodyUtf8'].encode(), request.data)
            self.assertEqual(pending['requestBodySha256'], hashlib.sha256(request.data).hexdigest())
            self.assertEqual((pending['startOffset'], pending['endOffset']), (0, 2))
            self.assertEqual(pending['expectedObservations']['sha256'], subject.source_hash(self.expected))
            self.assertEqual(saved['ingestOffset'], 0)
            return io.BytesIO(json.dumps(self.ack).encode())
        with patch.object(subject, 'open_app_request', side_effect=transport) as opened:
            self.main()
        self.assertEqual(opened.call_count, 1)
        saved = self.state(); self.assertNotIn('pendingBatch', saved)
        self.assertEqual((saved['status'], saved['ingestOffset'], saved['totals']['accepted']), ('complete', 2, 2))
        self.assertEqual(Path(self.archive).read_bytes(), original)
        self.assertNotIn('local-fixture', json.dumps(saved))

    def test_uncertain_http_response_preserves_pending_and_refuses_resume_or_reset(self):
        error = urllib.error.HTTPError('https://jarvis-sable-eta.vercel.app/api/test', 503, 'fixture', {}, None)
        with patch.object(subject, 'open_app_request', side_effect=error) as opened:
            with self.assertRaises(urllib.error.HTTPError): self.main()
        self.assertEqual(opened.call_count, 1)
        saved = Path(self.path).read_bytes()
        self.assertIn('pendingBatch', self.state()); self.assertEqual(self.state()['ingestOffset'], 0)
        for reset in (True, False):
            with patch.object(subject, 'load_tam') as load:
                with self.assertRaises(SystemExit): self.main(reset=reset)
            load.assert_not_called()
            self.assertEqual(Path(self.path).read_bytes(), saved)

    def test_null_pending_marker_and_reset_without_approval_both_block(self):
        for marker in (None, {}, False):
            subject.atomic_write(self.path, {**self.old, 'pendingBatch': marker})
            with patch.object(subject, 'request_json') as request:
                with self.assertRaises(SystemExit): self.main()
            request.assert_not_called()
        subject.atomic_write(self.path, self.old)
        with self.assertRaises(SystemExit): self.main(expected=False)
        self.assertFalse(Path(self.archive).exists())

    def test_partial_or_invalid_acknowledgment_keeps_pending(self):
        replies = [{}, None, {**self.ack, 'accepted': 1}, {**self.ack, 'rejected': 1}, {**self.ack, 'companies': 2}, {**self.ack, 'triggers': -1}, {**self.ack, 'triggers': 3}, {**self.ack, 'received': True}]
        for reply in replies:
            with self.subTest(reply=reply):
                state = self.prepared()
                with patch.object(subject, 'request_json', return_value=reply):
                    with self.assertRaises(RuntimeError): subject.commit_batch(self.path, state, self.rows, 'https://jarvis-sable-eta.vercel.app', 'fixture')
                self.assertIn('pendingBatch', self.state()); self.assertEqual(self.state()['ingestOffset'], 0)

    def test_failed_pending_persist_prevents_dispatch(self):
        state = self.prepared(); before = Path(self.path).read_bytes()
        with patch.object(subject, 'atomic_write', side_effect=OSError('disk')), patch.object(subject, 'request_json') as request:
            with self.assertRaises(OSError): subject.commit_batch(self.path, state, self.rows, 'https://jarvis-sable-eta.vercel.app', 'fixture')
        request.assert_not_called(); self.assertEqual(Path(self.path).read_bytes(), before)

    def test_acknowledged_but_failed_final_checkpoint_keeps_pending(self):
        state = self.prepared(); atomic = subject.atomic_write
        def persist(path, value):
            if 'pendingBatch' not in value: raise OSError('crash after acknowledgment')
            atomic(path, value)
        with patch.object(subject, 'atomic_write', side_effect=persist), patch.object(subject, 'request_json', return_value=self.ack) as request:
            with self.assertRaises(OSError): subject.commit_batch(self.path, state, self.rows, 'https://jarvis-sable-eta.vercel.app', 'fixture')
        request.assert_called_once(); self.assertIn('pendingBatch', self.state()); self.assertEqual(self.state()['ingestOffset'], 0)

    def test_changed_approval_before_dispatch_is_not_sent(self):
        state = self.prepared(); atomic = subject.atomic_write
        def persist(path, value):
            atomic(path, value); self.write_expected(list(reversed(self.rows)))
        with patch.object(subject, 'atomic_write', side_effect=persist), patch.object(subject, 'request_json') as request:
            with self.assertRaises(SystemExit): subject.commit_batch(self.path, state, self.rows, 'https://jarvis-sable-eta.vercel.app', 'fixture')
        request.assert_not_called(); self.assertIn('pendingBatch', self.state())

    def test_duplicate_approval_keys_and_numeric_type_changes_rejected(self):
        Path(self.expected).write_text('{"observations":[],"observations":[]}', encoding='utf-8')
        with self.assertRaises(ValueError): subject.validate_expected(self.expected, [])
        changed = copy.deepcopy(self.rows); changed[0]['grossApproval'] = 25000
        self.write_expected(changed)
        with self.assertRaises(SystemExit): subject.validate_expected(self.expected, self.rows)

    def test_ordinary_no_approval_mode_and_legacy_checkpoint_keep_matching_path(self):
        Path(self.path).unlink()
        with patch.object(subject, 'request_json', return_value=self.ack) as request:
            self.main(reset=False, expected=False)
        request.assert_called_once(); self.assertEqual(self.state()['candidateCount'], 2)
        with patch.object(subject, 'request_json') as request:
            self.main(reset=False, expected=False)
        request.assert_not_called(); self.assertEqual(self.state()['ingestOffset'], 2)

    def test_new_resume_rejects_changed_ordered_source_scope(self):
        Path(self.path).unlink()
        with patch.object(subject, 'request_json', return_value=self.ack): self.main(reset=False, expected=False)
        original = Path(self.path).read_bytes(); self.rows.reverse()
        with patch.object(subject, 'request_json') as request:
            with self.assertRaises(SystemExit): self.main(reset=False, expected=False)
        request.assert_not_called(); self.assertEqual(Path(self.path).read_bytes(), original)

    def test_existing_archive_never_overwritten_and_old_checkpoint_remains(self):
        Path(self.archive).write_bytes(b'prior immutable fixture')
        original = Path(self.path).read_bytes()
        with patch.object(subject, 'request_json') as request:
            with self.assertRaises(FileExistsError): self.main()
        request.assert_not_called(); self.assertEqual(Path(self.path).read_bytes(), original)
        self.assertEqual(Path(self.archive).read_bytes(), b'prior immutable fixture')

if __name__ == '__main__': unittest.main()
