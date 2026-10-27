"""OAuth2 variants of the GitHub, Notion, Airtable and HubSpot credentials: each node accepts the token type or the OAuth2 one,
reads the fresh ``accessToken`` the host sends on every call, and a refused token reads like a 401 (the host renews and retries)."""

from __future__ import annotations

import re
import unittest

from _support import TOKEN, FakeApi, execute, jsons, make_plugin

NOTION_PAGE = "0123456789abcdef0123456789abcdef"
# What the host's looksUnauthorized (apps/web credentials/oauth2.ts) treats as a refused token.
UNAUTHORIZED = re.compile(r"\b401\b|\bunauthori[sz]ed\b|invalid[_ ]token|(?:access )?token (?:has )?expired|expired[_ ]token", re.IGNORECASE)

# node, parameters, route (method, path, body), token credential (type, data key), OAuth2 type, expected output, the fixed OAuth2 URLs
CASES = [
    ("github", {"resource": "repository", "operation": "get", "owner": "octo", "repository": "demo"},
     ("GET", "/repos/octo/demo", {"full_name": "octo/demo"}), ("githubApi", "accessToken"), "githubOAuth2Api", {"full_name": "octo/demo"},
     ("https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token")),
    ("notion", {"resource": "page", "operation": "get", "pageId": NOTION_PAGE, "simplify": False},
     ("GET", f"/v1/pages/{NOTION_PAGE}", {"object": "page", "id": NOTION_PAGE}), ("notionApi", "apiKey"), "notionOAuth2Api", {"object": "page", "id": NOTION_PAGE},
     ("https://api.notion.com/v1/oauth/authorize", "https://api.notion.com/v1/oauth/token")),
    ("airtable", {"base": "appBase1", "table": "tblTasks", "operation": "get", "id": "recA"},
     ("GET", "/v0/appBase1/tblTasks/recA", {"id": "recA", "createdTime": "t", "fields": {"Name": "A"}}), ("airtableTokenApi", "accessToken"), "airtableOAuth2Api",
     {"id": "recA", "createdTime": "t", "Name": "A"}, ("https://airtable.com/oauth2/v1/authorize", "https://airtable.com/oauth2/v1/token")),
    ("hubspot", {"resource": "contact", "operation": "get", "contactId": "5"},
     ("GET", "/crm/v3/objects/contacts/5", {"id": "5", "properties": {"email": "c5@example.com"}}), ("hubspotAppToken", "appToken"), "hubspotOAuth2Api",
     {"id": "5", "email": "c5@example.com"}, ("https://app.hubspot.com/oauth/authorize", "https://api.hubapi.com/oauth/v1/token")),
]


