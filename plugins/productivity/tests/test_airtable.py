"""Airtable node against a fake Airtable API."""

from __future__ import annotations

import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin, metric_value, paired

TABLE = "/v0/appBase1/tblTasks"


def echo_records(r):
    """Create / update / upsert: return the sent records with ids, as Airtable does."""
    records = r["json"]["records"]
    return {"records": [{"id": rec.get("id") or f"rec{n}", "createdTime": "2026-10-25T10:00:00.000Z", "fields": rec["fields"]}
                        for n, rec in enumerate(records)]}


class AirtableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.creds = {"airtableTokenApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "airtable", {"base": "appBase1", "table": "tblTasks", **parameters}, credentials=self.creds, **kwargs)

    def test_credential_test(self):
        self.api.route("GET", "/v0/meta/whoami", lambda r: {"id": "usr1", "email": "ada@example.com"}
                       if r["headers"]["authorization"] == f"Bearer {TOKEN}" else (401, {"error": {"type": "AUTHENTICATION_REQUIRED", "message": "Authentication required"}}))
        self.assertEqual(self.plugin.test_credentials("airtableTokenApi", {"accessToken": TOKEN, "baseUrl": self.api.url}),
                         {"ok": True, "message": "authenticated as ada@example.com"})
        bad = self.plugin.test_credentials("airtableTokenApi", {"accessToken": "nope-token", "baseUrl": self.api.url})
        self.assertEqual(bad["ok"], False)
        self.assertEqual(bad["message"], "Airtable API error (HTTP 401): Authentication required")

