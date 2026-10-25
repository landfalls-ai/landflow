"""Binary data (docs/protocol.md §11): the ctx helpers against a fake host binary API, output normalization and the
gRPC conversions. Run:

    python3 -m unittest discover -s sdks/python/tests
"""

from __future__ import annotations

import base64
import io
import json
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk import MAX_INLINE_BINARY_BYTES, Node, NodeOperationError, Plugin, ProtocolError, file_type_of, mime_type_from_file_name  # noqa: E402
from landflow_sdk.binary import complete_binary_ref, extension_from_mime_type, file_extension_of  # noqa: E402
from landflow_sdk.context import ExecuteContext  # noqa: E402
from landflow_sdk.http_server import HttpPluginServer  # noqa: E402

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None

TOKEN = "lfb1.test-token"


class FakeHost:
    """The host's binary API: ``GET /api/binary/<id>`` and ``POST /api/binary``, bearer token checked."""

    def __init__(self) -> None:
        self.files: dict[str, tuple[bytes, dict]] = {}
        self.uploads: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _send(self, status: int, payload: object = None, body: bytes | None = None, content_type: str = "application/json") -> None:
                data = body if body is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authorized(self) -> bool:
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    self._send(401, {"error": "missing or invalid binary token"})
                    return False
                return True

            def _body(self) -> tuple[bytes, bool]:
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    chunks = []
                    while True:
                        size = int(self.rfile.readline().strip().split(b";")[0], 16)
                        if size == 0:
                            self.rfile.readline()
                            return b"".join(chunks), True
                        chunks.append(self.rfile.read(size))
                        self.rfile.readline()
                return self.rfile.read(int(self.headers.get("Content-Length") or 0)), False

            def do_GET(self) -> None:  # noqa: N802
                if not self._authorized():
                    return
                file_id = urllib.parse.unquote(self.path.rsplit("/", 1)[-1])
                if file_id not in outer.files:
                    self._send(404, {"error": "Binary file not found"})
                    return
                data, meta = outer.files[file_id]
                self._send(200, body=data, content_type=meta["mimeType"])

            def do_POST(self) -> None:  # noqa: N802
                body, chunked = self._body()
                if not self._authorized():
                    return
                name = urllib.parse.unquote(self.headers.get("X-Landflow-File-Name") or "")
                file_id = f"ex_test.file{len(outer.files):08d}"
                ref = complete_binary_ref({"id": file_id, "mimeType": self.headers.get("Content-Type") or "application/octet-stream", "fileSize": len(body), **({"fileName": name} if name else {})})
                outer.files[file_id] = (body, ref)
                outer.uploads.append({"name": name, "chunked": chunked, "length": self.headers.get("Content-Length"), "size": len(body), "type": self.headers.get("Content-Type")})
                self._send(201, ref)

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/api/binary"
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def put(self, file_id: str, data: bytes, mime: str = "application/octet-stream", name: str | None = None) -> dict:
        ref = complete_binary_ref({"id": file_id, "mimeType": mime, "fileSize": len(data), **({"fileName": name} if name else {})})
        self.files[file_id] = (data, ref)
        return ref

    def __enter__(self) -> "FakeHost":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _descriptor(name: str) -> dict:
    return {
        "name": name, "displayName": name.title(), "description": "test", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }


class Upper(Node):
    """Reads each item's file, writes an uppercased copy as a new file."""

    description = _descriptor("upper")

    def execute(self, ctx):
        out = []
        for i, item in enumerate(ctx.get_input_data()):
            data = ctx.get_binary_bytes(i)
            ref = ctx.prepare_binary_data(data.upper(), "upper.txt")
            out.append({"json": {"size": len(data)}, "binary": {"data": ref}})
        return out


class Raw(Node):
    """Returns whatever ``binary`` the test put in its parameter."""

    description = _descriptor("raw")

    def execute(self, ctx):
        return [{"json": {}, "binary": ctx.get_node_parameter("binary")}]


