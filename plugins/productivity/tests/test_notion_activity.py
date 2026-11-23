"""Notion activity: the Notion Trigger (a baseline, then only new edits), Get Many Changed Since, Get Content,
User → Get Many and Comment → Create, against an in-memory fake Notion workspace."""

from __future__ import annotations

import re
import unittest
from datetime import datetime, timedelta, timezone

from _support import TOKEN, FakeApi, execute, jsons, make_plugin

from landflow_sdk import ACTIVITY_ITEM_SCHEMA

from productivity.notion_activity import ACTIVITY_VERSION, hint_after, iso, norm_id, roots_of


def ago(**delta) -> str:
    return iso(datetime.now(timezone.utc) - timedelta(**delta))


class FakeNotion:
    """A workspace: pages (with parents and blocks), databases with one data source each, users and comments.

    ``search`` leaves out pages marked ``unindexed`` (Notion's search lags); ``page_cap`` caps every page size."""

    def __init__(self, api: FakeApi) -> None:
        self.api = api
        self.pages: dict[str, dict] = {}
        self.databases: dict[str, dict] = {}
        self.blocks: dict[str, list[dict]] = {}
        self.users = [
            {"object": "user", "id": "u-dana", "type": "person", "name": "Dana", "person": {"email": "Dana@Example.com"}},
            {"object": "user", "id": "u-lee", "type": "person", "name": "Lee", "person": {"email": "lee@example.com"}},
            {"object": "user", "id": "u-bot", "type": "bot", "name": "Landflow", "bot": {}},
        ]
        self.unindexed: set[str] = set()
        self.page_cap = 100
        self.users_forbidden = False
        self.comments: list[dict] = []
        self.rate_limited = 0
        api.route("POST", "/v1/search", self.search)
        api.route("POST", r"/v1/data_sources/([^/]+)/query", self.query)
        api.route("GET", r"/v1/pages/([^/]+)", lambda r: self.get(self.pages, r))
        api.route("GET", r"/v1/databases/([^/]+)", lambda r: self.get(self.databases, r))
        api.route("GET", r"/v1/blocks/([^/]+)", lambda r: (404, {"object": "error", "status": 404, "code": "object_not_found", "message": "no block"}))
        api.route("GET", r"/v1/blocks/([^/]+)/children", self.children)
        api.route("GET", "/v1/users", self.list_users)
        api.route("POST", "/v1/comments", self.comment)

    # ---- building

    def page(self, pid: str, title: str, *, parent: dict | None = None, edited: str | None = None, by: str = "u-dana",
             props: dict | None = None, text: list[str] | None = None) -> dict:
        page = {
            "object": "page", "id": pid, "url": f"https://www.notion.so/{pid}", "in_trash": False,
            "parent": parent or {"type": "workspace", "workspace": True},
            "created_time": ago(days=30), "last_edited_time": edited or ago(days=10),
            "created_by": {"object": "user", "id": "u-lee"}, "last_edited_by": {"object": "user", "id": by},
            "properties": {"title": {"type": "title", "title": [{"plain_text": title}]}, **(props or {})},
        }
        self.pages[pid] = page
        self.blocks[pid] = [{"object": "block", "id": f"{pid}-b{n}", "type": "paragraph", "has_children": False,
                             "paragraph": {"rich_text": [{"plain_text": line}]}} for n, line in enumerate(text or [])]
        return page

    def database(self, did: str, title: str, parent: dict | None = None) -> None:
        self.databases[did] = {"object": "database", "id": did, "title": [{"plain_text": title}],
                               "parent": parent or {"type": "workspace", "workspace": True},
                               "data_sources": [{"id": f"ds-{did}", "name": title}]}

    def edit(self, pid: str, *, by: str = "u-dana", at: str | None = None) -> None:
        self.pages[pid]["last_edited_time"] = at or iso(datetime.now(timezone.utc) + timedelta(seconds=1))
        self.pages[pid]["last_edited_by"] = {"object": "user", "id": by}

    # ---- routes

    def _limited(self):
        if self.rate_limited:
            self.rate_limited -= 1
            return (429, {"object": "error", "status": 429, "code": "rate_limited", "message": "Rate limited"}, {"Retry-After": "0"})
        return None

    def _paged(self, items: list, cursor: str | None, size: int) -> dict:
        start = int(cursor or 0)
        size = min(size or 100, self.page_cap)
        chunk = items[start:start + size]
        more = start + size < len(items)
        return {"object": "list", "results": chunk, "has_more": more, "next_cursor": str(start + size) if more else None}

    def search(self, r):
        if (limited := self._limited()) is not None:
            return limited
        body = r["json"] or {}
        assert body["filter"] == {"property": "object", "value": "page"}, body
        pages = [p for p in self.pages.values() if p["id"] not in self.unindexed]
        pages.sort(key=lambda p: p["last_edited_time"], reverse=body["sort"]["direction"] == "descending")
        return self._paged(pages, body.get("start_cursor"), body.get("page_size"))

    def query(self, r):
        body = r["json"] or {}
        ds = re.fullmatch(r"/v1/data_sources/([^/]+)/query", r["path"]).group(1)
        since = body["filter"]["last_edited_time"]["on_or_after"]
        assert body["filter"]["timestamp"] == "last_edited_time"
        rows = [p for p in self.pages.values() if p["parent"].get("data_source_id") == ds and p["last_edited_time"] >= since]
        rows.sort(key=lambda p: p["last_edited_time"])
        return self._paged(rows, body.get("start_cursor"), body.get("page_size"))

    @staticmethod
    def get(store: dict, r):
        key = r["path"].rsplit("/", 1)[1]
        found = next((v for k, v in store.items() if norm_id(k) == norm_id(key)), None)
        return found if found else (404, {"object": "error", "status": 404, "code": "object_not_found", "message": f"Could not find {key}."})

    def children(self, r):
        bid = r["path"].split("/")[3]
        return self._paged(self.blocks.get(bid, []), (r["query"].get("start_cursor") or [None])[0], int(r["query"]["page_size"][0]))

    def list_users(self, r):
        if self.users_forbidden:
            return 403, {"object": "error", "status": 403, "code": "restricted_resource", "message": "Insufficient permissions for this endpoint."}
        return self._paged(self.users, (r["query"].get("start_cursor") or [None])[0], int(r["query"]["page_size"][0]))

    def comment(self, r):
        self.comments.append(r["json"])
        return {"object": "comment", "id": f"c{len(self.comments)}", "discussion_id": "d1", "rich_text": r["json"]["rich_text"]}