class OAuth2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.api.__exit__()

    def setUp(self):
        self.api.reset()
        self.plugin = make_plugin()
        self.nodes = {n["name"]: n for n in self.plugin.manifest()["nodes"]}
        self.types = {c["name"]: c for c in self.plugin.manifest()["credentialTypes"]}

    def serve(self, route, token):
        """The API accepts exactly one access token and answers 401 like the real services to any other."""
        method, path, body = route
        self.api.route(method, re.escape(path) + "$", lambda r: body if r["headers"].get("authorization") == f"Bearer {token}" else (401, {"message": "Unauthorized"}))

    def test_oauth2_types_extend_the_generic_type_with_the_provider_urls_fixed(self):
        for node, _params, _route, _token, oauth2, _out, (auth_url, token_url) in CASES:
            ctype = self.types[oauth2]
            self.assertEqual(ctype["extends"], ["oAuth2Api"], oauth2)
            self.assertTrue(ctype["testable"], oauth2)
            hidden = {p["name"]: p["default"] for p in ctype["properties"] if p["type"] == "hidden"}
            self.assertEqual((hidden["authUrl"], hidden["accessTokenUrl"]), (auth_url, token_url), oauth2)
            self.assertIn(hidden["grantType"], ("pkce", "authorizationCode"), oauth2)
            self.assertIn(hidden["authentication"], ("header", "body"), oauth2)
            self.assertIn("scope", [p["name"] for p in ctype["properties"]], oauth2)
            self.assertTrue(ctype["documentationUrl"].startswith("https://"), oauth2)

    def test_scopes_and_provider_specifics(self):
        props = lambda name: {p["name"]: p for p in self.types[name]["properties"]}  # noqa: E731
        self.assertEqual(props("notionOAuth2Api")["authQueryParameters"]["default"], "owner=user")
        self.assertEqual(props("notionOAuth2Api")["authentication"]["default"], "header")
        self.assertIn("repo", props("githubOAuth2Api")["scope"]["default"].split())
        self.assertIn("data.records:write", props("airtableOAuth2Api")["scope"]["default"].split())
        self.assertIn("crm.objects.contacts.read", props("hubspotOAuth2Api")["scope"]["default"].split())
        self.assertEqual(props("airtableOAuth2Api")["grantType"]["default"], "pkce")  # Airtable requires PKCE

    def test_nodes_list_both_credential_types_picked_by_authentication(self):
        for node, _params, _route, (token_type, _key), oauth2, _out, _urls in CASES:
            description = self.nodes[node]
            expected = [
                {"name": token_type, "required": True, "displayOptions": {"show": {"authentication": ["accessToken"]}}},
                {"name": oauth2, "required": True, "displayOptions": {"show": {"authentication": ["oAuth2"]}}},
            ]
            values = ["accessToken", "oAuth2"]
            if node == "github":  # GitHub also takes a GitHub App installation (test_github_app.py)
                expected.append({"name": "githubAppApi", "required": True, "displayOptions": {"show": {"authentication": ["githubApp"]}}})
                values.append("githubApp")
            self.assertEqual(description["credentials"], expected, node)
            auth = next(p for p in description["properties"] if p["name"] == "authentication")
            self.assertEqual((auth["default"], [o["value"] for o in auth["options"]]), ("accessToken", values), node)
        for trigger in ("githubTrigger", "githubWebhookTrigger"):
            self.assertEqual([c["name"] for c in self.nodes[trigger]["credentials"]], ["githubApi", "githubOAuth2Api", "githubAppApi"])

    def test_every_node_accepts_either_credential_type(self):
        for node, params, route, (token_type, key), oauth2, expected, _urls in CASES:
            with self.subTest(node):
                self.api.reset()
                self.serve(route, TOKEN)
                token = {token_type: {key: TOKEN, "baseUrl": self.api.url}}
                oauth = {oauth2: {"accessToken": TOKEN, "baseUrl": self.api.url, "expiresAt": "2030-01-01T00:00:00.000Z"}}
                for credentials, authentication in [(token, None), (token, "accessToken"), (oauth, "oAuth2"),
                                                    # only the other type was sent: that one is used
                                                    (oauth, None), (oauth, "accessToken"), (token, "oAuth2")]:
                    response = execute(self.plugin, node, {**params, **({"authentication": authentication} if authentication else {})}, credentials=credentials)
                    self.assertEqual(jsons(response), [expected], (credentials, authentication))
                self.assertEqual(len(self.api.requests), 6)

    def test_the_named_credential_wins_when_both_arrive(self):
        node, params, route, (token_type, key), oauth2, expected, _urls = CASES[0]
        self.serve(route, "oauth-token-1")
        both = {token_type: {key: "pat-token", "baseUrl": self.api.url}, oauth2: {"accessToken": "oauth-token-1", "baseUrl": self.api.url}}
        self.assertEqual(jsons(execute(self.plugin, node, {**params, "authentication": "oAuth2"}, credentials=both)), [expected])
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer oauth-token-1")
        refused = execute(self.plugin, node, {**params, "authentication": "accessToken"}, credentials=both)
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer pat-token")
        self.assertIn("401", refused["error"]["message"])

    def test_a_renewed_token_is_used_at_once_and_a_refused_one_reads_like_a_401(self):
        for node, params, route, _token, oauth2, expected, _urls in CASES:
            with self.subTest(node):
                self.api.reset()
                self.serve(route, "token-2")
                call = lambda token: execute(self.plugin, node, {**params, "authentication": "oAuth2"},  # noqa: E731
                                            credentials={oauth2: {"accessToken": token, "baseUrl": self.api.url}})
                stale = call("token-1")
                self.assertTrue(UNAUTHORIZED.search(f"{stale['error']['message']} {stale['error'].get('description', '')}"), stale["error"])
                self.assertEqual(jsons(call("token-2")), [expected])
                self.assertEqual([r["headers"]["authorization"] for r in self.api.requests], ["Bearer token-1", "Bearer token-2"])

    def test_credential_tests_run_with_the_access_token(self):
        self.api.route("GET", "/user", lambda r: {"login": "octocat"} if r["headers"]["authorization"] == "Bearer good-token" else (401, {"message": "Bad credentials"}))
        self.api.route("GET", "/v1/users/me", lambda r: {"name": "Ada"} if r["headers"]["authorization"] == "Bearer good-token" else (401, {"message": "unauthorized"}))
        self.api.route("GET", "/v0/meta/whoami", lambda r: {"id": "usr1", "email": "ada@example.com"} if r["headers"]["authorization"] == "Bearer good-token" else (401, {"error": "AUTHENTICATION_REQUIRED"}))
        self.api.route("GET", "/crm/v3/objects/contacts", lambda r: {"results": []} if r["headers"]["authorization"] == "Bearer good-token" else (401, {"message": "bad"}))
        for oauth2, message in [("githubOAuth2Api", "authenticated as octocat"), ("notionOAuth2Api", "authenticated as Ada"),
                                ("airtableOAuth2Api", "authenticated as ada@example.com"), ("hubspotOAuth2Api", "HubSpot accepted the token")]:
            ok = self.plugin.test_credentials(oauth2, {"accessToken": "good-token", "baseUrl": self.api.url})
            self.assertEqual(ok, {"ok": True, "message": message}, oauth2)
            bad = self.plugin.test_credentials(oauth2, {"accessToken": "stale-token", "baseUrl": self.api.url})
            self.assertFalse(bad["ok"], oauth2)

    def test_load_options_accept_either_credential_type(self):
        self.api.route("GET", "/user/repos", [{"full_name": "octo/demo", "description": "d"}])
        self.api.route("GET", "/v0/meta/bases", {"bases": [{"id": "app1", "name": "Base 1"}]})
        for credentials in ({"githubApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}, {"githubOAuth2Api": {"accessToken": TOKEN, "baseUrl": self.api.url}}):
            options = self.plugin.load_options("github", "getRepositories", {}, credentials)
            self.assertEqual(options[-1]["value"], "octo/demo")
        for credentials in ({"airtableTokenApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}, {"airtableOAuth2Api": {"accessToken": TOKEN, "baseUrl": self.api.url}}):
            self.assertEqual([o["value"] for o in self.plugin.load_options("airtable", "getBases", {"authentication": "oAuth2"}, credentials)], ["app1"])

    def test_no_credential_at_all_says_which_one_is_missing(self):
        response = execute(self.plugin, "github", {"resource": "repository", "operation": "get", "owner": "o", "repository": "r", "authentication": "oAuth2"})
        self.assertIn("githubOAuth2Api", response["error"]["message"])


if __name__ == "__main__":
    unittest.main()
