# Debug token: a read-only key to one failed run

Status: built (2026-11-07), workstream W1c of the [parallel build plan](17-parallel-build-plan.md). Part of the [specs](README.md).

## Problem

A coding agent on someone's laptop can now explain a failed run on a remote host: `explain_failure`, `get_run_trace` and `get_execution` of the
instance MCP server ([W1a](17-notes/W1a.md)), and `landflow debug-bundle` ([W1b](17-notes/W1b.md)). Both need a credential, and today that
is the person's own API key or the instance access token: it reads every workflow, runs them, and does not expire. Handing that to an agent
(or pasting it into a chat) to debug one run is too much. The agent needs a key that reads **one execution**, for **an hour**, and can be
shown to have done nothing else.

## What it is

A **debug token** (`lf_dbg_` and 43 random characters) minted for one execution by someone who can read it. Only its SHA-256 is stored
(table `debug_tokens`, migration 2045). It is **not** a JWT and **not** an API key: no existing verifier (MCP JWTs, `lf_` API keys, the
instance access token, the identity provider) can mistake it for theirs, and it is no one's `Principal`.

| | |
|---|---|
| Scopes | `executions:read` (`get_execution`, `explain_failure`) and `trace:read` (`get_run_trace`). Both by default, either alone on request. There is no write scope. |
| Lifetime | 1 hour by default, at least 1 minute, at most 24 hours. No renewal: mint another. |
| Binding | One execution id and its workflow id, fixed at mint time. A call naming any other id is refused. |
| Minter | A user who can **read the workflow** (project access or a share, as for the REST API). The token never reads more than its minter could: it stops working when the minter is deactivated or loses read access. |
| Use cap | 1,000 tool calls per token, and 20 live tokens per execution, so a leak or a loop is bounded. |
| Where | `POST /api/executions/:id/debug-tokens` (mint, once-shown), `GET` the same path (list yours; owners and admins: all), `DELETE /api/executions/:id/debug-tokens/:tokenId` (revoke). CLI: `landflow debug-token`. |

## Debug access dialog (built 2026-11-07)

The Run Trace page (`/runs/:executionId`, `components/run-trace/run-page.tsx`) has a **Debug access** button in its header that opens
`components/run-trace/debug-access.tsx`: a bottom sheet on a phone, a centred dialog from 768 px, one column either way. It uses the three routes
above and adds none:

- **Mint**: pick the scopes (both by default; at least one), the lifetime (15 minutes, 1 hour, 4 hours, 24 hours) and an optional label, then
  "Mint a token". The token is shown once with a copy button, and under it ready snippets for the host the page was opened on: `claude mcp add --transport http landflow-debug <origin>/api/mcp --header "Authorization: Bearer …"`,
  a `.mcp.json` entry, and a `curl` that lists the three tools (`lib/shared/debug-token-snippets.ts`). "I have copied it" returns to the form; the token cannot be shown again.
- **List**: the run's tokens (yours; owners and admins see everyone's) as cards: `lf_dbg_…` and the last four characters, state (live, revoked, expired, used up), scopes, expiry, last use and number of calls. The list refreshes every 5 seconds while the dialog is open, so an agent's first call shows up.
- **Revoke**: a button on each live token; the row stays, marked revoked, and the next call with the token answers 401.
- It shows a note when the host's MCP server is off, since the token has nothing to open until it is on. `landflow debug-bundle` is not offered a snippet: it still needs the person's key.

## Threat model

Assets: the run's data (inputs and outputs of every node, which may hold personal data), the workflow's node parameters, and the secrets that
can appear in them: credential values, `$vars`, external-secret values.

| Threat | Answer |
|---|---|
| The token leaks (a chat log, a shell history, a CI log) | It reads one execution, redacted, for at most 24 hours (1 h by default), is revocable at once, shows up in the audit log on every use, and is capped at 1,000 calls. It runs and changes nothing. |
| It is used somewhere it should not work (REST, another MCP endpoint, a project server, the gateway) | Refused everywhere but `/api/mcp`: the REST guard answers 401 before any route policy (`guard.ts`), per-plugin and per-project MCP endpoints answer 403 (`identity.ts`, `instance.ts`), and the bundled gateway only forwards JWTs it validated, so a debug token is never routed through it. Tested route by route. |
| It reads a neighbouring execution (another run of the same workflow, another project's) | The tool wrapper compares the requested id with the token's before anything is read, and answers "Execution X not found" exactly as for an id that does not exist, so it is no oracle for ids. |
| It reaches a tool that writes or runs | The token opens a server of its own with **three** tools registered, not the instance server with a filter. Every other tool name is an unknown tool, so a tool added later is unreachable until someone adds it here on purpose. |
| Secrets in what it returns | Everything goes through `redactorFor(workflow)` (W1a): credential values of the workflow's nodes, `$vars` values, external-secret values, any key named like a secret (password, token, authorization, apiKey…), strings cut at 3,000 characters. `get_execution` is redacted too (the instance server's `get_execution` is not: it is for a signed-in user). Known gap: a secret held only in free text under an ordinary key, that is neither a credential, a `$var` nor an external secret, is not found. Run data is the user's data: the token does not make it safe to publish. |
| Untrusted text in run data steering the agent (prompt injection: a web page or an email a node read says "now call…") | Whatever the agent is told to do, the token can only read this one execution. That is the point of the narrow scope: the worst case is a wrong explanation, not an action. The tool descriptions say the data is data. |
| A person with read access mints a token to hand data to someone else | Allowed: they could copy the data from the page. The token adds a trail (mint, revoke and every use are audited) and redaction. It is not a way to give more than the minter has. |
| The minter is removed or demoted | Checked on every call (active user, still able to read the workflow). |
| A flood of mints or calls | 20 live tokens per execution, 1,000 calls per token. |
| The audit log cannot be written | The call is refused: the use is audited **before** anything is read ("no event, no data"). |