ITEM_KEYS = set(ACTIVITY_ITEM_SCHEMA["properties"]) - {"cursor"}


class NotionActivityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.notion = FakeNotion(self.api)
        self.plugin = make_plugin()
        self.creds = {"notionApi": {"apiKey": TOKEN, "baseUrl": self.api.url}}
        n = self.notion
        # Customers / Acme / Kickoff notes, and a Roadmap database inside Projects / Atlas.
        n.page("p-customers", "Customers")
        n.page("p-acme", "Acme", parent={"type": "page_id", "page_id": "p-customers"})
        n.page("p-kickoff", "Kickoff notes", parent={"type": "page_id", "page_id": "p-acme"},
               text=["Agenda: pricing", "Next step: a pilot in December"])
        n.page("p-projects", "Projects")
        n.page("p-atlas", "Atlas", parent={"type": "page_id", "page_id": "p-projects"})
        n.database("db-roadmap", "Roadmap", parent={"type": "page_id", "page_id": "p-atlas"})
        n.page("p-row", "Ship search", parent={"type": "data_source_id", "data_source_id": "ds-db-roadmap", "database_id": "db-roadmap"},
               props={"Status": {"type": "status", "status": {"name": "Doing"}}, "Owner": {"type": "people", "people": [{"id": "u-lee", "name": "Lee"}]}})
        n.page("p-elsewhere", "Lunch menu")

    def poll(self, parameters=None, state=None, mode="poll"):
        return execute(self.plugin, "notionTrigger", parameters or {}, credentials=self.creds, mode=mode, poll_state=state)

    def check_shape(self, item, extra=()):
        self.assertEqual(set(item), ITEM_KEYS | set(extra), item)
        self.assertLessEqual(len(item["summary"]), 600)

    # ---------------------------------------------------------------- trigger

    def test_baseline_then_only_new_edits(self):
        self.notion.edit("p-elsewhere", at=ago(seconds=30))  # edited just before activation: not replayed
        first = self.poll()
        self.assertEqual(jsons(first), [])
        state = first["pollState"]
        self.assertIn("since", state)
        self.assertEqual(state["seen"], [f"{norm_id('p-elsewhere')}@{self.notion.pages['p-elsewhere']['last_edited_time']}"])

        self.notion.edit("p-kickoff", by="u-dana")
        second = self.poll(state=first["pollState"])
        items = jsons(second)
        self.assertEqual([i["title"] for i in items], ["Kickoff notes"])
        item = items[0]
        self.check_shape(item)
        self.assertEqual(item["source"], "notion")
        self.assertEqual(item["sourceId"], f"notion:p-kickoff:{self.notion.pages['p-kickoff']['last_edited_time']}")
        self.assertEqual(item["actorEmail"], "dana@example.com")
        self.assertEqual(item["kind"], "work.doc_edited")
        self.assertEqual(item["customerHint"], "Acme")
        self.assertIsNone(item["initiativeHint"])
        self.assertEqual(item["summary"], "Agenda: pricing Next step: a pilot in December")
        self.assertEqual(item["url"], "https://www.notion.so/p-kickoff")
        self.assertEqual(item["raw"]["path"], "Customers/Acme")
        self.assertEqual(item["raw"]["createdBy"], "lee@example.com")
        self.assertTrue(all(r["headers"]["notion-version"] == ACTIVITY_VERSION for r in self.api.requests))

        # Nothing new: nothing out, even though the lookback re-reads the same edit.
        third = self.poll(state=second["pollState"])
        self.assertEqual(jsons(third), [])
        # A later edit of the same page is a new version.
        self.notion.edit("p-kickoff", by="u-lee", at=iso(datetime.now(timezone.utc) + timedelta(seconds=5)))
        fourth = jsons(self.poll(state=third["pollState"]))
        self.assertEqual([(i["title"], i["actorEmail"]) for i in fourth], [("Kickoff notes", "lee@example.com")])

    def test_roots_and_search_lag(self):
        params = {"roots": "db-roadmap\np-customers"}
        first = self.poll(params)
        self.notion.edit("p-row")
        self.notion.unindexed.add("p-row")  # search hasn't caught up: the root database's data source has it
        self.notion.edit("p-elsewhere")  # not under a root
        self.notion.edit("p-acme")
        items = jsons(self.poll(params, state=first["pollState"]))
        self.assertEqual(sorted(i["title"] for i in items), ["Acme", "Ship search"])
        row = next(i for i in items if i["title"] == "Ship search")
        self.check_shape(row)
        self.assertEqual(row["initiativeHint"], "Atlas")
        self.assertTrue(row["summary"].startswith("Status: Doing · Owner: Lee"), row["summary"])
        self.assertEqual(row["raw"]["path"], "Projects/Atlas/Roadmap")
        self.assertEqual(row["raw"]["dataSourceId"], "ds-db-roadmap")
        query = self.api.calls("POST", "/v1/data_sources/ds-db-roadmap/query")[-1]["json"]
        self.assertEqual(query["sorts"], [{"timestamp": "last_edited_time", "direction": "ascending"}])

    def test_paginates_and_retries_a_rate_limit(self):
        first = self.poll()
        for n in range(5):
            self.notion.page(f"p-new{n}", f"New {n}", edited=iso(datetime.now(timezone.utc) + timedelta(seconds=n + 1)))
        self.notion.page_cap = 2
        self.notion.rate_limited = 1
        items = jsons(self.poll({"activityOptions": {"includeText": False}}, state=first["pollState"]))
        self.assertEqual([i["title"] for i in items], [f"New {n}" for n in range(5)])  # oldest first
        self.assertGreaterEqual(len(self.api.calls("POST", "/v1/search")), 4)  # one 429, then pages of 2
        self.assertEqual(self.api.calls("GET", r"/v1/blocks/.*/children"), [])

    def test_manual_run_returns_recent_pages_without_state(self):
        response = self.poll(mode="manual")
        self.assertEqual(len(jsons(response)), 5)
        self.assertNotIn("pollState", response)

    def test_users_forbidden_leaves_authors_empty(self):
        self.notion.users_forbidden = True
        first = self.poll()
        self.notion.edit("p-kickoff")
        items = jsons(self.poll(state=first["pollState"]))
        self.assertIsNone(items[0]["actorEmail"])

    # ------------------------------------------------------- node operations

    def run_node(self, parameters, **kwargs):
        return execute(self.plugin, "notion", parameters, credentials=self.creds, **kwargs)

    def test_changed_since(self):
        self.notion.edit("p-kickoff", at=ago(hours=2))
        self.notion.edit("p-acme", at=ago(hours=1))
        response = self.run_node({"resource": "page", "operation": "changedSince", "since": ago(hours=3), "limit": 1})
        items = jsons(response)
        self.assertEqual([i["title"] for i in items], ["Kickoff notes"])
        self.check_shape(items[0], extra=["cursor"])
        self.assertEqual(items[0]["cursor"], self.notion.pages["p-kickoff"]["last_edited_time"])
        bad = self.run_node({"resource": "page", "operation": "changedSince", "since": "yesterday"})
        self.assertIn("'Since' must be an ISO time", bad["error"]["message"])

    def test_get_content_reads_nested_blocks(self):
        self.notion.blocks["p-kickoff"].append({"object": "block", "id": "toggle", "type": "toggle", "has_children": True,
                                                "toggle": {"rich_text": [{"plain_text": "Details"}]}})
        self.notion.blocks["toggle"] = [{"object": "block", "id": "todo", "type": "to_do", "has_children": False,
                                         "to_do": {"rich_text": [{"plain_text": "Send the contract"}], "checked": True}}]
        item = jsons(self.run_node({"resource": "page", "operation": "getContent",
                                    "pageId": "p-kickoff"}))[0]
        self.check_shape(item, extra=["text"])
        self.assertEqual(item["text"], "Agenda: pricing\nNext step: a pilot in December\nDetails\n[x] Send the contract")

    def test_list_users_and_comment(self):
        self.notion.page_cap = 2
        users = jsons(self.run_node({"resource": "user", "operation": "getAll", "returnAll": True}))
        self.assertEqual([(u["name"], u["email"], u["type"]) for u in users],
                         [("Dana", "Dana@Example.com", "person"), ("Lee", "lee@example.com", "person"), ("Landflow", None, "bot")])
        self.notion.users_forbidden = True
        denied = self.run_node({"resource": "user", "operation": "getAll"})
        self.assertIn("can't read users", denied["error"]["message"])

        created = jsons(self.run_node({"resource": "comment", "operation": "create", "commentPageId": "p-kickoff", "commentText": "Looks related to Atlas"}))
        self.assertEqual(created[0]["id"], "c1")
        self.assertEqual(self.notion.comments[0], {"rich_text": [{"type": "text", "text": {"content": "Looks related to Atlas"}}],
                                                   "parent": {"page_id": "p-kickoff"}})
        self.run_node({"resource": "comment", "operation": "create", "commentText": "Agreed", "discussionId": "d1"})
        self.assertEqual(self.notion.comments[1]["discussion_id"], "d1")
        self.assertNotIn("parent", self.notion.comments[1])

    def test_older_operations_keep_their_version(self):
        self.api.route("GET", "/v1/pages/p1", {"object": "page", "id": "p1", "url": "u", "properties": {}})
        self.run_node({"resource": "page", "operation": "get", "pageId": "p1"})
        self.assertEqual(self.api.requests[-1]["headers"]["notion-version"], "2022-06-28")


class HelperTests(unittest.TestCase):
    def test_roots_and_hints(self):
        self.assertEqual(roots_of("https://www.notion.so/x/Wiki-0123456789abcdef0123456789abcdef?pvs=4,\nabc"),
                         ["0123456789abcdef0123456789abcdef", "abc"])
        self.assertEqual(hint_after(["Customers", "Acme", "Notes"], "customers"), "Acme")
        self.assertIsNone(hint_after(["Customers"], "Customers"))
        self.assertEqual(norm_id("01234567-89AB-cdef-0123-456789abcdef"), "0123456789abcdef0123456789abcdef")


if __name__ == "__main__":
    unittest.main()