PLUGIN = Plugin("bin-plugin", "Binary", "1.0.0", nodes=[Upper(), Raw()])


def _request(node_type: str, items: list[dict], access: dict | None = None, parameters: dict | None = None) -> dict:
    request = {
        "protocol": "landflow.plugin/v1",
        "executionId": "ex_test",
        "mode": "manual",
        "node": {"id": "n1", "name": "N", "type": node_type, "typeVersion": 1},
        "parameters": parameters or {},
        "itemParameters": [],
        "inputs": [items],
    }
    if access is not None:
        request["binaryAccess"] = access
    return request


def _ctx(items: list[dict], access: dict | None) -> ExecuteContext:
    return ExecuteContext(_request("bin-plugin.upper", items, access), _descriptor("upper"))


class MimeTests(unittest.TestCase):
    def test_tables_match_the_protocol(self):
        self.assertEqual(mime_type_from_file_name("report.CSV"), "text/csv")
        self.assertEqual(mime_type_from_file_name("photo.jpeg"), "image/jpeg")
        self.assertEqual(mime_type_from_file_name("noext"), "application/octet-stream")
        self.assertEqual(file_extension_of("dir/a.tar.gz"), "gz")
        self.assertIsNone(file_extension_of(".hidden"))
        self.assertEqual(extension_from_mime_type("text/plain; charset=utf-8"), "txt")
        self.assertEqual(extension_from_mime_type("image/jpeg"), "jpg")
        cases = {"image/png": "image", "application/pdf": "pdf", "text/html": "html", "application/json": "json",
                 "application/ld+json": "json", "text/csv": "text", "application/xml": "text", "audio/mpeg": "audio",
                 "video/mp4": "video", "application/zip": "other"}
        for mime, kind in cases.items():
            self.assertEqual(file_type_of(mime), kind, mime)
        self.assertEqual(complete_binary_ref({"fileName": "x.pdf", "mimeType": "application/octet-stream", "fileSize": 1}),
                         {"fileName": "x.pdf", "mimeType": "application/pdf", "fileExtension": "pdf", "fileType": "pdf", "fileSize": 1})


class HelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = FakeHost().__enter__()
        cls.access = {"url": cls.host.url, "token": TOKEN}

    @classmethod
    def tearDownClass(cls):
        cls.host.__exit__()

    def setUp(self):
        self.host.uploads.clear()

    def test_small_files_are_inline(self):
        ref = _ctx([], self.access).prepare_binary_data(b"a,b\n1,2\n", "data.csv")
        self.assertEqual(ref, {"mimeType": "text/csv", "fileName": "data.csv", "fileExtension": "csv", "fileType": "text",
                               "fileSize": 8, "data": base64.b64encode(b"a,b\n1,2\n").decode()})
        self.assertEqual(self.host.uploads, [])
        self.assertEqual(_ctx([], None).prepare_binary_data("héllo")["fileSize"], 6)  # str as UTF-8, no host needed
        self.assertEqual(_ctx([], None).prepare_binary_data(b"x", mime_type="image/png")["fileType"], "image")

    def test_big_files_are_uploaded(self):
        data = bytes(range(256)) * 400  # 100 KiB
        ref = _ctx([], self.access).prepare_binary_data(data, "räport 1.pdf")
        self.assertTrue(ref["id"].startswith("ex_test."))
        self.assertEqual((ref["fileName"], ref["mimeType"], ref["fileSize"]), ("räport 1.pdf", "application/pdf", len(data)))
        upload = self.host.uploads[-1]
        self.assertEqual((upload["name"], upload["type"], upload["size"], upload["chunked"]), ("räport 1.pdf", "application/pdf", len(data), False))
        self.assertEqual(self.host.files[ref["id"]][0], data)

    def test_file_objects_stream(self):
        data = b"z" * (MAX_INLINE_BINARY_BYTES + 10)
        ctx = _ctx([], self.access)
        ref = ctx.prepare_binary_data(io.BytesIO(data), "seekable.bin")
        self.assertEqual(self.host.uploads[-1]["length"], str(len(data)))

        class Pipe(io.RawIOBase):  # not seekable: sent chunked
            def __init__(self, payload: bytes):
                self._stream = io.BytesIO(payload)

            def readable(self):
                return True

            def readinto(self, buffer):
                chunk = self._stream.read(len(buffer))
                buffer[: len(chunk)] = chunk
                return len(chunk)

        ref2 = ctx.prepare_binary_data(io.BufferedReader(Pipe(b"small too")), "pipe.txt")
        self.assertEqual((self.host.uploads[-1]["chunked"], self.host.uploads[-1]["size"]), (True, 9))
        self.assertEqual(self.host.files[ref["id"]][0], data)
        self.assertEqual(self.host.files[ref2["id"]][0], b"small too")
        # Without binaryAccess a small file object comes back inline, a big one fails clearly.
        self.assertEqual(base64.b64decode(_ctx([], None).prepare_binary_data(io.BytesIO(b"tiny"), "t.txt")["data"]), b"tiny")
        with self.assertRaises(NodeOperationError) as caught:
            _ctx([], None).prepare_binary_data(io.BytesIO(data), "big.bin")
        self.assertIn("no binaryAccess", caught.exception.message)

    def test_reading(self):
        stored = self.host.put("ex_prev.abcdefgh1234", b"%PDF-1.7 bytes", "application/pdf", "in.pdf")
        inline = {"mimeType": "text/plain", "fileSize": 2, "data": base64.b64encode(b"hi").decode()}
        ctx = _ctx([{"json": {}, "binary": {"data": stored, "note": inline}}], self.access)
        self.assertEqual(ctx.assert_binary_data(0)["fileName"], "in.pdf")
        self.assertEqual(ctx.get_binary_bytes(0), b"%PDF-1.7 bytes")
        self.assertEqual(ctx.get_binary_bytes(0, "note"), b"hi")
        self.assertEqual(ctx.read_binary(stored), b"%PDF-1.7 bytes")
        with ctx.open_binary_stream(0) as stream:
            self.assertEqual(stream.read(4) + stream.read(), b"%PDF-1.7 bytes")
        with ctx.open_binary_stream(0, "note") as stream:
            self.assertEqual(stream.read(), b"hi")

    def test_errors(self):
        ctx = _ctx([{"json": {}, "binary": {"other": {"id": "ex_x.missing123", "mimeType": "text/plain", "fileSize": 1}}}, {"json": {}}], self.access)
        with self.assertRaises(NodeOperationError) as caught:
            ctx.assert_binary_data(0)
        self.assertEqual((caught.exception.message, caught.exception.item_index), ('item 0 has no binary file "data"', 0))
        self.assertIn("'other'", caught.exception.description)
        with self.assertRaises(NodeOperationError) as caught:
            ctx.get_binary_bytes(1)
        self.assertEqual(caught.exception.description, "The item carries no files.")
        with self.assertRaises(NodeOperationError):
            ctx.assert_binary_data(5)
        with self.assertRaises(NodeOperationError) as caught:
            ctx.get_binary_bytes(0, "other")
        self.assertIn("HTTP 404", caught.exception.message)
        self.assertEqual(caught.exception.description, "Binary file not found")
        with self.assertRaises(NodeOperationError) as caught:
            ctx.open_binary_stream(0, "other")
        self.assertIn("HTTP 404", caught.exception.message)
        bad = _ctx([{"json": {}, "binary": {"data": self.host.put("ex_y.abcdefgh", b"x")}}], {"url": self.host.url, "token": "wrong"})
        with self.assertRaises(NodeOperationError) as caught:
            bad.get_binary_bytes(0)
        self.assertIn("HTTP 401", caught.exception.message)
        with self.assertRaises(NodeOperationError) as caught:
            _ctx([{"json": {}, "binary": {"data": {"id": "ex_y.abcdefgh", "mimeType": "x", "fileSize": 1}}}], None).get_binary_bytes(0)
        self.assertIn("no binaryAccess", caught.exception.message)

    def test_node_round_trip_over_http(self):
        stored = self.host.put("ex_prev.qwertyuiop", b"hello " * 20000, "text/plain", "in.txt")
        server = HttpPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        try:
            import urllib.request

            body = json.dumps(_request("bin-plugin.upper", [{"json": {}, "binary": {"data": stored}}], self.access)).encode()
            with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{server.port}/landflow/v1/execute", data=body), timeout=10) as raw:
                response = json.loads(raw.read())
        finally:
            server.stop()
        item = response["outputs"][0][0]
        self.assertEqual(item["json"], {"size": 120000})
        self.assertEqual(self.host.files[item["binary"]["data"]["id"]][0], b"HELLO " * 20000)
        self.assertEqual(item["pairedItem"], {"item": 0})