    def test_create_batches_of_ten_mapping_input(self):
        self.api.route("POST", TABLE, echo_records)
        inputs = [{"json": {"Name": f"task {n}", "Score": n}} for n in range(12)]
        response = self.run_node({"operation": "create", "writeOptions": {"typecast": True}}, inputs=inputs)
        posts = self.api.calls("POST", TABLE)
        self.assertEqual([len(p["json"]["records"]) for p in posts], [10, 2])
        self.assertEqual(posts[0]["json"]["records"][3], {"fields": {"Name": "task 3", "Score": 3}})
        self.assertTrue(posts[0]["json"]["typecast"])
        self.assertEqual(paired(response), list(range(12)))
        self.assertEqual(jsons(response)[11], {"id": "rec1", "createdTime": "2026-10-25T10:00:00.000Z", "Name": "task 11", "Score": 11})
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="airtable", operation="create"), 12)

    def test_upsert_with_fields_defined_below(self):
        self.api.route("PATCH", TABLE, lambda r: {**echo_records(r), "createdRecords": [], "updatedRecords": ["rec0"]})
        response = self.run_node({
            "operation": "upsert", "fieldsToMergeOn": "Email", "dataMode": "defineBelow",
            "fieldsUi": {"fieldValues": [{"fieldName": "Email", "fieldValue": "ada@example.com"}, {"fieldName": "Name", "fieldValue": "Ada"}]},
        })
        body = self.api.calls("PATCH")[0]["json"]
        self.assertEqual(body, {"records": [{"fields": {"Email": "ada@example.com", "Name": "Ada"}}],
                                "performUpsert": {"fieldsToMergeOn": ["Email"]}})
        self.assertEqual(jsons(response)[0]["Name"], "Ada")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="airtable", operation="upsert"), 1)

    def test_update_with_json_fields(self):
        self.api.route("PATCH", TABLE, echo_records)
        response = self.run_node({"operation": "update", "id": "recA", "dataMode": "json", "fieldsJson": '{"Status": "Done"}'})
        self.assertEqual(self.api.calls("PATCH")[0]["json"], {"records": [{"fields": {"Status": "Done"}, "id": "recA"}]})
        self.assertEqual(jsons(response)[0]["id"], "recA")

    def test_get_and_delete(self):
        self.api.route("GET", f"{TABLE}/recA", {"id": "recA", "createdTime": "t", "fields": {"Name": "A"}})
        self.api.route("DELETE", TABLE, lambda r: {"records": [{"id": i, "deleted": True} for i in r["query"]["records[]"]]})
        self.assertEqual(jsons(self.run_node({"operation": "get", "id": "recA"})), [{"id": "recA", "createdTime": "t", "Name": "A"}])
        response = self.run_node({"operation": "deleteRecord"}, inputs=[{"json": {}}] * 3,
                                 item_parameters=[{"id": "rec1"}, {"id": "rec2"}, {"id": "rec3"}])
        deletes = self.api.calls("DELETE")
        self.assertEqual(len(deletes), 1)
        self.assertEqual(deletes[0]["query"]["records[]"], ["rec1", "rec2", "rec3"])
        self.assertEqual(jsons(response), [{"id": f"rec{n}", "deleted": True} for n in (1, 2, 3)])
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="airtable", operation="delete"), 3)

    def test_search_paginates_with_offset(self):
        def page(r):
            if r["query"].get("offset") == ["itr2"]:
                return {"records": [{"id": "rec3", "fields": {"n": 3}}]}
            return {"records": [{"id": "rec1", "fields": {"n": 1}}, {"id": "rec2", "fields": {"n": 2}}], "offset": "itr2"}

        self.api.route("GET", TABLE, page)
        response = self.run_node({
            "operation": "search", "filterByFormula": "{Status} = 'Open'", "returnAll": True,
            "sort": {"property": [{"field": "Name", "direction": "desc"}]},
            "searchOptions": {"view": "Grid view", "fields": "Name, Status"},
        })
        self.assertEqual([j["id"] for j in jsons(response)], ["rec1", "rec2", "rec3"])
        first, second = self.api.requests
        self.assertEqual(first["query"]["filterByFormula"], ["{Status} = 'Open'"])
        self.assertEqual(first["query"]["sort[0][field]"], ["Name"])
        self.assertEqual(first["query"]["sort[0][direction]"], ["desc"])
        self.assertEqual(first["query"]["view"], ["Grid view"])
        self.assertEqual(first["query"]["fields[]"], ["Name", "Status"])
        self.assertEqual(first["query"]["pageSize"], ["100"])
        self.assertNotIn("maxRecords", first["query"])
        self.assertEqual(second["query"]["offset"], ["itr2"])

    def test_search_limit(self):
        self.api.route("GET", TABLE, {"records": [{"id": "rec1", "fields": {}}, {"id": "rec2", "fields": {}}], "offset": "more"})
        response = self.run_node({"operation": "search", "limit": 2})
        self.assertEqual(len(jsons(response)), 2)
        self.assertEqual(len(self.api.requests), 1)
        self.assertEqual(self.api.requests[0]["query"]["maxRecords"], ["2"])

    def test_error_mapping(self):
        self.api.route("POST", TABLE, (422, {"error": {"type": "INVALID_VALUE_FOR_COLUMN", "message": "Field \"Score\" cannot accept the provided value"}}))
        response = self.run_node({"operation": "create"}, inputs=[{"json": {"Score": "x"}}])
        self.assertEqual(response["error"]["message"], 'Airtable API error (HTTP 422): Field "Score" cannot accept the provided value')
        self.assertEqual(response["error"]["itemIndex"], 0)
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="airtable", status_class="4xx"), 1)

    def test_missing_table(self):
        response = execute(self.plugin, "airtable", {"operation": "get", "base": "appBase1", "id": "x"}, credentials=self.creds)
        self.assertEqual(response["error"]["message"], "'Table' is required")

    def test_load_options(self):
        self.api.route("GET", "/v0/meta/bases", lambda r: {"bases": [{"id": "app2", "name": "CRM", "permissionLevel": "create"}]}
                       if r["query"].get("offset") else {"bases": [{"id": "app1", "name": "Tasks", "permissionLevel": "edit"}], "offset": "o1"})
        self.api.route("GET", "/v0/meta/bases/app1/tables", {"tables": [{"id": "tbl1", "name": "Todo", "description": "things"}]})
        self.assertEqual([o["value"] for o in self.plugin.load_options("airtable", "getBases", {}, self.creds)], ["app1", "app2"])
        self.assertEqual(self.plugin.load_options("airtable", "getTables", {"base": "app1"}, self.creds),
                         [{"name": "Todo", "value": "tbl1", "description": "things"}])
        self.assertEqual(self.plugin.load_options("airtable", "getTables", {}, self.creds), [])


if __name__ == "__main__":
    unittest.main()
