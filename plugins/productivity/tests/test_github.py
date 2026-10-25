"""GitHub node and GitHub Trigger against a fake GitHub API."""

from __future__ import annotations

import base64
import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin, metric_value, paired

REPO = "/repos/octo/demo"


def issue(n: int, pr: bool = False) -> dict:
    item = {"id": 1000 + n, "number": n, "title": f"Issue {n}", "state": "open"}
    if pr:
        item["pull_request"] = {"url": f"https://api.github.com/repos/octo/demo/pulls/{n}"}
    return item


def linked_pages(pages: list[list[dict]]):
    """A handler serving ``pages`` with ``?page=N`` and a ``Link: rel="next"`` header like GitHub's."""
    def handler(r):
        number = int((r["query"].get("page") or ["1"])[0])
        headers = {}
        if number < len(pages):
            headers["Link"] = f'<{{base}}{r["path"]}?per_page=100&page={number + 1}>; rel="next", <{{base}}{r["path"]}?page={len(pages)}>; rel="last"'
        return 200, pages[number - 1], headers
    return handler


class GitHubTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.creds = {"githubApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "github", {"owner": "octo", "repository": "demo", **parameters}, credentials=self.creds, **kwargs)

    def test_credential_test(self):
        self.api.route("GET", "/user", lambda r: {"login": "octocat", "id": 1} if r["headers"]["authorization"] == f"Bearer {TOKEN}"
                       else (401, {"message": "Bad credentials", "documentation_url": "https://docs.github.com/rest"}))
        self.assertEqual(self.plugin.test_credentials("githubApi", {"accessToken": TOKEN, "baseUrl": self.api.url}),
                         {"ok": True, "message": "authenticated as octocat"})
        self.assertEqual(self.api.requests[-1]["headers"]["accept"], "application/vnd.github+json")
        bad = self.plugin.test_credentials("githubApi", {"accessToken": "ghp_wrong", "baseUrl": self.api.url})
        self.assertEqual(bad, {"ok": False, "message": "GitHub API error (HTTP 401): Bad credentials"})

    def test_enterprise_base_url_path_is_kept(self):
        self.api.route("GET", "/api/v3/repos/octo/demo", {"full_name": "octo/demo"})
        creds = {"githubApi": {"accessToken": TOKEN, "baseUrl": f"{self.api.url}/api/v3/"}}
        response = execute(self.plugin, "github", {"resource": "repository", "operation": "get", "owner": "octo", "repository": "demo"}, credentials=creds)
        self.assertEqual(jsons(response), [{"full_name": "octo/demo"}])

