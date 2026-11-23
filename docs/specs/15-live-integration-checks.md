# Live checks of the Landfall node/trigger and the GitHub MCP tools

This is a verification plan, not a feature. It closes the "checked against a fake only" statements in
[limitations.md](../limitations.md): the **Alert triage and Landfall** bullet (the Landfall node and trigger "were built
from Landfall's API and checked against a local fake (`pnpm fake-landfall`), not a live Landfall") and the **GitHub MCP
tools for agents** bullet ("checked against the image but not against GitHub with a real token"), plus the GitHub plugin's
"Stripe, Slack, GitHub and Microsoft Teams were checked against local fakes only".

## Problem

Both integrations are proven only against fakes. `plugins/landfall/test/fake-landfall.ts` encodes our reading of Landfall's
API (paths under `/o/<org>/...`, 409 and 422, the 300 requests a minute limit); `apps/web/test/github-mcp.test.ts` runs a
fake MCP server that lists the real tool names of github-mcp-server v2.0.2. Neither shows that the real services accept
what we send, that the allow-list names match what the server actually calls, or that the trigger polls correctly.
[a2a.md](../a2a.md#githubs-mcp-tools-for-agents) says in so many words: "No call was made to GitHub, as no GitHub token was used."

## Goals / Non-goals

Goals: a short, repeatable runbook; a pass/fail list per capability; a place to record results; no token ever lands in
the repository, `docs/`, `deploy/.env.example`, logs or screenshots.

Non-goals: new product code (beyond optional gated live tests, below); load testing; checking Slack, Stripe or Teams.

## Constraints that shape the plan (CLAUDE.md)

- **Dev credentials only** (`deploy/.env.example`): it holds no GitHub token and no Landfall key. So anything touching
  the real GitHub or a real Landfall needs a token the user supplies for the occasion. Do not borrow a token from the
  machine (a `gh auth` login, `~/.config`, shell history, `~/.aws`). Ask, every time.
- **Local only**: nothing deploys to a cloud and no image is pushed. Landflow itself runs on OrbStack
  (`--context orbstack`, namespace `landflow-dev`). Outbound HTTPS from this machine to `api.github.com` or a Landfall URL
  with a user token is a call to a third party, not a deployment; still get the user's explicit go-ahead and use the least
  scope. AWS is irrelevant here and stays at LocalStack.
- **Public repo** (`github.com/landfalls-ai/landflow`): scan the diff for tokens before any push; record results as
  "passed on <date>" without identifiers, never paste responses that contain private repository names or incident text.
- Touch only the `landflow-*` compose projects and the `landflow-dev` namespace; don't prune.
- Build with `COMPOSE_BAKE=false`; cluster images with `docker --context orbstack buildx build --builder orbstack --load`.

## What can be checked locally with no token

1. **Fake parity** (`pnpm --filter @landflow/plugin-landfall test`, `cd apps/web && npx vitest run test/github-mcp.test.ts`):
   baseline stays green.
2. **The real GitHub MCP server image, offline** (the 2026-11-01 check, made repeatable): deploy
   `deploy/k8s/components/github-mcp` with `kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack`
   (Service `landflow-github-mcp:8082`, image `ghcr.io/github/github-mcp-server:v2.0.2`), then
   `kubectl --context orbstack -n landflow-dev port-forward svc/landflow-github-mcp 8082:8082` and send `initialize` and
   `tools/list` with a dummy bearer. Expect the tool list = toolsets `repos,issues,pull_requests,actions` minus the
   `--exclude-tools` set. Diff it against `githubAllowedTools()` in `apps/web/src/lib/server/mcp/github.ts`: every allowed
   name must exist in the server's list, and no merge/write tool may appear. This catches a renamed tool before a token is involved.
3. **Failure paths of the real server with a dummy token**: `tools/call` returns GitHub's 401 shaped as an MCP error;
   check that Landflow surfaces it on the agent's tool call and in Run Trace (no hang, the token is not echoed).
4. **Landfall node and trigger against the fake, end to end in the app**: `pnpm fake-landfall`, `pnpm plugin:landfall`,
   run the Alert triage flow and the trigger with `POST /_fake/incidents/:id/status` (the documented fake controls).
   Not a live check, but the baseline the live run is compared with.
5. **Redaction**: run an agent with the GitHub MCP tool using an obviously fake token string; confirm the string appears
   nowhere in the journal, audit log, `docker logs` or `kubectl logs` (the credential is meant to be redacted by `redactRunData`).

## What needs the user to supply a token

### GitHub MCP tools (agents)

Needed: a **fine-grained personal access token** on one scratch repository the user owns (never a classic token, never
org-wide), with Pull requests and Contents read; add Pull requests write only for check 5. Entered by the user in
Credentials as **Bearer Auth** (`core.httpBearerAuth`); the plan never sees or copies it. Use a throwaway open PR.

| # | Check | Expected |
|---|---|---|
| 1 | Agent with **Add GitHub MCP**, access Read: ask for the PR's changed files and a file's contents | `pull_request_read`, `get_file_contents` answer with real data; Run Trace shows "GitHub MCP, Tool, repositories, pull requests, issues (read)" |
| 2 | Same agent asks to comment or merge | no such tool offered; the model says it cannot; GitHub shows no change |
| 3 | Rate-limit/404 on a missing repo | clean error, not a hang |
| 4 | Token with no access to a second repo, ask about it | 404/403 from GitHub reaches the agent; the token scope is the only per-repo limit (as documented) |
| 5 | Access Review: `pull_request_review_write` pending review plus `add_comment_to_pending_review` on the throwaway PR, with **Require approval** on | the approval pauses first; after approval the comment shows on GitHub and a **review comment** artifact appears in Run Trace |
| 6 | Claude Code member on kagent through `/api/mcp/agents/:id` (`?tools=approval`) | same tools; Landflow, not kagent, holds the token |

Also exercise the **GitHub node** (`plugins/github`, `DEFAULT_BASE_URL = https://api.github.com`) on the same scratch repo:
Get PR, Compare, Commit (a file), Create PR comment, with a token of the needed scope. This closes the plugin's
"checked against local fakes only" and the known gaps listed there (no delete, no draft-ready, 422 on a moved branch).
Webhook triggers (GitHub App webhook) need a public URL to reach this machine: skip, or only with a tunnel the user
chooses to open; do not set one up unasked.

### Landfall node and trigger

Needed from the user, per [triage.md](../triage.md#landfall-setup): the Landfall base URL, an `lf_key_...` API key with member
rights, and for Open from Alert / Recover the remote-source connection (ingest token and connection ID). Heartbeat needs
that heartbeat's own token. Use a test organization or a throwaway incident prefix, not a production room.

| # | Check | Expected |
|---|---|---|
| 1 | Credential test and **Incident: Get Many** | 200; field names match what `plugins/landfall/src` reads (compare to the fake) |
| 2 | **Declare** / **Open Manually**, then **Get**, **Timeline: Add Note**, **Add Event**, **Get Events** | the room and its notes appear in Landfall; item shape stable |
| 3 | **Open from Alert** | 422 until the remote-source connection exists and is healthy; with it, 201. This needs Landfall to reach `LANDFALL_SOURCE_PORT` on this machine: if Landfall is hosted, it cannot reach `localhost`. Options: a Landfall running locally, or a tunnel the user opens. Do not open one unasked |
| 4 | 409 on opening the same alert twice, and the node's handling | error message matches `docs/triage.md` safety rules |
| 5 | Rate limit | one 429 waited out (`Retry-After` up to 10 s) |
| 6 | **Landfall Trigger**: room opened, ended, new timeline events (it polls) | one run per event, no duplicates over two polls; at most 20 timelines read per poll |
| 7 | **Record Applied Externally**, **Heartbeat: Ping** (`POST /o/<org>/heartbeats/<name>/ping`) | accepted |

## Implementation plan

1. Write the offline checks (2, 3, 5) as a script `deploy/scripts/live-check-github-mcp.sh` (new) that prints the tool
   diff; it needs the cluster only. Prove it by running it once and recording the result in the history row.
2. Optionally add live-gated vitest files: `apps/web/test/github-mcp-live.test.ts` and `plugins/landfall/test/live.test.ts`,
   skipped unless `LANDFLOW_INTEGRATION` names `github` / `landfall` and the token is in the process environment
   (`LANDFLOW_LIVE_GITHUB_TOKEN`, `LANDFLOW_LIVE_LANDFALL_KEY`, new). Add the flags to the table in `docs/development.md`.
3. Ask the user for the tokens (scope and repo as above); run the tables above in a scratch host that leaves
   `apps/web/.data` alone (see "Checking a change live" in `docs/development.md`), tokens entered through the UI.
4. Record results; update docs; scan for secrets; commit with a history row.

## Docs to update

`docs/limitations.md` (replace the two "fake only" statements by what was checked, with the date; keep whatever stays
unchecked, such as Landfall's source face reached from a hosted Landfall), `docs/a2a.md` (the "No call was made to
GitHub" sentence), `docs/triage.md` (Trying it locally: a live section), `docs/development.md` (new flags),
`docs/roadmap.md`, `docs/history.md`.

## Risks and open questions

- A real token in a browser screenshot, a terminal log, or the live-check script's output: pass tokens by environment or the
  credentials UI only, and never `set -x`.
- Landfall's API may differ from the fake in ways that need node changes; the live run may turn into a bug-fix task.
  Timebox, and record the differences as fake updates first.
- Whether a hosted Landfall can ever reach a local source face: needs the user's decision on a tunnel.
- GitHub's secondary rate limits can trip on the read loop; keep the scratch repo small.
- v2.0.2 is pinned; a later image needs the tool diff (step 2) rerun.

## Effort and first slice

Effort: S for the offline part, M including the live runs (mostly waiting on the user's tokens).

First slice: the offline diff of the real `landflow-github-mcp` image's `tools/list` against `githubAllowedTools()`, plus the
dummy-token failure path. Needs the cluster and no token, and it is the part most likely to find a silent mismatch.