class OutputTests(unittest.TestCase):
    def test_outputs_keep_binary(self):
        response = PLUGIN.execute(_request("bin-plugin.raw", [{"json": {}}], parameters={"binary": {"data": {"id": "ex_a.abcdefgh", "mimeType": "image/png", "fileSize": 3}}}))
        self.assertEqual(response["outputs"][0][0]["binary"], {"data": {"id": "ex_a.abcdefgh", "mimeType": "image/png", "fileSize": 3}})

    def test_inline_bytes_and_missing_mime_are_filled_in(self):
        class Bytes(Node):
            description = _descriptor("bytes")

            def execute(self, ctx):
                return [{"json": {}, "binary": {"data": {"data": b"raw", "fileName": "a.json"}}}]

        ref = Plugin("p", "P", "1", nodes=[Bytes()]).execute(_request("p.bytes", []))["outputs"][0][0]["binary"]["data"]
        self.assertEqual(ref, {"data": base64.b64encode(b"raw").decode(), "fileName": "a.json", "mimeType": "application/json", "fileExtension": "json", "fileType": "json"})

    def test_invalid_binary_is_an_error(self):
        response = PLUGIN.execute(_request("bin-plugin.raw", [], parameters={"binary": {"data": {"mimeType": "text/plain"}}}))
        self.assertIn("needs an 'id' or inline 'data'", response["error"]["message"])
        response = PLUGIN.execute(_request("bin-plugin.raw", [], parameters={"binary": ["nope"]}))
        self.assertIn("binary must be a dict", response["error"]["message"])

    def test_binary_access_is_validated(self):
        with self.assertRaises(ProtocolError):
            PLUGIN.execute(_request("bin-plugin.raw", [], access="http://nope"))  # type: ignore[arg-type]


@unittest.skipIf(grpc_server is None, "grpc extra not installed")
class GrpcBinaryTests(unittest.TestCase):
    def test_round_trip(self):
        ref = {"id": "ex_a.abcdefgh", "mimeType": "image/png", "fileName": "p.png", "fileSize": 3, "fileType": "image"}
        request = _request("bin-plugin.raw", [{"json": {"n": 1}, "binary": {"data": ref}}, {"json": {"n": 2}}], {"url": "http://h/api/binary", "token": TOKEN})
        decoded = grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(request))
        self.assertEqual(decoded["inputs"], request["inputs"])
        self.assertEqual(decoded["binaryAccess"], {"url": "http://h/api/binary", "token": TOKEN})
        self.assertNotIn("binaryAccess", grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(_request("x.y", []))))
        self.assertNotIn("binary", decoded["inputs"][0][1])
        response = {"outputs": [[{"json": {}, "binary": {"data": ref}}, {"json": {}}]], "logs": []}
        back = grpc_server.execute_response_from_proto(grpc_server.execute_response_to_proto(response))
        self.assertEqual(back["outputs"][0][0]["binary"], {"data": ref})
        self.assertNotIn("binary", back["outputs"][0][1])


if __name__ == "__main__":
    unittest.main()
