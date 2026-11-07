# W1c notes: the debug token (for the integrator)

Design: [19-debug-token.md](../19-debug-token.md). The one-node local override is NOT built (a "Later" paragraph in the note).

## docs/reference text (routes, variables, CLI)

Routes (all session or API key; the API key needs `executions:write` for POST and DELETE, `executions:read` for GET; the caller needs read access to the execution's workflow; also in `/api/openapi.json`, tag Executions):

| Route | Does |
|---|---|
| `POST /api/executions/{id}/debug-tokens` `{ ttlSeconds?, scopes?, label? }` | mints a debug token for the execution: `ttlSeconds` 60 to 86400 (default 3600), `scopes` of `executions:read`, `trace:read` (default both). 201 `{ token, record, mcp: { enabled, path } }`; the `lf_dbg_…` token is shown once. 404 for an execution the caller cannot read, 400 for a bad lifetime or scope, 409 at 20 live tokens |
| `GET /api/executions/{id}/debug-tokens` | the execution's tokens, yours (owners and admins: everyone's): id, hint, label, scopes, expiry, revocation, last use, `uses`; never the token |
| `DELETE /api/executions/{id}/debug-tokens/{tokenId}` | revokes it (its minter, owners, admins); `{ ok, revoked, record }`; takes effect on the token's next call |

Using it: `Authorization: Bearer lf_dbg_…` at `POST /api/mcp` (Streamable HTTP, the host's MCP server on). `tools/list` shows exactly three tools:
`explain_failure` and `get_execution` (scope `executions:read`), `get_run_trace` (`trace:read`), all for the token's one execution, redacted of
credentials, `$vars`, external secrets and secret-named keys. Every other tool, every REST route and the per-plugin and per-project MCP endpoints refuse it.
Each tool call is an `mcp.tool.call` audit event (actor anonymous, `via: debug-token`, `debugId`, `mintedBy`, execution). Limits: 24 h at most, 1,000 calls, 20 live tokens per execution.

CLI (`packages/cli/README.md` has the row): `landflow debug-token --execution <id> [--ttl 1h] [--scopes executions:read,trace:read] [--label t]`, `--list`, `--revoke <token id>`.

No new environment variable. New table `debug_tokens` (migration 2045, listed in `TABLES`).

## docs/limitations.md

- A debug token's redaction is the W1a one: credential values of the workflow's nodes, `$vars`, external secrets and secret-named keys. A secret that sits only in free text under an ordinary key is not found, and run data is still the user's data: the token is not safe to publish.
- Debug tokens work at `/api/mcp` on the host itself, not through the bundled gateway, and not at `/api/mcp/projects/<id>`. `landflow debug-bundle` needs the person's key (its REST half is refused with a debug token).
- There is no page for debug tokens yet: mint, list and revoke through REST or `landflow debug-token`. Dead tokens are purged on the next mint after a week.
- The one-node local override of W1c is not built (a design sketch is in docs/specs/19-debug-token.md).

## docs/roadmap.md

- W1c, first half built: a short-lived read-only debug token bound to one execution (`landflow debug-token`), accepted only by `explain_failure`, `get_run_trace` and `get_execution`, redacted, audited per call, expiring, listed and revocable. Open: the one-node local override (needs its own design for what the local plugin may see), a Settings or execution-page UI for tokens.

## docs/history.md row

| W1c | Debug token (docs/specs/19-debug-token.md): `lf_dbg_` opaque tokens bound to one execution, scopes `executions:read` and `trace:read`, 1 h default and 24 h at most, 1,000 calls, minter must keep read access; a three-tool MCP server (`explain_failure`, `get_run_trace`, `get_execution`) that is the only thing that accepts them, redacted, `mcp.tool.call` audit event per use (written before the data is read); REST `POST/GET /api/executions/{id}/debug-tokens`, `DELETE …/{tokenId}`; `landflow debug-token [--list] [--revoke]`. Decisions: a separate table and format rather than an MCP JWT claim, a server of its own rather than a filter, audit actor anonymous with the minter in the details, `debugId` not `tokenId` (the audit layer drops secret-looking keys). Not built: the one-node override. `lib/server/auth/debug-tokens.ts`, `lib/server/mcp/debug-token-server.ts`, tests `apps/web/test/debug-token.test.ts`, `packages/cli/test/debug-token.test.ts`. | (hash) |

## docs/README.md

New page: [specs/19-debug-token.md](../19-debug-token.md) (if the specs list is indexed there). The feature map row for the MCP server or the CLI can name the token and `landflow debug-token`.

## Files touched outside the strict list (small, for the integrator to know)

- `lib/server/mcp/identity.ts` (an explicit 403 for a debug token at plugin and project MCP endpoints), `lib/server/mcp/instance.ts` and `instance-route.ts` (the `debug` caller kind and its server), `lib/server/mcp/instance-tools.ts` (`export` on `executionDigest`), `lib/server/openapi.ts` (three operations), `lib/server/db/schema.ts` (migration 2045 and `TABLES`).
