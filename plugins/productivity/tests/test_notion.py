"""Notion node against a fake Notion API."""

from __future__ import annotations

import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin, metric_value, paired

from productivity.notion import page_id, property_value, simplify_page


def page(n: int, title: str = "Task") -> dict:
    return {
        "object": "page", "id": f"page-{n}", "url": f"https://www.notion.so/p{n}", "archived": False,
        "properties": {
            "Task": {"type": "title", "title": [{"plain_text": f"{title} {n}"}]},
            "Status": {"type": "select", "select": {"name": "Doing"}},
            "Points": {"type": "number", "number": n},
        },
    }


class NotionTests(unittest.TestCase):
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

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "notion", parameters, credentials=self.creds, **kwargs)

    # ------------------------------------------------------------ credential

    def test_credential_test(self):
        self.api.route("GET", "/v1/users/me", lambda r: {"object": "user", "id": "u1", "name": "Landflow Bot"}
                       if r["headers"]["authorization"] == f"Bearer {TOKEN}" else
                       (401, {"object": "error", "status": 401, "code": "unauthorized", "message": "API token is invalid."}))
        ok = self.plugin.test_credentials("notionApi", {"apiKey": TOKEN, "baseUrl": self.api.url})
        self.assertEqual(ok, {"ok": True, "message": "authenticated as Landflow Bot"})
        self.assertEqual(self.api.requests[-1]["headers"]["notion-version"], "2022-06-28")
        bad = self.plugin.test_credentials("productivity.notionApi", {"apiKey": "wrong-token", "baseUrl": self.api.url})
        self.assertFalse(bad["ok"])
        self.assertIn("HTTP 401", bad["message"])
        self.assertIn("API token is invalid.", bad["message"])

    # --------------------------------------------------------- database page

    def test_create_database_page(self):
        self.api.route("GET", "/v1/databases/db1", {"object": "database", "properties": {
            "Task": {"type": "title"}, "Status": {"type": "select"}, "Notes": {"type": "rich_text"}}})
        self.api.route("POST", "/v1/pages", lambda r: {**page(7), "properties": {
            "Task": {"type": "title", "title": [{"plain_text": "Write docs"}]},
            "Tags": {"type": "multi_select", "multi_select": [{"name": "a"}, {"name": "b"}]},
            "Done": {"type": "checkbox", "checkbox": True},
        }})
        response = self.run_node({
            "resource": "databasePage", "operation": "create", "databaseId": "db1", "title": "Write docs",
            "propertiesUi": {"propertyValues": [
                {"key": "Status", "type": "select", "value": "Doing"},
                {"key": "Points", "type": "number", "value": "3"},
                {"key": "Done", "type": "checkbox", "value": "true"},
                {"key": "Due", "type": "date", "value": "2026-11-01"},
                {"key": "Link", "type": "url", "value": "https://example.com"},
                {"key": "Notes", "type": "text", "value": "hello"},
            ]},
            "propertiesJson": '{"Tags": {"multi_select": [{"name": "a"}, {"name": "b"}]}}',
        })
        body = self.api.calls("POST", "/v1/pages")[0]["json"]
        self.assertEqual(body["parent"], {"database_id": "db1"})
        props = body["properties"]
        self.assertEqual(props["Task"], {"title": [{"type": "text", "text": {"content": "Write docs"}}]})
        self.assertEqual(props["Status"], {"select": {"name": "Doing"}})
        self.assertEqual(props["Points"], {"number": 3})
        self.assertEqual(props["Done"], {"checkbox": True})
        self.assertEqual(props["Due"], {"date": {"start": "2026-11-01"}})
        self.assertEqual(props["Link"], {"url": "https://example.com"})
        self.assertEqual(props["Notes"], {"rich_text": [{"type": "text", "text": {"content": "hello"}}]})
        self.assertEqual(props["Tags"], {"multi_select": [{"name": "a"}, {"name": "b"}]})
        self.assertEqual(jsons(response), [{"id": "page-7", "name": "Write docs", "url": "https://www.notion.so/p7",
                                             "Task": "Write docs", "Tags": ["a", "b"], "Done": True}])
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="notion", operation="create"), 1)

    def test_query_database_return_all_paginates(self):
        def query(r):
            if r["json"].get("start_cursor") == "c2":
                return {"object": "list", "results": [page(3)], "has_more": False, "next_cursor": None}
            return {"object": "list", "results": [page(1), page(2)], "has_more": True, "next_cursor": "c2"}

        self.api.route("POST", "/v1/databases/db1/query", query)
        response = self.run_node({
            "resource": "databasePage", "operation": "getAll", "databaseId": "db1", "returnAll": True,
            "filterJson": '{"property": "Status", "select": {"equals": "Doing"}}',
            "sortsJson": [{"property": "Points", "direction": "ascending"}],
        })
        self.assertEqual([p["id"] for p in jsons(response)], ["page-1", "page-2", "page-3"])
        self.assertEqual(jsons(response)[0], {"id": "page-1", "name": "Task 1", "url": "https://www.notion.so/p1",
                                              "Task": "Task 1", "Status": "Doing", "Points": 1})
        first, second = self.api.calls("POST")
        self.assertEqual(first["json"]["filter"], {"property": "Status", "select": {"equals": "Doing"}})
        self.assertEqual(first["json"]["sorts"], [{"property": "Points", "direction": "ascending"}])
        self.assertEqual((first["json"]["page_size"], "start_cursor" in first["json"]), (100, False))
        self.assertEqual(second["json"]["start_cursor"], "c2")

    def test_query_with_limit_and_raw_output(self):
        self.api.route("POST", "/v1/databases/db1/query", {"results": [page(1), page(2)], "has_more": True, "next_cursor": "c2"})
        response = self.run_node({"resource": "databasePage", "operation": "getAll", "databaseId": "db1", "limit": 2, "simplify": False})
        self.assertEqual(len(self.api.requests), 1)
        self.assertEqual(self.api.requests[0]["json"]["page_size"], 2)
        self.assertEqual(jsons(response)[0]["properties"]["Points"], {"type": "number", "number": 1})

    # ------------------------------------------------------------------ page

    def test_get_and_archive_page_by_url(self):
        self.api.route("GET", "/v1/pages/0123456789abcdef0123456789abcdef", page(5))
        self.api.route("PATCH", "/v1/pages/0123456789abcdef0123456789abcdef", lambda r: {**page(5), "archived": r["json"]["archived"]})
        url = "https://www.notion.so/team/My-page-0123456789abcdef0123456789abcdef?pvs=4"
        got = self.run_node({"resource": "page", "operation": "get", "pageId": url})
        self.assertEqual(jsons(got)[0]["name"], "Task 5")
        archived = self.run_node({"resource": "page", "operation": "archive", "pageId": url, "simplify": False})
        self.assertTrue(jsons(archived)[0]["archived"])
        self.assertEqual(self.api.calls("PATCH")[0]["json"], {"archived": True})
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="notion", operation="archive"), 1)

    def test_search(self):
        db = {"object": "database", "id": "db9", "url": "https://www.notion.so/db9", "title": [{"plain_text": "Roadmap"}]}
        self.api.route("POST", "/v1/search", {"results": [page(1), db], "has_more": True, "next_cursor": "x"})
        response = self.run_node({"resource": "page", "operation": "search", "text": "road", "limit": 2,
                                  "searchOptions": {"objectType": "page", "sortDirection": "ascending"}})
        body = self.api.requests[0]["json"]
        self.assertEqual(body, {"query": "road", "filter": {"property": "object", "value": "page"},
                                "sort": {"direction": "ascending", "timestamp": "last_edited_time"}, "page_size": 2})
        self.assertEqual(jsons(response)[1], {"id": "db9", "name": "Roadmap", "url": "https://www.notion.so/db9", "object": "database"})

    # ----------------------------------------------------------------- block

    def test_append_paragraphs(self):
        self.api.route("PATCH", "/v1/blocks/page-1/children", lambda r: {"results": [{"id": f"b{n}"} for n, _ in enumerate(r["json"]["children"])]})
        response = self.run_node({"resource": "block", "operation": "append", "blockId": "page-1", "blockText": "First line\nsame paragraph\n\nSecond"})
        children = self.api.requests[0]["json"]["children"]
        self.assertEqual([c["paragraph"]["rich_text"][0]["text"]["content"] for c in children], ["First line\nsame paragraph", "Second"])
        self.assertEqual(jsons(response)[0]["appended"], 2)
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="notion", operation="append"), 2)

    def test_append_blocks_json_in_chunks_of_100(self):
        self.api.route("PATCH", "/v1/blocks/page-1/children", lambda r: {"results": r["json"]["children"]})
        blocks = [{"type": "to_do", "to_do": {"rich_text": [{"text": {"content": f"t{n}"}}]}} for n in range(150)]
        response = self.run_node({"resource": "block", "operation": "append", "blockId": "page-1", "blockSource": "json", "blocksJson": blocks})
        self.assertEqual([len(r["json"]["children"]) for r in self.api.requests], [100, 50])
        self.assertEqual(len(jsons(response)[0]["results"]), 150)

    # --------------------------------------------------------- errors, items

    def test_api_error_is_mapped_per_item(self):
        self.api.route("GET", "/v1/pages/good", page(1))
        self.api.route("GET", "/v1/pages/missing", (404, {"object": "error", "status": 404, "code": "object_not_found",
                                                          "message": "Could not find page with ID: missing."}))
        response = self.run_node({"resource": "page", "operation": "get"}, inputs=[{"json": {}}, {"json": {}}],
                                 item_parameters=[{"pageId": "good"}, {"pageId": "missing"}])
        self.assertEqual(response["error"]["message"], "Notion API error (HTTP 404): Could not find page with ID: missing.")
        self.assertEqual(response["error"]["itemIndex"], 1)
        self.assertNotIn(TOKEN, str(response))
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="notion", status_class="4xx"), 1)

    def test_items_are_paired(self):
        self.api.route("GET", r"/v1/pages/p\d", lambda r: page(int(r["path"][-1])))
        response = self.run_node({"resource": "page", "operation": "get"}, inputs=[{"json": {}}] * 3,
                                 item_parameters=[{"pageId": "p1"}, {"pageId": "p2"}, {"pageId": "p3"}])
        self.assertEqual(paired(response), [0, 1, 2])
        self.assertEqual([j["Points"] for j in jsons(response)], [1, 2, 3])

    def test_invalid_json_parameter(self):
        response = self.run_node({"resource": "databasePage", "operation": "getAll", "databaseId": "db1", "filterJson": "{nope"})
        self.assertIn("'Filter (JSON)' is not valid JSON", response["error"]["message"])

    def test_load_databases(self):
        self.api.route("POST", "/v1/search", {"results": [
            {"object": "database", "id": "db2", "title": [{"plain_text": "Tasks"}], "url": "u2"},
            {"object": "database", "id": "db1", "title": [{"plain_text": "Bugs"}], "url": "u1"},
        ], "has_more": False})
        options = self.plugin.load_options("notion", "getDatabases", {}, self.creds)
        self.assertEqual(options, [{"name": "Bugs", "value": "db1", "description": "u1"}, {"name": "Tasks", "value": "db2", "description": "u2"}])
        self.assertEqual(self.api.requests[0]["json"]["filter"], {"property": "object", "value": "database"})


