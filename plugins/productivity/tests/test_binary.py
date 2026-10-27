"""Binary files in and out of the productivity nodes, against fake service APIs (GitHub, Jira, Notion, Airtable, HubSpot, RSS)."""

from __future__ import annotations

import base64
import json
import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin, metric_value

PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256))  # bytes that are not valid UTF-8


def file_ref(raw: bytes, name: str, mime: str | None = None) -> dict:
    ref = {"fileName": name, "fileSize": len(raw), "data": base64.b64encode(raw).decode("ascii")}
    if mime:
        ref["mimeType"] = mime
    return ref


def with_file(raw: bytes, name: str, mime: str | None = None, prop: str = "data") -> dict:
    return {"json": {"id": 1}, "binary": {prop: file_ref(raw, name, mime)}}


def out_file(response: dict, index: int = 0, prop: str = "data") -> tuple[bytes, dict]:
    """(bytes, ref) of output item ``index``'s binary property."""
    if "error" in response:
        raise AssertionError(f"node failed: {response['error']}")
    ref = response["outputs"][0][index]["binary"][prop]
    return base64.b64decode(ref["data"]), ref


def parts(request: dict) -> list[tuple[dict, bytes]]:
    """Multipart body -> [(headers, content)] (the headers as a lower-case dict)."""
    boundary = request["headers"]["content-type"].split("boundary=")[1].encode()
    found = []
    for chunk in request["body"].split(b"--" + boundary)[1:]:
        if chunk.startswith(b"--"):
            break
        head, _, content = chunk.lstrip(b"\r\n").partition(b"\r\n\r\n")
        headers = dict(line.decode().split(": ", 1) for line in head.split(b"\r\n"))
        found.append(({k.lower(): v for k, v in headers.items()}, content[:-2]))
    return found


