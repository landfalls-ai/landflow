"""Jira node (Cloud REST v3 and Server REST v2) against a fake Jira API."""

from __future__ import annotations

import base64
import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin, metric_value

from productivity.jira import adf_to_text, text_to_adf

EMAIL = "ada@example.com"
BASIC = "Basic " + base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()


def jira_issue(key: str, description=None) -> dict:
    return {"id": "100" + key[-1], "key": key, "self": f"https://jira/rest/api/3/issue/{key}", "fields": {
        "summary": f"Summary {key}", "status": {"name": "To Do"}, "issuetype": {"name": "Bug"}, "priority": {"name": "High"},
        "project": {"key": "PROJ"}, "assignee": {"displayName": "Ada", "accountId": "acc1"}, "reporter": None,
        "labels": ["ui"], "created": "2026-10-25T10:00:00.000+0000", "updated": "2026-10-25T11:00:00.000+0000",
        "description": description,
    }}


class JiraTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.cloud = {"jiraSoftwareCloudApi": {"email": EMAIL, "apiToken": TOKEN, "domain": self.api.url + "/"}}
        self.server = {"jiraSoftwareServerPatApi": {"personalAccessToken": TOKEN, "domain": self.api.url}}

    def run_cloud(self, parameters, **kwargs):
        return execute(self.plugin, "jira", {"jiraVersion": "cloud", **parameters}, credentials=self.cloud, **kwargs)

    def run_server(self, parameters, **kwargs):
        return execute(self.plugin, "jira", {"jiraVersion": "serverPat", **parameters}, credentials=self.server, **kwargs)

    def test_credential_tests(self):
        self.api.route("GET", "/rest/api/3/myself", lambda r: {"displayName": "Ada Lovelace"} if r["headers"]["authorization"] == BASIC
                       else (401, {"errorMessages": ["Client must be authenticated to access this resource."], "errors": {}}))
        self.api.route("GET", "/rest/api/2/myself", lambda r: {"name": "ada", "displayName": "Ada (DC)"}
                       if r["headers"]["authorization"] == f"Bearer {TOKEN}" else (401, ""))
        self.assertEqual(self.plugin.test_credentials("jiraSoftwareCloudApi", self.cloud["jiraSoftwareCloudApi"]),
                         {"ok": True, "message": "authenticated as Ada Lovelace"})
        bad = self.plugin.test_credentials("jiraSoftwareCloudApi", {"email": EMAIL, "apiToken": "wrong", "domain": self.api.url})
        self.assertEqual(bad, {"ok": False, "message": "Jira API error (HTTP 401): Client must be authenticated to access this resource."})
        self.assertEqual(self.plugin.test_credentials("jiraSoftwareServerPatApi", self.server["jiraSoftwareServerPatApi"]),
                         {"ok": True, "message": "authenticated as Ada (DC)"})
        self.assertEqual(self.plugin.test_credentials("jiraSoftwareServerPatApi", {"personalAccessToken": TOKEN})["ok"], False)

    def test_create_cloud_uses_adf(self):
        self.api.route("POST", "/rest/api/3/issue", {"id": "10001", "key": "PROJ-1", "self": "x"})
        response = self.run_cloud({"resource": "issue", "operation": "create", "project": "10000", "issueType": "10004", "summary": "Login fails",
                                   "additionalFields": {"description": "Steps:\nopen page\n\nExpected: works", "labels": "ui, needs triage", "priority": "2"}})
        fields = self.api.requests[0]["json"]["fields"]
        self.assertEqual(self.api.requests[0]["headers"]["authorization"], BASIC)
        self.assertEqual(fields["project"], {"id": "10000"})
        self.assertEqual(fields["issuetype"], {"id": "10004"})
        self.assertEqual(fields["labels"], ["ui", "needs_triage"])
        self.assertEqual(fields["priority"], {"id": "2"})
        self.assertEqual(fields["description"], {"type": "doc", "version": 1, "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Steps:"}, {"type": "hardBreak"}, {"type": "text", "text": "open page"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "Expected: works"}]},
        ]})
        self.assertEqual(jsons(response), [{"id": "10001", "key": "PROJ-1", "self": "x"}])
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="jira", operation="create"), 1)

    def test_create_server_uses_v2_and_plain_text(self):
        self.api.route("POST", "/rest/api/2/issue", {"id": "1", "key": "OPS-1"})
        self.run_server({"resource": "issue", "operation": "create", "project": "OPS", "issueType": "Task", "summary": "Rotate keys",
                         "additionalFields": {"description": "Do it"}})
        request = self.api.requests[0]
        self.assertEqual(request["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(request["json"]["fields"], {"project": {"key": "OPS"}, "issuetype": {"name": "Task"}, "summary": "Rotate keys", "description": "Do it"})

    def test_get_simplified(self):
        self.api.route("GET", "/rest/api/3/issue/PROJ-1", jira_issue("PROJ-1", text_to_adf("Hello\n\nWorld")))
        response = self.run_cloud({"resource": "issue", "operation": "get", "issueKey": "PROJ-1", "options": {"fields": "summary,status"}})
        self.assertEqual(self.api.requests[0]["query"]["fields"], ["summary,status"])
        simple = jsons(response)[0]
        self.assertEqual((simple["key"], simple["status"], simple["assignee"], simple["reporter"], simple["description"]),
                         ("PROJ-1", "To Do", "Ada", None, "Hello\nWorld"))
        raw = self.run_cloud({"resource": "issue", "operation": "get", "issueKey": "PROJ-1", "simplify": False})
        self.assertEqual(jsons(raw)[0]["fields"]["status"], {"name": "To Do"})

    def test_search_cloud_next_page_token(self):
        def search(r):
            if r["json"].get("nextPageToken") == "t2":
                return {"issues": [jira_issue("PROJ-3")], "isLast": True}
            return {"issues": [jira_issue("PROJ-1"), jira_issue("PROJ-2")], "nextPageToken": "t2", "isLast": False}

        self.api.route("POST", "/rest/api/3/search/jql", search)
        response = self.run_cloud({"resource": "issue", "operation": "getAll", "jql": "project = PROJ", "returnAll": True})
        self.assertEqual([j["key"] for j in jsons(response)], ["PROJ-1", "PROJ-2", "PROJ-3"])
        first, second = self.api.requests
        self.assertEqual(first["json"], {"jql": "project = PROJ", "fields": ["*navigable"], "maxResults": 100})
        self.assertEqual(second["json"]["nextPageToken"], "t2")

    def test_search_server_start_at_with_limit(self):
        def search(r):
            start = r["json"]["startAt"]
            return {"startAt": start, "maxResults": r["json"]["maxResults"], "total": 5,
                    "issues": [jira_issue(f"OPS-{n}") for n in range(start + 1, min(start + 1 + r["json"]["maxResults"], 6))]}

        self.api.route("POST", "/rest/api/2/search", search)
        response = self.run_server({"resource": "issue", "operation": "getAll", "jql": "project = OPS", "returnAll": True})
        self.assertEqual(len(jsons(response)), 5)
        limited = self.run_server({"resource": "issue", "operation": "getAll", "jql": "project = OPS", "limit": 3, "simplify": False})
        self.assertEqual([j["key"] for j in jsons(limited)], ["OPS-1", "OPS-2", "OPS-3"])
        self.assertEqual(self.api.requests[-1]["json"]["maxResults"], 3)

    def test_update_transition_comment(self):
        self.api.route("PUT", "/rest/api/3/issue/PROJ-1", (204, b""))
        self.api.route("POST", "/rest/api/3/issue/PROJ-1/transitions", (204, b""))
        self.api.route("POST", "/rest/api/3/issue/PROJ-1/comment", lambda r: {"id": "c1", "body": r["json"]["body"]})
        self.api.route("POST", "/rest/api/2/issue/OPS-1/comment", lambda r: {"id": "c2", "body": r["json"]["body"]})
        updated = self.run_cloud({"resource": "issue", "operation": "update", "issueKey": "PROJ-1",
                                  "updateFields": {"summary": "New title", "fieldsJson": '{"customfield_1": 5}'}})
        self.assertEqual(self.api.requests[-1]["json"], {"fields": {"summary": "New title", "customfield_1": 5}})
        self.assertEqual(jsons(updated), [{"success": True, "key": "PROJ-1"}])
        moved = self.run_cloud({"resource": "issue", "operation": "transition", "issueKey": "PROJ-1", "transitionId": "31"})
        self.assertEqual(self.api.requests[-1]["json"], {"transition": {"id": "31"}})
        self.assertEqual(jsons(moved)[0]["transitionId"], "31")
        comment = self.run_cloud({"resource": "issueComment", "operation": "add", "issueKey": "PROJ-1", "comment": "Looks good"})
        self.assertEqual(jsons(comment)[0]["body"]["type"], "doc")
        server = self.run_server({"resource": "issueComment", "operation": "add", "issueKey": "OPS-1", "comment": "ok"})
        self.assertEqual(jsons(server)[0]["body"], "ok")
        for operation, count in (("update", 1), ("transition", 1), ("comment", 2)):
            self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="jira", operation=operation), count)
        self.assertIn("Nothing to update", self.run_cloud({"resource": "issue", "operation": "update", "issueKey": "PROJ-1"})["error"]["message"])

    def test_error_and_missing_credential(self):
        self.api.route("GET", "/rest/api/3/issue/NOPE-1", (404, {"errorMessages": ["Issue does not exist or you do not have permission to see it."], "errors": {}}))
        response = self.run_cloud({"resource": "issue", "operation": "get", "issueKey": "NOPE-1"})
        self.assertEqual(response["error"]["message"], "Jira API error (HTTP 404): Issue does not exist or you do not have permission to see it.")
        self.assertEqual(response["error"]["itemIndex"], 0)
        missing = execute(self.plugin, "jira", {"jiraVersion": "serverPat", "resource": "issue", "operation": "get", "issueKey": "X-1"}, credentials=self.cloud)
        self.assertEqual(missing["error"]["message"], "No credentials set for 'jiraSoftwareServerPatApi'")

    def test_load_options(self):
        self.api.route("GET", "/rest/api/3/project/search", lambda r: {"values": [{"id": "2", "key": "WEB", "name": "Website"}], "isLast": True}
                       if r["query"]["startAt"] == ["1"] else {"values": [{"id": "1", "key": "APP", "name": "App"}], "isLast": False})
        self.api.route("GET", "/rest/api/3/project/1", {"issueTypes": [{"id": "10", "name": "Bug"}, {"id": "11", "name": "Sub-task", "subtask": True}]})
        self.api.route("GET", "/rest/api/3/issue/APP-1/transitions", {"transitions": [{"id": "31", "name": "Done", "to": {"name": "Done"}}]})
        self.api.route("GET", "/rest/api/2/priority", [{"id": "1", "name": "Highest"}])
        self.assertEqual(self.plugin.load_options("jira", "getProjects", {"jiraVersion": "cloud"}, self.cloud),
                         [{"name": "App (APP)", "value": "1"}, {"name": "Website (WEB)", "value": "2"}])
        types = self.plugin.load_options("jira", "getIssueTypes", {"jiraVersion": "cloud", "project": "1"}, self.cloud)
        self.assertEqual([(t["value"], t.get("description")) for t in types], [("10", None), ("11", "Sub-task")])
        self.assertEqual(self.plugin.load_options("jira", "getTransitions", {"jiraVersion": "cloud", "issueKey": "APP-1"}, self.cloud),
                         [{"name": "Done", "value": "31", "description": "to Done"}])
        self.assertEqual(self.plugin.load_options("jira", "getPriorities", {"jiraVersion": "serverPat"}, self.server), [{"name": "Highest", "value": "1"}])

    def test_manifest_credentials_follow_version(self):
        jira = next(n for n in self.plugin.manifest()["nodes"] if n["name"] == "jira")
        self.assertEqual([(c["name"], c["displayOptions"]["show"]["jiraVersion"]) for c in jira["credentials"]],
                         [("jiraSoftwareCloudApi", ["cloud"]), ("jiraSoftwareServerPatApi", ["serverPat"])])


class AdfTests(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(text_to_adf(""), {"type": "doc", "version": 1, "content": []})
        doc = {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Hi "}, {"type": "mention", "attrs": {"text": "@Ada"}}]},
            {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "one"}]}]}]},
        ]}
        self.assertEqual(adf_to_text(doc), "Hi @Ada\n- one")
        self.assertEqual(adf_to_text("plain v2"), "plain v2")


if __name__ == "__main__":
    unittest.main()