    def test_create_edit_comment(self):
        self.api.route("POST", f"{REPO}/issues", lambda r: {**issue(7), **r["json"]})
        self.api.route("PATCH", f"{REPO}/issues/7", lambda r: {**issue(7), **r["json"]})
        self.api.route("POST", f"{REPO}/issues/7/comments", lambda r: {"id": 55, "body": r["json"]["body"]})
        created = self.run_node({"resource": "issue", "operation": "create", "title": "Bug", "body": "It broke", "labels": "bug, p1", "assignees": "octocat"})
        self.assertEqual(self.api.requests[-1]["json"], {"title": "Bug", "body": "It broke", "labels": ["bug", "p1"], "assignees": ["octocat"]})
        self.assertEqual(jsons(created)[0]["number"], 7)
        edited = self.run_node({"resource": "issue", "operation": "edit", "issueNumber": 7,
                                "editFields": {"state": "closed", "stateReason": "not_planned", "labels": "wontfix", "title": "Bug!"}})
        self.assertEqual(self.api.requests[-1]["json"], {"title": "Bug!", "state": "closed", "state_reason": "not_planned", "labels": ["wontfix"]})
        self.assertEqual(jsons(edited)[0]["state"], "closed")
        comment = self.run_node({"resource": "issue", "operation": "createComment", "issueNumber": "7", "body": "Thanks!"})
        self.assertEqual(jsons(comment), [{"id": 55, "body": "Thanks!"}])
        for operation in ("create", "update", "comment"):
            self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="github", operation=operation), 1)

    def test_get_issue_and_validation(self):
        self.api.route("GET", f"{REPO}/issues/3", issue(3))
        self.assertEqual(jsons(self.run_node({"resource": "issue", "operation": "get", "issueNumber": 3}))[0]["title"], "Issue 3")
        self.assertIn("'Issue Number' must be a positive number", self.run_node({"resource": "issue", "operation": "get", "issueNumber": 0})["error"]["message"])
        self.assertEqual(execute(self.plugin, "github", {"resource": "issue", "operation": "get", "issueNumber": 1}, credentials=self.creds)["error"]["message"],
                         "'Repository Owner' is required")

    def test_get_many_issues_follows_link_and_excludes_prs(self):
        self.api.route("GET", f"{REPO}/issues", linked_pages([[issue(9), issue(8, pr=True), issue(7)], [issue(6), issue(5, pr=True)], [issue(4)]]))
        response = self.run_node({"resource": "issue", "operation": "getAll", "returnAll": True,
                                  "getRepositoryIssuesFilters": {"state": "all", "labels": "bug, ui", "since": "2026-10-01T00:00:00Z"}})
        self.assertEqual([j["number"] for j in jsons(response)], [9, 7, 6, 4])
        first = self.api.requests[0]
        self.assertEqual({k: v[0] for k, v in first["query"].items()},
                         {"state": "all", "labels": "bug,ui", "since": "2026-10-01T00:00:00Z", "per_page": "100"})
        self.assertEqual(len(self.api.requests), 3)

    def test_get_many_issues_limit_stops_early(self):
        self.api.route("GET", f"{REPO}/issues", linked_pages([[issue(9), issue(8, pr=True), issue(7)], [issue(6)]]))
        response = self.run_node({"resource": "issue", "operation": "getAll", "limit": 2})
        self.assertEqual([j["number"] for j in jsons(response)], [9, 7])
        self.assertEqual(len(self.api.requests), 1)

    def test_repository_picker_and_releases(self):
        self.api.route("GET", "/repos/acme/site/releases", linked_pages([[{"id": 3, "tag_name": "v3"}], [{"id": 2, "tag_name": "v2"}]]))
        response = execute(self.plugin, "github", {"resource": "release", "operation": "getAll", "repo": "acme/site", "returnAll": True},
                           credentials=self.creds)
        self.assertEqual([j["tag_name"] for j in jsons(response)], ["v3", "v2"])

    def test_get_file_decodes_content(self):
        text = "# Hello\nwörld\n"
        self.api.route("GET", f"{REPO}/contents/docs/README.md", {"type": "file", "path": "docs/README.md", "encoding": "base64",
                                                                  "content": base64.encodebytes(text.encode()).decode()})
        self.api.route("GET", f"{REPO}/contents/docs", [{"type": "file", "path": "docs/README.md"}, {"type": "dir", "path": "docs/img"}])
        response = self.run_node({"resource": "file", "operation": "get", "filePath": "/docs/README.md", "fileOptions": {"reference": "main"}})
        self.assertEqual(jsons(response)[0]["content"], text)
        self.assertEqual(jsons(response)[0]["encoding"], "utf-8")
        self.assertEqual(self.api.requests[0]["query"]["ref"], ["main"])
        listing = self.run_node({"resource": "file", "operation": "get", "filePath": "docs"})
        self.assertEqual([j["path"] for j in jsons(listing)], ["docs/README.md", "docs/img"])

    def test_error_mapping(self):
        self.api.route("POST", f"{REPO}/issues", (422, {"message": "Validation Failed", "errors": [{"resource": "Issue", "field": "title", "code": "missing_field"}]}))
        response = self.run_node({"resource": "issue", "operation": "create", "title": "x"})
        self.assertEqual(response["error"]["message"], "GitHub API error (HTTP 422): Validation Failed; Issue title missing_field")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="github", status_class="4xx"), 1)

    def test_continue_on_fail_keeps_going_per_item(self):
        self.api.route("GET", f"{REPO}/issues/3", {"number": 3, "title": "Issue 3"})
        items = [{"json": {}}, {"json": {}}]
        params = {"resource": "issue", "operation": "get"}
        response = self.run_node(params, inputs=items, item_parameters=[{**params, "issueNumber": 0}, {**params, "issueNumber": 3}],
                                 continue_on_fail=True)
        self.assertNotIn("error", response)
        self.assertIn("'Issue Number' must be a positive number", jsons(response)[0]["error"])
        self.assertEqual(jsons(response)[1]["title"], "Issue 3")
        self.assertEqual(paired(response), [0, 1])
        self.assertIn("error", self.run_node(params, inputs=items, item_parameters=[{**params, "issueNumber": 0}, {**params, "issueNumber": 3}]))

    def test_network_error(self):
        creds = {"githubApi": {"accessToken": TOKEN, "baseUrl": "http://127.0.0.1:9"}}
        response = execute(self.plugin, "github", {"resource": "repository", "operation": "get", "owner": "o", "repository": "r"}, credentials=creds)
        self.assertTrue(response["error"]["message"].startswith("GitHub API unreachable"), response["error"])
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="github", status_class="network"), 1)

    def test_load_repositories(self):
        self.api.route("GET", "/user/repos", linked_pages([[{"full_name": "octo/a", "description": "A"}], [{"full_name": "acme/b", "description": None}]]))
        options = self.plugin.load_options("github", "getRepositories", {}, self.creds)
        self.assertEqual([o["value"] for o in options], ["", "octo/a", "acme/b"])
        self.assertEqual(self.api.requests[0]["query"]["sort"], ["updated"])


class GitHubTriggerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.creds = {"githubApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}
        self.issues = [issue(n, pr=(n == 4)) for n in range(8, 0, -1)]  # newest first, #4 is a PR
        self.api.route("GET", f"{REPO}/issues", lambda r: self.issues)

    def poll(self, state=None, mode="poll", event="newIssue"):
        return execute(self.plugin, "githubTrigger", {"owner": "octo", "repository": "demo", "event": event},
                       credentials=self.creds, mode=mode, poll_state=state)

    def test_manual_returns_latest_five_oldest_first_without_state(self):
        response = self.poll({"lastId": 1008}, mode="manual")
        self.assertEqual([j["number"] for j in jsons(response)], [3, 5, 6, 7, 8])
        self.assertNotIn("pollState", response)

    def test_first_poll_is_a_baseline(self):
        response = self.poll()
        self.assertEqual(response["outputs"], [[]])
        self.assertEqual(response["pollState"], {"lastId": 1008})
        query = self.api.requests[0]["query"]
        self.assertEqual((query["sort"], query["direction"], query["state"]), (["created"], ["desc"], ["all"]))

    def test_new_items_oldest_first_and_state(self):
        self.issues = [issue(11), issue(10, pr=True), issue(9)] + self.issues
        response = self.poll({"lastId": 1008})
        self.assertEqual([j["number"] for j in jsons(response)], [9, 11])
        self.assertEqual(response["pollState"], {"lastId": 1011})
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.poll.new_items", trigger="github"), 2)
        again = self.poll(response["pollState"])
        self.assertEqual((again["outputs"], again["pollState"]), ([[]], {"lastId": 1011}))

    def test_pull_requests_and_releases(self):
        self.api.route("GET", f"{REPO}/pulls", [{"id": 30, "number": 3}, {"id": 20, "number": 2}])
        self.api.route("GET", f"{REPO}/releases", [{"id": 7, "tag_name": "v2"}, {"id": 5, "tag_name": "v1"}])
        prs = self.poll({"lastId": 20}, event="newPullRequest")
        self.assertEqual([j["number"] for j in jsons(prs)], [3])
        releases = self.poll({"lastId": 0}, event="newRelease")
        self.assertEqual([j["tag_name"] for j in jsons(releases)], ["v1", "v2"])
        self.assertEqual(releases["pollState"], {"lastId": 7})

    def test_failed_poll_returns_no_state(self):
        self.api.route("GET", f"{REPO}/issues", (500, {"message": "Server Error"}))
        response = self.poll({"lastId": 5})
        self.assertNotIn("pollState", response)
        self.assertEqual(response["error"]["message"], "GitHub API error (HTTP 500): Server Error")
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="github", status_class="5xx"), 1)


if __name__ == "__main__":
    unittest.main()
