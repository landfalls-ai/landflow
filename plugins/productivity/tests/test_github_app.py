"""GitHub App authentication: app JWT -> installation token (cached, refreshed), installation discovery, the nodes with
``authentication: githubApp`` and the webhook trigger registered through the app. Against a fake GitHub that verifies the JWT signature."""

from __future__ import annotations

import time
import unittest
from datetime import datetime, timezone
from unittest import mock

from _support import execute, FakeApi, jsons, jwt_claims, make_plugin, rsa_key
from _webhook_transports import Direct, Http
from test_github_webhook import REPO, URL, FakeHooks, delivery, method_request

from productivity import github_app

APP_ID = "424242"
INSTALLATION = "7777"
KEY = rsa_key("pkcs1")


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeGitHubApp:
    """GitHub's app endpoints: ``/app`` and ``/repos/{o}/{r}/installation`` take the app JWT (signature and ``iss`` checked),
    ``POST /app/installations/{id}/access_tokens`` mints ``ghs_<n>`` tokens, and the repository API accepts only the live ones."""

    def __init__(self, api: FakeApi, key: str = KEY) -> None:
        self.api, self.key = api, key
        self.live: set[str] = set()
        self.minted = 0
        self.lifetime = 3600
        self.jwt_claims: list[dict] = []
        api.route("GET", "/app", self._app)
        api.route("GET", "/app/installations", lambda r: self._jwt(r) or [{"id": int(INSTALLATION)}])
        api.route("GET", r"/repos/octo/demo/installation", lambda r: self._jwt(r) or {"id": int(INSTALLATION), "app_id": int(APP_ID)})
        api.route("GET", r"/repos/octo/other/installation", lambda r: self._jwt(r) or (404, {"message": "Not Found"}))
        api.route("POST", rf"/app/installations/{INSTALLATION}/access_tokens", self._mint)
        api.route("GET", r"/repos/octo/demo/issues/7", lambda r: self._installation(r) or {"number": 7, "title": "Bug", "state": "open"})
        api.route("GET", "/installation/repositories", lambda r: self._installation(r) or {"total_count": 1, "repositories": [
            {"full_name": "octo/demo", "description": "Demo"}]})
        api.route("GET", "/user/repos", (403, {"message": "Resource not accessible by integration"}))

    def _jwt(self, record: dict):
        auth = record["headers"].get("authorization", "")
        claims = jwt_claims(auth[7:], self.key) if auth.startswith("Bearer ") else None
        if claims is None or claims.get("iss") != APP_ID or claims["exp"] < time.time():
            return 401, {"message": "A JSON web token could not be decoded"}
        self.jwt_claims.append(claims)
        return None

    def _app(self, record: dict):
        return self._jwt(record) or {"id": int(APP_ID), "slug": "landflow-bot", "name": "Landflow Bot"}

    def _mint(self, record: dict):
        denied = self._jwt(record)
        if denied:
            return denied
        self.minted += 1
        token = f"ghs_token{self.minted}"
        self.live.add(token)
        return 201, {"token": token, "expires_at": iso(time.time() + self.lifetime), "permissions": {"issues": "write"}}

    def _installation(self, record: dict):
        auth = record["headers"].get("authorization", "")
        if auth.removeprefix("Bearer ") not in self.live:
            return 401, {"message": "Bad credentials"}
        return None


def creds(api: FakeApi, **extra) -> dict:
    return {"githubAppApi": {"appId": APP_ID, "privateKey": KEY, "baseUrl": api.url, **extra}}


