"""Offline transport tests: no sockets, credentials, or production requests."""
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
import urllib.response
import zipfile
from email.message import Message
from pathlib import Path
from unittest.mock import patch

import foundation_app_http as app_http
import foundation_form5500 as form5500
import foundation_inc5000_2026 as inc5000
import foundation_sam_extract as sam
import foundation_sba as sba


ORIGIN = app_http.STANLEY_ORIGIN
CLIENTS = ((form5500, 120), (sam, 240), (sba, 180), (inc5000, 240))
BUILD_OPENER = urllib.request.build_opener


class FakeTransport(urllib.request.BaseHandler):
    handler_order = 100

    def __init__(self, status=200, location=None, body=b'{"ok": true}'):
        self.status, self.location, self.body = status, location, body
        self.requests = []

    def https_open(self, request):
        self.requests.append(request)
        headers = Message()
        if self.location:
            headers['Location'] = self.location
        response = urllib.response.addinfourl(
            io.BytesIO(self.body), headers, request.full_url, self.status
        )
        response.msg = 'mock response'
        return response

    http_open = https_open


class AuthenticatedAppTransportTests(unittest.TestCase):
    def setUp(self):
        # Any accidental real network path or global-opener mutation fails.
        self.socket_guard = patch('socket.create_connection', side_effect=AssertionError('No network in tests'))
        self.install_guard = patch('urllib.request.install_opener', side_effect=AssertionError('No global opener'))
        self.socket_guard.start()
        self.install_guard.start()
        self.addCleanup(self.socket_guard.stop)
        self.addCleanup(self.install_guard.stop)

    def transport_opener(self, transport):
        return patch.object(
            app_http.urllib.request, 'build_opener',
            side_effect=lambda *handlers: BUILD_OPENER(transport, *handlers),
        )

    def test_each_client_keeps_normal_get_and_post_body_headers_timeout(self):
        for client, timeout in CLIENTS:
            for body in (None, {'observations': [{'id': 'local-fixture'}]}):
                with self.subTest(client=client.__name__, body=body):
                    transport = FakeTransport()
                    with self.transport_opener(transport), patch('urllib.request.urlopen', side_effect=AssertionError('Authenticated request used global urlopen')):
                        self.assertEqual(client.request_json(ORIGIN + '/api/test', 'mock-secret', body), {'ok': True})
                    self.assertEqual(len(transport.requests), 1)
                    request = transport.requests[0]
                    self.assertEqual(request.get_header('X-cron-secret'), 'mock-secret')
                    self.assertEqual(request.timeout, timeout)
                    self.assertEqual(request.get_method(), 'GET' if body is None else 'POST')
                    self.assertEqual(None if request.data is None else json.loads(request.data), body)

    def test_each_client_refuses_same_and_cross_origin_redirects_without_second_request(self):
        for client, _ in CLIENTS:
            for status in (301, 302, 303, 307, 308):
                for location in (ORIGIN + '/redirected', 'https://example.invalid/collect'):
                    for body in (None, {'observations': [{'id': 'local-fixture'}]}):
                        with self.subTest(client=client.__name__, status=status, location=location, body=body):
                            transport = FakeTransport(status, location)
                            with self.transport_opener(transport), patch.object(form5500.time, 'sleep', side_effect=AssertionError('No redirect retry')):
                                with self.assertRaises((urllib.error.HTTPError, RuntimeError)) as raised:
                                    options = {'attempts': 4} if client is form5500 else {}
                                    client.request_json(ORIGIN + '/api/test', 'mock-secret', body, **options)
                            self.assertEqual(len(transport.requests), 1)
                            self.assertEqual(transport.requests[0].full_url, ORIGIN + '/api/test')
                            self.assertNotIn('mock-secret', str(raised.exception))

    def test_form5500_keeps_existing_transient_status_retry_policy(self):
        transport = FakeTransport(status=503)
        original_open = transport.https_open

        def route(request):
            transport.status = 503 if not transport.requests else 200
            return original_open(request)

        transport.https_open = route
        with self.transport_opener(transport), patch.object(form5500.time, 'sleep') as sleep:
            self.assertEqual(form5500.request_json(ORIGIN + '/api/test', 'mock-secret', attempts=4), {'ok': True})
        self.assertEqual(len(transport.requests), 2)
        sleep.assert_called_once_with(1)

    def test_foreign_ambiguous_or_insecure_initial_origin_is_rejected_before_transport(self):
        invalid = (
            'https://example.invalid/api/test',
            'http://jarvis-sable-eta.vercel.app/api/test',
            ORIGIN + '.example.invalid/api/test',
            ORIGIN + ':444/api/test',
            ORIGIN + ':443/api/test',
            'https://user@jarvis-sable-eta.vercel.app/api/test',
            'https://jarvis-sable-eta.vercel.app@evil.invalid/api/test',
            ORIGIN + './api/test',
            ORIGIN + '/api/test#fragment',
            ORIGIN + '/api/te\nst',
            ORIGIN + '/api/te\\st',
        )
        for client, _ in CLIENTS:
            for url in invalid:
                with self.subTest(client=client.__name__, url=url):
                    with patch.object(app_http.urllib.request, 'build_opener', side_effect=AssertionError('Origin rejected before opener construction')):
                        with self.assertRaises(ValueError):
                            client.request_json(url, 'mock-secret')

    def test_sba_passes_its_existing_tls_context_to_private_https_handler(self):
        transport = FakeTransport()
        with self.transport_opener(transport) as builder:
            self.assertEqual(sba.request_json(ORIGIN + '/api/test', 'mock-secret'), {'ok': True})
        handlers = builder.call_args.args
        tls = [handler for handler in handlers if isinstance(handler, urllib.request.HTTPSHandler)]
        self.assertEqual(len(tls), 1)
        self.assertIs(tls[0]._context, sba.CTX)

    def test_private_authenticated_opener_does_not_change_public_profile_redirects(self):
        public = 'https://www.inc.com/profile/local-fixture'
        target = 'https://www.inc.com/profile/canonical-fixture'
        transport = FakeTransport()
        with self.transport_opener(transport):
            form5500.request_json(ORIGIN + '/api/test', 'mock-secret')
        # A fresh ordinary opener still follows redirects for public reads.
        public_transport = FakeTransport(body=b'<html>Local fixture</html>')
        original_open = public_transport.https_open

        def route(request):
            public_transport.status = 302 if request.full_url == public else 200
            public_transport.location = target if request.full_url == public else None
            return original_open(request)

        public_transport.https_open = route
        public_opener = BUILD_OPENER(public_transport)
        with patch('urllib.request.urlopen', side_effect=lambda req, **kwargs: public_opener.open(req, **kwargs)):
            self.assertTrue(inc5000.fetch_profile(public)['ok'])
        self.assertEqual([req.full_url for req in public_transport.requests], [public, target])
        self.assertTrue(all(req.get_header('X-cron-secret') is None for req in public_transport.requests))

    def test_public_form5500_archive_keeps_ordinary_urlopen_without_auth(self):
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, 'w') as archive:
            archive.writestr('fixture.csv', 'id\n1\n')
        transport = FakeTransport(body=zipped.getvalue())
        public_opener = BUILD_OPENER(transport)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'fixture.zip')
            with patch('urllib.request.urlopen', side_effect=lambda req, **kwargs: public_opener.open(req, **kwargs)):
                self.assertEqual(len(form5500.ensure_archive('https://www.dol.gov/fixture.zip', path)), 64)
            self.assertTrue(zipfile.is_zipfile(path))
        self.assertEqual(len(transport.requests), 1)
        self.assertIsNone(transport.requests[0].get_header('X-cron-secret'))


if __name__ == '__main__':
    unittest.main()