class SimplifyTests(unittest.TestCase):
    def test_property_values(self):
        cases = [
            ({"type": "rich_text", "rich_text": [{"plain_text": "a"}, {"plain_text": "b"}]}, "ab"),
            ({"type": "select", "select": None}, None),
            ({"type": "status", "status": {"name": "Done"}}, "Done"),
            ({"type": "multi_select", "multi_select": [{"name": "x"}, {"name": "y"}]}, ["x", "y"]),
            ({"type": "date", "date": {"start": "2026-10-25", "end": None}}, "2026-10-25"),
            ({"type": "checkbox", "checkbox": False}, False),
            ({"type": "url", "url": "https://x"}, "https://x"),
            ({"type": "email", "email": "a@b.c"}, "a@b.c"),
            ({"type": "people", "people": [{"id": "u1", "name": "Ada"}, {"id": "u2"}]}, ["Ada", "u2"]),
            ({"type": "relation", "relation": [{"id": "r1"}, {"id": "r2"}]}, ["r1", "r2"]),
            ({"type": "formula", "formula": {"type": "number", "number": 4}}, 4),
            ({"type": "unique_id", "unique_id": {"prefix": "TASK", "number": 12}}, "TASK-12"),
        ]
        for prop, expected in cases:
            self.assertEqual(property_value(prop), expected, prop["type"])
        self.assertEqual(simplify_page({"id": "1", "url": "u", "properties": {"id": {"type": "number", "number": 3}}})["property_id"], 3)

    def test_page_id(self):
        self.assertEqual(page_id("0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef")
        self.assertEqual(page_id("https://www.notion.so/x/Title-0123456789abcdef0123456789abcdef#frag"), "0123456789abcdef0123456789abcdef")
        self.assertEqual(page_id("01234567-89ab-cdef-0123-456789abcdef"), "01234567-89ab-cdef-0123-456789abcdef")


if __name__ == "__main__":
    unittest.main()