@unittest.skipIf(KEY is None, "openssl is not installed")
class GitHubAppTests(unittest.TestCase):
    def setUp(self):
        github_app._tokens.clear()
        github_app._installations.clear()
        self.api = FakeApi().__enter__()
        self.github = FakeGitHubApp(self.api)
        self.plugin = make_plugin()

    def tearDown(self):
        self.api.__exit__()

    def get_issue(self, **extra):
        return execute(self.plugin, "github", {"authentication": "githubApp", "resource": "issue", "operation": "get", "owner": "octo",
                                               "repository": "demo", "issueNumber": 7}, credentials=creds(self.api, **extra))

    def test_installation_found_from_the_repository_token_minted_once_and_cached(self):
        first = jsons(self.get_issue())
        self.assertEqual((first[0]["number"], first[0]["title"]), (7, "Bug"))
        jsons(self.get_issue())
        self.assertEqual(len(self.api.calls("GET", REPO + "/installation")), 1)
        self.assertEqual(len(self.api.calls("POST", rf"/app/installations/{INSTALLATION}/access_tokens")), 1)
        self.assertEqual(len(self.api.calls("GET", REPO + "/issues/7")), 2)
        self.assertEqual(self.api.calls("GET", REPO + "/issues/7")[0]["headers"]["authorization"], "Bearer ghs_token1")
        claims = self.github.jwt_claims[0]
        self.assertEqual((claims["exp"] - claims["iat"], claims["iss"]), (600, APP_ID))
        self.assertLess(abs(claims["iat"] - (time.time() - 60)), 10)

    def test_configured_installation_id_skips_discovery(self):
        jsons(self.get_issue(installationId=INSTALLATION))
        self.assertEqual(self.api.calls("GET", REPO + "/installation"), [])
        self.assertEqual(self.github.minted, 1)

    def test_token_is_renewed_a_minute_before_it_expires(self):
        now = time.time()
        jsons(self.get_issue())
        with mock.patch.object(github_app, "_now", lambda: now + 3600 - 61):
            jsons(self.get_issue())
        self.assertEqual(self.github.minted, 1)
        with mock.patch.object(github_app, "_now", lambda: now + 3600 - 59):
            jsons(self.get_issue())
        self.assertEqual(self.github.minted, 2)
        self.assertEqual(self.api.calls("GET", REPO + "/issues/7")[-1]["headers"]["authorization"], "Bearer ghs_token2")

    def test_a_401_mints_a_new_token_and_retries_once(self):
        jsons(self.get_issue())
        self.github.live.clear()  # revoked on GitHub's side
        self.assertEqual(jsons(self.get_issue())[0]["number"], 7)
        self.assertEqual(self.github.minted, 2)
        # A key GitHub does not accept never loops: one retry, then the error.
        self.github.live.clear()
        self.api.route("POST", rf"/app/installations/{INSTALLATION}/access_tokens", (201, {"token": "ghs_dead", "expires_at": iso(time.time() + 3600)}))
        failed = self.get_issue()
        self.assertIn("HTTP 401", failed["error"]["message"])

    def test_app_not_installed_on_the_repository(self):
        response = execute(self.plugin, "github", {"authentication": "githubApp", "resource": "issue", "operation": "get", "owner": "octo",
                                                   "repository": "other", "issueNumber": 1}, credentials=creds(self.api))
        self.assertIn("not installed on octo/other", response["error"]["message"])

    def test_wrong_private_key_is_rejected_by_github(self):
        other = rsa_key("other")
        response = execute(self.plugin, "github", {"authentication": "githubApp", "resource": "issue", "operation": "get", "owner": "octo",
                                                   "repository": "demo", "issueNumber": 7}, credentials={"githubAppApi": {**creds(self.api)["githubAppApi"], "privateKey": other}})
        self.assertIn("HTTP 401", response["error"]["message"])

    def test_unreadable_key_explains(self):
        response = self.get_issue(privateKey="not a key")
        self.assertIn("GitHub App", response["error"]["message"])
        self.assertIn("PEM", response["error"]["message"])
        self.assertNotIn("not a key", str(response.get("logs")))

    def test_repository_picker_lists_installation_repositories(self):
        options = self.plugin.load_options("github", "getRepositories", {"authentication": "githubApp"}, creds(self.api))
        values = [o["value"] for o in options]
        self.assertEqual(values, ["", "octo/demo"])
        self.assertEqual(self.api.calls("GET", "/user/repos"), [])

    def test_installation_without_repository_uses_the_only_installation(self):
        from landflow_sdk import HttpClient

        installation = github_app.GitHubApi(mock.MagicMock(http=HttpClient(self.plugin.telemetry)), creds(self.api)["githubAppApi"])
        self.assertEqual(installation._installation_id("/installation/repositories"), INSTALLATION)

    def test_credential_test(self):
        ok = self.plugin.test_credentials("githubAppApi", creds(self.api, installationId=INSTALLATION)["githubAppApi"])
        self.assertEqual(ok, {"ok": True, "message": "authenticated as GitHub App landflow-bot"})
        self.assertEqual(self.github.minted, 1)  # the installation is checked when one is configured
        bad = self.plugin.test_credentials("githubAppApi", {**creds(self.api)["githubAppApi"], "appId": "1"})
        self.assertFalse(bad["ok"])
        self.assertIn("HTTP 401", bad["message"])
        junk = self.plugin.test_credentials("githubAppApi", {**creds(self.api)["githubAppApi"], "privateKey": "junk"})
        self.assertFalse(junk["ok"])
        self.assertNotIn("junk\n", junk["message"])
        self.assertFalse(self.plugin.test_credentials("githubAppApi", {"appId": "1", "baseUrl": self.api.url})["ok"])

    def test_pkcs8_key_works_too(self):
        github_app._tokens.clear()
        github = FakeGitHubApp(self.api, key=rsa_key("pkcs8"))
        data = {**creds(self.api)["githubAppApi"], "privateKey": github.key}
        self.assertTrue(self.plugin.test_credentials("githubAppApi", data)["ok"])

    def test_the_trigger_and_the_github_trigger_poll_accept_the_app(self):
        self.api.route("GET", REPO + "/issues", lambda r: self.github._installation(r) or [{"id": 5, "number": 5}])
        state = jsons(execute(self.plugin, "githubTrigger", {"authentication": "githubApp", "owner": "octo", "repository": "demo", "event": "newIssue"},
                              credentials=creds(self.api)))
        self.assertEqual([s["number"] for s in state], [5])
        self.assertEqual(self.api.calls("GET", REPO + "/issues")[0]["headers"]["authorization"], "Bearer ghs_token1")