class GitHubBinaryTests(unittest.TestCase):
    REPO = "/repos/octo/demo"

    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()
        cls.cdn = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()
        cls.cdn.__exit__()

    def setUp(self):
        self.api.reset()
        self.cdn.reset()
        self.plugin = make_plugin()
        self.creds = {"githubApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "github", {"owner": "octo", "repository": "demo", **parameters}, credentials=self.creds, **kwargs)

    def test_download_file(self):
        self.api.route("GET", f"{self.REPO}/contents/img/logo.png", {"type": "file", "name": "logo.png", "sha": "abc", "encoding": "base64",
                                                                      "content": base64.encodebytes(PNG).decode()})
        response = self.run_node({"resource": "file", "operation": "download", "filePath": "img/logo.png", "fileOptions": {"reference": "dev"}})
        raw, ref = out_file(response)
        self.assertEqual(raw, PNG)
        self.assertEqual((ref["fileName"], ref["mimeType"], ref["fileType"]), ("logo.png", "image/png", "image"))
        self.assertEqual(jsons(response)[0], {"path": "img/logo.png", "name": "logo.png", "size": len(PNG), "sha": "abc", "ref": "dev"})
        self.assertEqual(self.api.requests[0]["query"], {"ref": ["dev"]})

    def test_download_large_file_and_directory(self):
        self.api.route("GET", f"{self.REPO}/contents/big.bin", lambda r: PNG if "raw" in r["headers"]["accept"] else {"type": "file", "name": "big.bin", "encoding": "none", "content": ""})
        raw, _ = out_file(self.run_node({"resource": "file", "operation": "download", "filePath": "big.bin", "outputBinaryName": "blob"}), prop="blob")
        self.assertEqual(raw, PNG)
        self.api.route("GET", f"{self.REPO}/contents/docs", [{"type": "file", "name": "a.md"}])
        self.assertIn("is a directory", self.run_node({"resource": "file", "operation": "download", "filePath": "docs"})["error"]["message"])

    def test_create_file_from_binary(self):
        self.api.route("GET", f"{self.REPO}/contents/out/report.png", (404, {"message": "Not Found"}))
        self.api.route("PUT", f"{self.REPO}/contents/out/report.png", lambda r: (201, {"content": {"path": "out/report.png", "sha": "new"}, "commit": {"sha": "c1"}}))
        response = self.run_node({"resource": "file", "operation": "createOrUpdate", "filePath": "out/report.png", "fileOptions": {"reference": "main"}},
                                 inputs=[with_file(PNG, "r.png")])
        put = self.api.calls("PUT")[0]["json"]
        self.assertEqual(base64.b64decode(put["content"]), PNG)
        self.assertEqual((put["message"], put["branch"], "sha" in put), ("Create out/report.png", "main", False))
        self.assertEqual(jsons(response)[0]["updated"], False)
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="github", operation="create"), 1)

    def test_update_existing_file_sends_its_sha(self):
        self.api.route("GET", f"{self.REPO}/contents/a.txt", {"type": "file", "sha": "old123"})
        self.api.route("PUT", f"{self.REPO}/contents/a.txt", {"content": {"sha": "new"}})
        response = self.run_node({"resource": "file", "operation": "createOrUpdate", "filePath": "a.txt", "commitMessage": "Refresh", "binaryPropertyName": "doc"},
                                 inputs=[with_file(b"hello", "a.txt", prop="doc")])
        put = self.api.calls("PUT")[0]["json"]
        self.assertEqual((put["sha"], put["message"], base64.b64decode(put["content"])), ("old123", "Refresh", b"hello"))
        self.assertTrue(jsons(response)[0]["updated"])

    def test_missing_binary_file_is_an_error(self):
        response = self.run_node({"resource": "file", "operation": "createOrUpdate", "filePath": "a.txt"}, inputs=[{"json": {}}])
        self.assertIn('no binary file "data"', response["error"]["message"])

    def test_upload_release_asset_to_the_release_upload_url(self):
        release = lambda r: {"id": 9, "tag_name": "v1", "upload_url": "{base}/uploads/repos/octo/demo/releases/9/assets{?name,label}"}  # noqa: E731
        self.api.route("GET", f"{self.REPO}/releases/tags/v1", lambda r: {**release(r), "upload_url": release(r)["upload_url"].replace("{base}", self.api.url)})
        self.api.route("POST", "/uploads/repos/octo/demo/releases/9/assets", (201, {"id": 77, "name": "app.zip", "size": len(PNG), "state": "uploaded"}))
        response = self.run_node({"resource": "release", "operation": "uploadAsset", "releaseRef": "v1", "assetOptions": {"label": "App bundle"}},
                                 inputs=[with_file(PNG, "app.zip")])
        call = self.api.calls("POST")[0]
        self.assertEqual(call["body"], PNG)
        self.assertEqual(call["headers"]["content-type"], "application/zip")
        self.assertEqual(call["query"], {"name": ["app.zip"], "label": ["App bundle"]})
        self.assertEqual(jsons(response)[0]["id"], 77)

    def test_download_asset_by_name_and_by_id(self):
        self.api.route("GET", f"{self.REPO}/releases/latest", {"id": 9, "tag_name": "v2", "assets": [{"id": 5, "name": "tool.tar.gz"}, {"id": 6, "name": "tool.zip"}]})
        self.api.route("GET", f"{self.REPO}/releases/assets/6", lambda r: PNG if r["headers"]["accept"] == "application/octet-stream"
                       else {"id": 6, "name": "tool.zip", "content_type": "application/zip"})
        raw, ref = out_file(self.run_node({"resource": "release", "operation": "downloadAsset", "assetRef": "tool.zip"}))
        self.assertEqual((raw, ref["fileName"], ref["mimeType"]), (PNG, "tool.zip", "application/zip"))
        by_id = self.run_node({"resource": "release", "operation": "downloadAsset", "assetRef": "6"})
        self.assertEqual(out_file(by_id)[0], PNG)
        missing = self.run_node({"resource": "release", "operation": "downloadAsset", "assetRef": "nope.zip"})
        self.assertIn("has no asset named 'nope.zip'", missing["error"]["message"])

    def test_asset_download_redirect_leaves_the_token_behind(self):
        self.cdn.route("GET", "/signed/asset", lambda r: PNG if "authorization" not in r["headers"] else (400, {"message": "token not allowed"}))
        self.api.route("GET", f"{self.REPO}/releases/assets/6", lambda r: (302, b"", {"Location": f"{self.cdn.url}/signed/asset"}) if r["headers"]["accept"] == "application/octet-stream"
                       else {"id": 6, "name": "tool.zip"})
        raw, _ = out_file(self.run_node({"resource": "release", "operation": "downloadAsset", "assetRef": "6"}))
        self.assertEqual(raw, PNG)
        self.assertEqual(self.api.calls("GET", f"{self.REPO}/releases/assets/6")[1]["headers"]["authorization"], f"Bearer {TOKEN}")

    def test_download_archive(self):
        self.api.route("GET", f"{self.REPO}/zipball/v1.0", (200, PNG, {"Content-Disposition": 'attachment; filename=octo-demo-abc123.zip'}))
        raw, ref = out_file(self.run_node({"resource": "repository", "operation": "downloadArchive", "archiveRef": "v1.0"}))
        self.assertEqual((raw, ref["fileName"], ref["mimeType"]), (PNG, "octo-demo-abc123.zip", "application/zip"))
        self.api.route("GET", f"{self.REPO}/tarball", PNG)
        _, tar = out_file(self.run_node({"resource": "repository", "operation": "downloadArchive", "archiveFormat": "tarball"}))
        self.assertEqual((tar["fileName"], tar["mimeType"]), ("demo-default.tar.gz", "application/gzip"))


class JiraBinaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()
        cls.media = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()
        cls.media.__exit__()

    def setUp(self):
        self.api.reset()
        self.media.reset()
        self.plugin = make_plugin()
        self.creds = {"jiraSoftwareCloudApi": {"email": "ada@example.com", "apiToken": TOKEN, "domain": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "jira", {"jiraVersion": "cloud", "resource": "issueAttachment", **parameters}, credentials=self.creds, **kwargs)

    def test_add_attachments_multipart(self):
        self.api.route("POST", "/rest/api/3/issue/PROJ-1/attachments", [{"id": "100", "filename": "a.png"}, {"id": "101", "filename": "notes.txt"}])
        item = {"json": {}, "binary": {"data": file_ref(PNG, "a.png"), "notes": file_ref(b"remember", "notes.txt", "text/plain")}}
        response = self.run_node({"operation": "add", "attachmentIssueKey": "PROJ-1", "binaryPropertyName": "data, notes"}, inputs=[item])
        self.assertEqual([j["id"] for j in jsons(response)], ["100", "101"])
        call = self.api.calls("POST")[0]
        self.assertEqual(call["headers"]["x-atlassian-token"], "no-check")
        self.assertTrue(call["headers"]["content-type"].startswith("multipart/form-data; boundary="))
        sent = parts(call)
        self.assertEqual([(h["content-disposition"], h["content-type"], c) for h, c in sent], [
            ('form-data; name="file"; filename="a.png"', "image/png", PNG),
            ('form-data; name="file"; filename="notes.txt"', "text/plain", b"remember"),
        ])
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="jira", operation="attach"), 2)

    def test_add_without_a_file_is_an_error(self):
        response = self.run_node({"operation": "add", "attachmentIssueKey": "PROJ-1"}, inputs=[{"json": {}}])
        self.assertIn('no binary file "data"', response["error"]["message"])

    def test_get_attachment_follows_the_media_redirect_without_the_token(self):
        self.api.route("GET", "/rest/api/3/attachment/100", {"id": "100", "filename": "a.png", "mimeType": "image/png", "size": len(PNG)})
        self.api.route("GET", "/rest/api/3/attachment/content/100", (303, b"", {"Location": f"{self.media.url}/file/100"}))
        self.media.route("GET", "/file/100", lambda r: PNG if "authorization" not in r["headers"] else (401, {"message": "no"}))
        response = self.run_node({"operation": "get", "attachmentId": "100", "outputBinaryName": "file"})
        raw, ref = out_file(response, prop="file")
        self.assertEqual((raw, ref["fileName"], ref["mimeType"]), (PNG, "a.png", "image/png"))
        self.assertEqual(jsons(response)[0]["id"], "100")

    def test_get_many_lists_and_optionally_downloads(self):
        attachments = [{"id": "1", "filename": "a.txt", "mimeType": "text/plain"}, {"id": "2", "filename": "b.txt", "mimeType": "text/plain"}]
        self.api.route("GET", "/rest/api/3/issue/PROJ-1", {"key": "PROJ-1", "fields": {"attachment": attachments}})
        self.api.route("GET", r"/rest/api/3/attachment/content/\d", lambda r: b"body " + r["path"][-1].encode())
        listed = self.run_node({"operation": "getAll", "attachmentIssueKey": "PROJ-1"})
        self.assertEqual([j["filename"] for j in jsons(listed)], ["a.txt", "b.txt"])
        self.assertNotIn("binary", listed["outputs"][0][0])
        self.assertEqual(self.api.requests[-1]["query"], {"fields": ["attachment"]})
        downloaded = self.run_node({"operation": "getAll", "attachmentIssueKey": "PROJ-1", "download": True})
        self.assertEqual([out_file(downloaded, n)[0] for n in range(2)], [b"body 1", b"body 2"])