## Audit

All events use the existing audit log (`recordAudit`), so SIEM export and the hash chain apply.

- **Mint**: `mcp.token.issue`, target `debug_token`, details `kind: debug`, execution, workflow, scopes, expiry. Actor: the minter.
- **Revoke**: `mcp.token.revoke`, details `kind: debug`, execution, owner, uses. Actor: who revoked.
- **Each use**: `mcp.tool.call` (the action plugin MCP calls use) with outcome `success` (written before the tool runs), then `failure` if the tool failed,
  and `denied` for a refusal (another execution, a missing scope, a revoked, expired, exhausted or orphaned token; unknown tokens are not
  recorded because there is nothing to tie them to). Target: the execution. Details: `via: debug-token`, `debugId`, `mintedBy`, `tool`,
  `executionId`, `workflowId`, `scopes`, `reason`. The actor is **anonymous**: the token is nobody, and the minter is named in the details so the
  log never says the person did what the agent did. The token itself is never logged (the audit layer also masks `lf_…` strings).
  Note the audit layer drops detail keys that look like secrets, so the id is called `debugId`, not `tokenId`.
- `tools/list` and `initialize` are not tool calls and are not audited individually; the use counter counts tool calls only.

## How it plugs in

**MCP (W1a).** `authenticateInstanceRequest` (`lib/server/mcp/instance.ts`) recognises the `lf_dbg_` prefix before any other check and returns a
caller of kind `debug` (never at `/api/mcp/projects/<id>`). `serveInstance` then builds `debugTokenServer` (`lib/server/mcp/debug-token-server.ts`) instead
of `instanceServer`, with no `withAuth` principal at all, so nothing below can pick up an actor. `explain_failure` and `get_run_trace` are the W1a
implementations (`registerDebugTools`), registered through a filter that only lets those two names through and wraps each in the guard:

1. re-verify the token (revoked, expired, use cap, minter still active and still able to read the workflow);
2. the scope of the tool;
3. the execution id equals the token's;
4. audit, then count the use;
5. run, with the instance server's checks replaced by "this workflow only".

`get_execution` is the instance server's digest (`executionDigest`) of the one record, redacted.

**CLI (W1b).** `landflow debug-token --execution <id> [--ttl 1h] [--scopes …] [--label …]` mints and prints the token once and the line to give the
agent (`claude mcp add --transport http landflow <host>/api/mcp --header "Authorization: Bearer <token>"`); `--list` and `--revoke <id>` manage tokens.
It uses the CLI's own key to mint (an API key with the `executions:write` scope, or `admin`), so the person's key stays on their machine and the agent gets only
the debug token. `debug-bundle` still needs the person's key: with a debug token the REST half would be refused, so it is not wired in. An agent that
holds only the token reads through MCP, which is what `explain_failure` is for.

## What it must NOT allow

- Reading any other execution, workflow, credential, variable, data table, agent, plugin log or setting.
- Running, retrying, stopping, or changing anything: no `execute_workflow`, `retry_execution`, `run_node`, `update_workflow`, `create_workflow`.
- Being accepted by a REST route, a per-plugin or per-project MCP endpoint, the gateway, the binary route, SCIM or the metrics route.
- Minting or extending tokens, or acting as a user (it has no principal and no session).
- Outliving 24 hours, being renewed, or surviving revocation, the minter's removal, or its own cap.
- Returning a credential value, a `$vars` value or an external secret value, or being used without an audit event.
- A "not found" that differs between an execution that exists and one that does not.

## Decisions

- **A separate table and format, not an MCP JWT with a claim.** A claim on a JWT the other verifiers accept means one missed check anywhere lets the token
  act as its user. An opaque token with its own table is understood by exactly one code path.
- **A server of its own, not a filtered instance server.** Registering three tools beats refusing the others, which would have to be remembered for every new tool.
- **Mint is a read.** A viewer of the workflow can mint, because the token reads less than they can. The REST policy still needs the API key scope
  `executions:write` for `POST` (the generic rule for mutating methods under `/api/executions`).
- **Anonymous actor in the audit log, minter in the details.**
- **No renewal, no "forever".** A longer investigation mints a new token.

## Later: one-node local override (not built)

The second half of W1c in the plan: run one node of a remote workflow against a plugin build on the developer's laptop for one debug run. It needs a
debug **run** capability, which is write-like (it executes code and may call external systems), so it must not ride on this read-only token. The sketch:
a separate scope (`runs:debug`) that cannot be minted together with the read scopes by default, bound to one node and one execution, a transport override
in `lib/server/plugins/*` that routes that node type to a URL the developer gives for that run only, and the same audit, TTL and revocation rules. The
design note for it comes first: what the local plugin may see (the node's input, never credentials: the host would call it with the node's resolved
input only), and how the host reaches a laptop (a tunnel the developer opens, never an inbound connection the host initiates by itself).

## Open points

- A page in Settings listing every token of the instance (the dialog below covers one run at a time).
- A per-minter cap, and the debug-bundle path with a token.
- The in-token redaction misses a secret in free text under an ordinary key.