@unittest.skipIf(KEY is None, "openssl is not installed")
class AppWebhookMixin:
    transport: object

    def setUp(self):
        github_app._tokens.clear()
        github_app._installations.clear()
        self.api = FakeApi().__enter__()
        self.github = FakeGitHubApp(self.api)
        self.hooks = FakeHooks(self.api)
        self.creds = creds(self.api)
        # The hooks API takes installation tokens only (and rejects stale ones).
        guard = lambda route: lambda r: self.github._installation(r) or route(r)  # noqa: E731
        self.api.routes[:] = [(m, p, guard(route) if "/hooks" in p.pattern else route) for m, p, route in self.api.routes]

    def tearDown(self):
        self.api.__exit__()

    def test_hook_registered_through_the_app(self):
        t = self.transport
        params = {"authentication": "githubApp"}
        created = t.method(method_request("create", {}, self.creds, params))
        self.assertNotIn("error", created)
        static = created["staticData"]
        self.assertEqual(len(static["webhookSecret"]), 64)  # the per-hook random secret, not the app's
        sent = self.api.calls("POST", f"{REPO}/hooks")[0]
        self.assertEqual(sent["headers"]["authorization"], "Bearer ghs_token1")
        self.assertEqual(sent["json"]["config"]["secret"], static["webhookSecret"])
        self.assertIs(t.method(method_request("checkExists", static, self.creds, params)).get("exists"), True)

        # A delivery signed with the hook's secret starts a run (the app JWT / installation token play no part in it).
        received = t.webhook({**delivery(static, "push", {"ref": "refs/heads/main"}), "parameters": {"owner": "octo", "repository": "demo", "events": ["issues", "push"], **params}})
        self.assertEqual(received["items"][0]["json"]["event"], "push")

        # An hour later the installation token is stale: delete mints a new one and still works.
        self.github.live.clear()
        deleted = t.method(method_request("delete", static, self.creds, params))
        self.assertNotIn("error", deleted)
        self.assertEqual(self.hooks.hooks, {})
        self.assertEqual(self.github.minted, 2)

    def test_not_installed(self):
        failed = self.transport.method(method_request("create", {}, self.creds, {"authentication": "githubApp", "repository": "other"}))
        self.assertIn("not installed on octo/other", failed["error"]["message"])


class InProcessTests(AppWebhookMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.transport = Direct(make_plugin())


class HttpTests(AppWebhookMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.transport = Http(self, make_plugin())


if __name__ == "__main__":
    unittest.main()