class NotionBinaryTests(unittest.TestCase):
    PAGE = "0123456789abcdef0123456789abcdef"

    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.creds = {"notionApi": {"apiKey": TOKEN, "baseUrl": self.api.url}}
        self.api.route("POST", "/v1/file_uploads", lambda r: {"id": "up-1", "status": "pending", "upload_url": f"{self.api.url}/v1/file_uploads/up-1/send"})
        self.api.route("POST", "/v1/file_uploads/up-1/send", {"id": "up-1", "status": "uploaded"})

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "notion", parameters, credentials=self.creds, **kwargs)

    def test_append_an_image_block(self):
        self.api.route("PATCH", f"/v1/blocks/{self.PAGE}/children", lambda r: {"results": [{"id": "blk1", "type": "image"}]})
        response = self.run_node({"resource": "block", "operation": "appendFile", "blockId": self.PAGE, "caption": "Logo"}, inputs=[with_file(PNG, "logo.png")])
        self.assertEqual(self.api.calls("POST", "/v1/file_uploads")[0]["json"], {"filename": "logo.png", "content_type": "image/png"})
        send = self.api.calls("POST", "/v1/file_uploads/up-1/send")[0]
        ((headers, content),) = parts(send)
        self.assertEqual((headers["content-disposition"], content), ('form-data; name="file"; filename="logo.png"', PNG))
        self.assertEqual(send["headers"]["notion-version"], "2022-06-28")
        child = self.api.calls("PATCH")[0]["json"]["children"][0]
        self.assertEqual(child["type"], "image")
        self.assertEqual(child["image"]["file_upload"], {"id": "up-1"})
        self.assertEqual(child["image"]["caption"][0]["text"]["content"], "Logo")
        self.assertEqual((jsons(response)[0]["blockType"], jsons(response)[0]["fileUploadId"]), ("image", "up-1"))

    def test_block_type_follows_the_mime_type(self):
        self.api.route("PATCH", f"/v1/blocks/{self.PAGE}/children", {"results": []})
        for name, expected in (("a.pdf", "pdf"), ("a.mp3", "audio"), ("a.mp4", "video"), ("a.zip", "file")):
            self.run_node({"resource": "block", "operation": "appendFile", "blockId": self.PAGE}, inputs=[with_file(b"x", name)])
            self.assertEqual(self.api.calls("PATCH")[-1]["json"]["children"][0]["type"], expected, name)

    def test_attach_file_keeps_existing_files(self):
        existing = {"type": "files", "files": [{"name": "old.txt", "type": "external", "external": {"url": "https://x.test/old.txt"}, "id": "zz"}]}
        self.api.route("GET", f"/v1/pages/{self.PAGE}", {"object": "page", "id": self.PAGE, "properties": {"Attachments": existing}})
        self.api.route("PATCH", f"/v1/pages/{self.PAGE}", lambda r: {"object": "page", "id": self.PAGE, "properties": {}})
        self.run_node({"resource": "page", "operation": "attachFile", "pageId": self.PAGE, "propertyName": "Attachments"}, inputs=[with_file(b"pdf", "spec.pdf")])
        files = self.api.calls("PATCH")[0]["json"]["properties"]["Attachments"]["files"]
        self.assertEqual(files, [{"name": "old.txt", "type": "external", "external": {"url": "https://x.test/old.txt"}},
                                 {"name": "spec.pdf", "type": "file_upload", "file_upload": {"id": "up-1"}}])

    def test_attach_file_rejects_a_property_that_is_not_files(self):
        self.api.route("GET", f"/v1/pages/{self.PAGE}", {"properties": {"Name": {"type": "title", "title": []}}})
        response = self.run_node({"resource": "page", "operation": "attachFile", "pageId": self.PAGE, "propertyName": "Name"}, inputs=[with_file(b"x", "a.txt")])
        self.assertIn("not a Files property", response["error"]["message"])

    def test_replace_skips_the_lookup(self):
        self.api.route("PATCH", f"/v1/pages/{self.PAGE}", {"object": "page", "id": self.PAGE, "properties": {}})
        self.run_node({"resource": "page", "operation": "attachFile", "pageId": self.PAGE, "propertyName": "Files", "replaceFiles": True}, inputs=[with_file(b"x", "a.txt")])
        self.assertEqual(len(self.api.calls("PATCH")[0]["json"]["properties"]["Files"]["files"]), 1)
        self.assertEqual(self.api.calls("GET"), [])


class AirtableBinaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()
        cls.cdn = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()
        cls.cdn.__exit__()

    def setUp(self):
        self.api.reset()
        self.cdn.reset()
        self.plugin = make_plugin()
        self.creds = {"airtableTokenApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "airtable", {"resource": "attachment", "base": "appBase1", "attachmentRecordId": "rec1", "attachmentField": "Photos", **parameters},
                       credentials=self.creds, **kwargs)

    def test_upload_attachment_sends_base64_json(self):
        self.api.route("POST", "/v0/appBase1/rec1/Photos/uploadAttachment", lambda r: {"id": "rec1", "createdTime": "2026-10-25T10:00:00.000Z",
                                                                                        "fields": {"Photos": [{"id": "att1", "filename": r["json"]["filename"]}]}})
        response = self.run_node({"operation": "upload"}, inputs=[with_file(PNG, "cat.png")])
        body = self.api.calls("POST")[0]["json"]
        self.assertEqual((body["contentType"], body["filename"], base64.b64decode(body["file"])), ("image/png", "cat.png", PNG))
        self.assertEqual(jsons(response)[0]["Photos"][0]["id"], "att1")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="airtable", operation="upload"), 1)

    def test_upload_over_five_megabytes_is_refused(self):
        big = b"x" * (5 * 1000 * 1000 + 1)
        response = self.run_node({"operation": "upload"}, inputs=[{"json": {}, "binary": {"data": {"fileName": "big.bin", "fileSize": len(big), "data": base64.b64encode(big).decode()}}}])
        self.assertIn("up to 5 MB", response["error"]["message"])
        self.assertEqual(self.api.requests, [])

    def test_download_every_attachment_of_a_field(self):
        self.api.route("GET", "/v0/appBase1/tblTasks/rec1", {"id": "rec1", "fields": {"Photos": [
            {"id": "att1", "filename": "cat.png", "type": "image/png", "url": f"{self.cdn.url}/f/att1"},
            {"id": "att2", "filename": "dog.txt", "type": "text/plain", "url": f"{self.cdn.url}/f/att2"}]}})
        self.cdn.route("GET", r"/f/att\d", lambda r: PNG if r["path"].endswith("1") else b"woof")
        response = self.run_node({"operation": "download", "table": "tblTasks", "outputBinaryName": "file"})
        self.assertEqual([j["filename"] for j in jsons(response)], ["cat.png", "dog.txt"])
        self.assertEqual([out_file(response, n, "file")[0] for n in range(2)], [PNG, b"woof"])
        self.assertTrue(all("authorization" not in r["headers"] for r in self.cdn.requests))  # the token never goes to the CDN

    def test_download_empty_and_wrong_field(self):
        self.api.route("GET", "/v0/appBase1/tblTasks/rec1", {"id": "rec1", "fields": {"Name": "x"}})
        self.assertEqual(self.run_node({"operation": "download", "table": "tblTasks"})["outputs"][0], [])
        self.api.route("GET", "/v0/appBase1/tblTasks/rec1", {"id": "rec1", "fields": {"Photos": "text"}})
        self.assertIn("not an attachment field", self.run_node({"operation": "download", "table": "tblTasks"})["error"]["message"])

    def test_records_still_work_next_to_attachments(self):
        self.api.route("GET", "/v0/appBase1/tblTasks/rec9", {"id": "rec9", "fields": {"Name": "x"}})
        response = execute(self.plugin, "airtable", {"base": "appBase1", "table": "tblTasks", "operation": "get", "id": "rec9"}, credentials=self.creds)
        self.assertEqual(jsons(response)[0]["Name"], "x")


class HubSpotBinaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()
        cls.cdn = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()
        cls.cdn.__exit__()

    def setUp(self):
        self.api.reset()
        self.cdn.reset()
        self.plugin = make_plugin()
        self.creds = {"hubspotAppToken": {"appToken": TOKEN, "baseUrl": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "hubspot", {"resource": "file", **parameters}, credentials=self.creds, **kwargs)

    def test_upload_to_the_file_manager(self):
        self.api.route("POST", "/files/v3/files", (201, {"id": "555", "name": "report", "extension": "pdf", "access": "PRIVATE"}))
        response = self.run_node({"operation": "upload", "fileOptions": {"folderPath": "/landflow", "access": "PUBLIC_NOT_INDEXABLE", "overwrite": True}},
                                 inputs=[with_file(b"%PDF-1.7 data", "report.pdf")])
        sent = {h["content-disposition"].split('name="')[1].split('"')[0]: (h, c) for h, c in parts(self.api.calls("POST")[0])}
        self.assertEqual(sent["file"][1], b"%PDF-1.7 data")
        self.assertEqual(sent["file"][0]["content-type"], "application/pdf")
        self.assertEqual(sent["folderPath"][1], b"/landflow")
        self.assertEqual(sent["fileName"][1], b"report.pdf")
        self.assertEqual(json.loads(sent["options"][1]), {"access": "PUBLIC_NOT_INDEXABLE", "overwrite": True, "duplicateValidationStrategy": "NONE",
                                                          "duplicateValidationScope": "EXACT_FOLDER"})
        self.assertEqual(jsons(response)[0]["id"], "555")

    def test_get_file_details_only(self):
        self.api.route("GET", "/files/v3/files/555", {"id": "555", "name": "report", "access": "PRIVATE"})
        response = self.run_node({"operation": "get", "fileId": "555"})
        self.assertEqual(jsons(response), [{"id": "555", "name": "report", "access": "PRIVATE"}])
        self.assertNotIn("binary", response["outputs"][0][0])

    def test_download_a_private_file_through_its_signed_url(self):
        self.api.route("GET", "/files/v3/files/555", {"id": "555", "name": "report", "extension": "pdf", "access": "PRIVATE", "url": "https://private.hubspot.test/x"})
        self.api.route("GET", "/files/v3/files/555/signed-url", {"url": f"{self.cdn.url}/signed/555?sig=1", "expiresAt": "2026-10-28T00:00:00Z"})
        self.cdn.route("GET", "/signed/555", (200, b"%PDF-1.7 data", {"Content-Type": "application/pdf"}))
        response = self.run_node({"operation": "get", "fileId": "555", "download": True})
        raw, ref = out_file(response)
        self.assertEqual((raw, ref["fileName"], ref["mimeType"]), (b"%PDF-1.7 data", "report.pdf", "application/pdf"))
        self.assertEqual(self.cdn.requests[0]["headers"].get("authorization"), None)

    def test_download_a_public_file_from_its_url(self):
        self.api.route("GET", "/files/v3/files/9", lambda r: {"id": "9", "name": "logo.png", "access": "PUBLIC_INDEXABLE", "url": f"{self.cdn.url}/public/logo.png"})
        self.cdn.route("GET", "/public/logo.png", PNG)
        raw, ref = out_file(self.run_node({"operation": "get", "fileId": "9", "download": True}))
        self.assertEqual((raw, ref["fileName"]), (PNG, "logo.png"))
        self.assertEqual(self.api.calls("GET", "/files/v3/files/9/signed-url"), [])


class RssBinaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.feed = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.feed.__exit__()

    def setUp(self):
        self.feed.reset()
        self.plugin = make_plugin()
        xml = (f'<?xml version="1.0"?><rss version="2.0"><channel><title>Pod</title>'
               f'<item><title>Ep 1</title><guid>1</guid><enclosure url="{self.feed.url}/media/ep1.mp3" length="{len(PNG)}" type="audio/mpeg"/></item>'
               f'<item><title>Ep 2 (text only)</title><guid>2</guid></item>'
               f'<item><title>Ep 3</title><guid>3</guid><enclosure url="{self.feed.url}/media/ep3" length="0" type="image/png"/></item>'
               f'</channel></rss>')
        self.feed.route("GET", "/feed.xml", (200, xml, {"Content-Type": "application/rss+xml"}))
        self.feed.route("GET", "/media/ep1.mp3", (200, PNG, {"Content-Type": "application/octet-stream"}))
        self.feed.route("GET", "/media/ep3", (200, b"img", {"Content-Type": "image/png"}))

    def run_node(self, options):
        return execute(self.plugin, "rssFeedRead", {}, item_parameters=[{"url": f"{self.feed.url}/feed.xml", "options": options}])

    def test_enclosures_are_not_downloaded_by_default(self):
        response = self.run_node({})
        self.assertEqual(len(jsons(response)), 3)
        self.assertTrue(all("binary" not in item for item in response["outputs"][0]))
        self.assertEqual(self.feed.calls("GET", "/media/ep1.mp3"), [])

    def test_download_enclosures_into_binary(self):
        response = self.run_node({"downloadEnclosures": True, "binaryPropertyName": "media"})
        items = response["outputs"][0]
        self.assertEqual([i["json"]["title"] for i in items], ["Ep 1", "Ep 2 (text only)", "Ep 3"])
        raw, ref = out_file(response, 0, "media")
        self.assertEqual((raw, ref["fileName"], ref["mimeType"], ref["fileType"]), (PNG, "ep1.mp3", "audio/mpeg", "audio"))
        self.assertNotIn("binary", items[1])
        _, third = out_file(response, 2, "media")
        self.assertEqual((third["fileName"], third["mimeType"]), ("ep3.png", "image/png"))  # no extension in the URL: from the MIME type
        self.assertNotIn("authorization", self.feed.calls("GET", "/media/ep1.mp3")[0]["headers"])

    def test_size_limit_and_failed_download(self):
        too_big = self.run_node({"downloadEnclosures": True, "maxEnclosureMb": 0.0001})
        self.assertIn("the limit is 0 MB", too_big["error"]["message"])
        self.feed.route("GET", "/media/ep1.mp3", (404, "gone"))
        failed = self.run_node({"downloadEnclosures": True})
        self.assertIn("Enclosure request failed (HTTP 404", failed["error"]["message"])
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="rss", status_class="4xx"), 1)


if __name__ == "__main__":
    unittest.main()
