# Guard enforcement outside the landflow-harness mod

Status: proposed. Closes the "Network and toolchains on kagent" bullet of [limitations.md](../limitations.md)
("What an agent may push (its branch only, never main, no merges) is in its instructions, not enforced: scope the token
... and protect `main` with a branch rule") and the mod bullet ("its rules match command lines, so a script that does
the same thing gets past them").

## Problem

The only thing stopping a Claude Code agent on kagent from pushing to `main` is the landflow-harness mod
(`apps/web/claude-plugins/landflow-harness/hooks/rules.ts`, `register.ts`). Its `git-push` rule and the three "ask"
cases (push to main/master, force push, delete remote branch) match command lines, so a script that pushes, or a tool the
rules don't know, gets past. The real limit is the GitHub token: `deploy/kind/egress-github.yaml` (`landflow-github`)
injects a fine-grained token at kagent's egress gateway for every agent that references the policy, and "the token's
scope is what limits the agents" ([a2a.md](../a2a.md#github-from-the-sandbox)). Nothing in Landflow checks that `main`
is protected, or refuses an agent whose token could land on it. The guard is also set per agent (`guard` on
`PUT /api/agents/:id/kagent`, `KAGENT_GUARDS` in `apps/web/src/lib/shared/agents.ts`), and `report` blocks nothing.

## Goals / Non-goals

Goals:
- At deploy time, find the GitHub token the agent's EgressPolicies would inject and check, with GitHub, that the
  default branch of the agent's repositories cannot be pushed to by it.
- A server-side policy: `deployToKagent` refuses (409) an agent whose reachable repository has an unprotected default
  branch, unless an owner records an explicit, audited override.
- Re-check on a schedule and before a run, so a rule removed later is noticed.
- Show the verdict in the Deploy tab and Run Trace's agent connections.

Non-goals:
- Judging what the agent does with a protected branch (that stays the mod's job).
- Managing GitHub branch rules for the user (read-only checks; no writes to GitHub).
- Tokens other than GitHub's, and git hosts other than github.com.

## Design

**What is checked.** For each repository in the agent's scope (new field `repositories: string[]` on the deploy input
and on `KagentDeployment` in `apps/web/src/lib/shared/agents.ts`; empty means "unknown", which the policy treats per
the mode below), call GitHub with the token the agent's EgressPolicies inject:
1. `GET /repos/{owner}/{repo}`: `default_branch`, and `permissions.push` of the token's user. A token with no push
   right passes at once.
2. `GET /repos/{owner}/{repo}/rules/branches/{default_branch}`: the active rules, which cover rulesets and classic
   protection and need only read access. Pass when it contains `pull_request` (or `update`/`non_fast_forward` plus no
   bypass visible) rules.
3. If the token also has Administration read: `GET .../branches/{b}/protection` for `required_pull_request_reviews` and
   `enforce_admins`. Not required, because fine-grained tokens usually lack it.
The verdict is `protected | unprotected | unknown` with a reason string. `unknown` (API error, 404 on a private repo
without access, rate limit) is never reported as protected.

**Finding the token.** `landflow-github` reads the Secret `github-git` (keys `token`, `basic`) in the kagent namespace
by `secretKeyRef`. Landflow's Role (`deploy/kind/landflow-access.yaml`, rule `secrets: get`) can already read Secrets
in that namespace and `egresspolicies` objects. New helper `apps/web/src/lib/server/kagent/guard-check.ts`: read each
EgressPolicy named in `egressPolicies` (via `getObject` in `kagent/kube.ts`), collect `secretKeyRef`s used for headers
of `github.com`/`api.github.com`, read the Secret, call GitHub from the main (not from the sandbox), and never log or
store the token (only a SHA-256 prefix, to tell tokens apart).

**Policy.** New setting `LANDFLOW_AGENT_PUSH_POLICY=off|warn|enforce` (new env var; also a row in Settings → Security next
to `apps/web/src/app/api/settings/security/route.ts`). `enforce` (default on the local stack once shipped): a deploy whose
verdict is `unprotected`, or `unknown` with a push-capable token, fails with `KagentError(..., 409)` naming the
repository and the fix. `warn`: deploy goes ahead and the verdict is shown. The mod's guard is independent: a `report`
guard with an `unprotected` repository is refused under `enforce` too, which is the point.

**Data model.** One table, migration sketched as `2042` (renumber at merge, the last shipped one is `2041`
`agent_asks_edited_command`): `agent_push_checks(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, repository TEXT NOT NULL,
verdict TEXT NOT NULL, reason TEXT, default_branch TEXT, token_hint TEXT, checked_at TEXT NOT NULL, override_by TEXT,
override_reason TEXT, override_until TEXT)` with an index on `(agent_id, repository)`; also add to `TABLES` with key
`['id']`. The latest verdict is also copied onto `KagentDeployment.pushCheck` (small summary) so the Deploy tab needs no
join.

**Routes.**
- `GET /api/agents/:id/kagent` (exists) gains `pushChecks` in its payload; `PUT` accepts `repositories` and `override`
  (`{ repository, reason, days }`, owner only, audited with `recordAudit` as the pause route does).
- `POST /api/agents/:id/kagent/push-check` (new): run the check now, return verdicts. Under `/api/agents`, which
  `policy.ts` line 74 already covers for members; the override needs the owner role (new rule in `policy.ts`). Add the
  routes to `openapi.ts` where the kagent routes are described.

**Run time.** Before an A2A call to a deployed agent (`apps/web/src/lib/server/a2a/client.ts` entry used by the A2A Agent
node and Run a Team), refuse when the stored verdict is `unprotected` or older than `LANDFLOW_AGENT_PUSH_CHECK_MAX_AGE_HOURS`
(new, default 24) under `enforce`. A background re-check runs on the maintenance loop (`maintenance.ts`).

**Queue mode.** Checks are idempotent reads; any main may run one. The table is the shared state. The scheduled
re-check takes the leader lock like other maintenance (see `features/engine.md` queue section).

**Local-only constraints.** GitHub is not AWS, but CLAUDE.md forbids unrelated deploys and credentials: use only a token the
user already stored as `github-git`. Tests use a local fake GitHub (like the plugins' fakes), never the real API. No
changes to the cluster beyond the existing Role (read of Secrets and EgressPolicies is already granted).

## Implementation plan

1. `guard-check.ts`: pure function from GitHub JSON (repo, rules, protection) to verdict. Test: `apps/web/test/kagent-guard.test.ts`
   with fixtures for ruleset, classic protection, no rule, no push right, 403/404, rate limit.
2. EgressPolicy and Secret resolution with a fake kube client (pattern in `apps/web/test/kagent.test.ts`).
3. Migration `2042` and store functions; test: schema test that every table is in `TABLES`.
4. Hook the check into `deployToKagent` (`kagent/deploy.ts`, after `checkEgressPolicies`), behind
   `LANDFLOW_AGENT_PUSH_POLICY`. Test: deploy refused with 409 on `unprotected`; allowed on `warn`; override recorded.
5. Routes, policy and openapi entries. Test: route tests as a synthetic owner; a member cannot override.
6. Run-time check in the A2A client plus the maintenance re-check. Test: stale verdict refuses a call.
7. UI: verdict chip on the Deploy tab kagent card and in Run Trace's connections.

## Docs to update

[a2a.md](../a2a.md#github-from-the-sandbox) and the mod section; [reference/api.md](../reference/api.md) and the
environment variable reference under `docs/reference/`; [limitations.md](../limitations.md) (rewrite the "not enforced"
sentence; keep the script-bypass remark for the mod); [roadmap.md](../roadmap.md); [run-trace.md](../run-trace.md) connections;
`docs/history.md` rows.

## Risks and open questions

- A fine-grained token cannot always read rulesets; `unknown` will be common. Decide whether `unknown` blocks (safer)
  or warns; the spec blocks only when `permissions.push` is true or unreadable.
- Bypass actors and "allow force pushes" for admins may make a protected-looking branch pushable; document it.
- Which repositories does an agent touch? Today nothing binds an agent to one. The `repositories` field is the answer
  but needs the user to fill it; a fallback is the repositories of the flow's GitHub nodes.
- The token is read by the main from a cluster Secret: confirm this is acceptable beyond the Role comment ("the token
  kagent calls an agent's tools with, and a model's API key").

## Effort and first slice

Effort: **M**.
First slice: steps 1, 2 and 4 with `warn` only: the verdict function plus a deploy-time check that records and shows
"main can be pushed to by this agent's token" without refusing anything.
