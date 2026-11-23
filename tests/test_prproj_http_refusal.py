"""HTTP framing of the intentionally unsupported Premiere project endpoint."""
from __future__ import annotations

import io
import unittest
from email.message import Message
from unittest import mock

from tests.test_local_editor_server import server_editor


class PrprojHttpRefusalTests(unittest.TestCase):
    def handler(self, body=b'{}', **headers):
        handler = object.__new__(server_editor.EditorRequestHandler)
        handler.headers = Message()
        for key, value in {'Content-Length': str(len(body)), **headers}.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(body)
        handler.connection = mock.Mock()
        handler.connection.gettimeout.return_value = None
        return handler

    def test_refusal_consumes_body_before_responding_without_parsing_it(self):
        handler = self.handler(b'not even JSON')
        handler.path = '/api/prproj'
        def response(status, payload, **kwargs):
            self.assertEqual(handler.rfile.read(), b'')
            self.assertEqual(status, 501)
            self.assertEqual(payload, server_editor.PRPROJ_CAPABILITY)
            self.assertFalse(kwargs['close_connection'])
        handler.send_json = response
        handler.do_POST()
        waits = handler.connection.settimeout.call_args_list
        self.assertGreater(waits[0].args[0], 0)
        self.assertLessEqual(waits[0].args[0], 2.0)
        self.assertEqual(waits[-1], mock.call(None))

    def test_refusal_reads_only_declared_body_not_next_request(self):
        handler = self.handler(b'{}GET /api/prproj-capability HTTP/1.1\r\n',
                               **{'Content-Length': '2'})
        self.assertTrue(handler.discard_unsupported_request_body())
        self.assertTrue(handler.rfile.read().startswith(b'GET '))

    def test_invalid_or_oversized_framing_does_not_read(self):
        for headers in ({'Content-Length': 'bad'}, {'Content-Length': '-1'},
                        {'Content-Length': '65537'}, {'Transfer-Encoding': 'chunked'}):
            with self.subTest(headers=headers):
                handler = self.handler(**headers)
                self.assertFalse(handler.discard_unsupported_request_body())
                self.assertEqual(handler.rfile.tell(), 0)

    def test_incomplete_body_requires_close(self):
        handler = self.handler(b'{}', **{'Content-Length': '5'})
        self.assertFalse(handler.discard_unsupported_request_body())
        handler.path = '/api/prproj'
        handler.send_json = mock.Mock()
        handler.do_POST()
        self.assertTrue(handler.send_json.call_args.kwargs['close_connection'])

    def test_ambiguous_lengths_close_without_reading(self):
        handler = self.handler()
        handler.headers['Content-Length'] = '4'
        self.assertFalse(handler.discard_unsupported_request_body())
        self.assertEqual(handler.rfile.tell(), 0)

    def test_timeout_requires_close_and_restores_socket_timeout(self):
        handler = self.handler()
        handler.rfile = mock.Mock()
        handler.rfile.read1.side_effect = TimeoutError('partial body')
        self.assertFalse(handler.discard_unsupported_request_body())
        handler.connection.settimeout.assert_called_with(None)

    def test_slow_drip_cannot_extend_total_deadline(self):
        handler = self.handler(b'abcd')
        handler.rfile = mock.Mock()
        handler.rfile.read1.return_value = b'a'
        with mock.patch.object(server_editor.time, 'monotonic', side_effect=[0, 0, 0.8, 1.6, 2.4]):
            self.assertFalse(handler.discard_unsupported_request_body())
        self.assertEqual(handler.rfile.read1.call_count, 3)
        waits = [call.args[0] for call in handler.connection.settimeout.call_args_list]
        self.assertEqual(waits[0], 2.0)
        self.assertAlmostEqual(waits[1], 1.2)
        self.assertAlmostEqual(waits[2], 0.4)
        self.assertIsNone(waits[3])
