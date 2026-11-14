# Public run report link: signed, expiring, read-only, redacted

## Problem

A run report (the Run Trace **Report** tab and the **Run Report** node's `report` artifact, `lib/shared/run-report.ts`
`buildRunReport()`) can be read only by a signed-in member. Sharing it with a client, a reviewer or a phone without an
account means copying Markdown out. The same gap is stated for flow share pages: [marketplace.md](../marketplace.md#share-pages)
("The page needs a signed-in member (`workflows:read`); it isn't public") and [limitations.md](../limitations.md) (Alert
triage bullet: "Flow share pages need a signed-in member of the instance; they aren't public links"). The only public
pages today are the sign-in pages and hosted chat (`PUBLIC_PAGES = ['/chat']`, `lib/shared/auth-paths.ts`).

## Goals / Non-goals

Goals
- From a run (or the Run Report node), a builder creates a link that opens a read-only, phone-first report with no
  sign-in, expires on a date, and can be revoked.
- The shared content is **frozen and redacted at creation**: the creator previews exactly what outsiders will see.
- Secrets, PII and chosen fields never leave; the link carries no way into the rest of the instance.
- Off by default; an owner/admin turns it on and caps the lifetime. Every create, revoke and view count is audited.

Non-goals
- Public flow share pages / marketplace pages (a follow-up reuses the token table with another `kind`).
- Live-updating reports for a run still in progress; only finished or waiting runs can be shared.
- Comments, edits or any write from the public page.

## Design

### Token: random and stored, not a stateless signature

The MCP file URLs use `signPayload()` (`lib/server/mcp/signing.ts`, HMAC under `LANDFLOW_BINARY_SECRET`). That secret is
a random per-process key when unset, so such links die on restart and differ between mains in queue mode, and a pure
signature cannot be revoked. Report links are therefore a 256-bit random token (`crypto.randomBytes(32)`, base64url) whose
SHA-256 is stored; the URL is `<LANDFLOW_PUBLIC_URL>/r/<token>`. "Signed" is satisfied by unguessability plus the stored
expiry; an optional second factor, a short passcode set by the creator (scrypt hash in the row), covers links pasted into
chat.

### Data model (new): migration `2070 run_report_shares`, plus `TABLES`

```sql
CREATE TABLE IF NOT EXISTS run_report_shares (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  execution_id TEXT NOT NULL, workflow_id TEXT NOT NULL, project_id TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
  passcode_hash TEXT, redaction TEXT NOT NULL,       -- the options used (JSON), shown to the creator
  report TEXT NOT NULL,                             -- the frozen, already redacted report (JSON)
  views BIGINT NOT NULL DEFAULT 0, last_viewed_at TEXT
);
CREATE INDEX IF NOT EXISTS run_report_shares_execution ON run_report_shares (execution_id);
CREATE INDEX IF NOT EXISTS run_report_shares_expiry ON run_report_shares (expires_at);
```

Frozen storage (not a live read of the journal) means redaction runs once, later journal changes cannot leak, and the link
survives journal pruning (`LANDFLOW_TRACE_RETENTION_DAYS`, default 30) until it expires. Deleting the execution deletes
its shares (hook next to `journal/store.ts` `deleteFor()`); expired rows are pruned daily by the leader (the same job that
prunes the journal).

### Building the frozen report (`lib/server/run-report-shares.ts`, new)

`readAll(executionId)` from `journal/store.ts` -> `foldJournal()` -> `buildRunReport()` with the workflow's profile, as the
Run Report node does (`nodes/run-report.ts`). Then redaction, in this order, each testable alone:
1. Always: `redactRunData()` (`lib/server/secrets/runtime.ts`), the same pass the journal writer applies, so known secret
   values are gone even if an older journal event predates a credential.
2. Content mode: the creator picks `full`, `summaries` (first 400 characters, the journal's own mode) or `off` (who did
   what and when only), never more than the workflow's `traceContent` kept.
3. PII and secret patterns: `runGuardrails()` (`lib/server/guardrails.ts`) in sanitize mode over every text, replacing
   or masking emails, phones, IPs, cards, IBANs and secret-shaped strings.
4. Structure options: hide actor names (the report says "Developer 1"), drop artifact URLs and file contents (keep names
   and counts), drop file paths and commands, drop failed-check evidence.
The result is a plain JSON `PublicRunReport` (a subset type in `lib/shared/run-report.ts`) with no execution, user,
workflow or credential ids.

### Routes

- `POST /api/executions/:id/report-shares` `{ expiresInDays, content, hideActors, hideArtifacts, passcode? }` -> `{ share, url,
  preview }` (the URL is returned once; only the hash is stored). `GET` lists shares of the run; `DELETE
  /api/executions/:id/report-shares/:shareId` revokes. Use `handler()`, `json()`, `error()`, `parseBody()`
  (`lib/server/http.ts`). `policy.ts`: `/api/executions` is `executions:read|write`; creating needs more, so add a rule
  before the generic one: creating or revoking requires `workflows:write` on the run's workflow (the resource rule maps
  an execution to its workflow) and the instance switch below. API keys need scope `executions:write`.
- `GET /api/public/run-reports/:token` (JSON) and the page `/r/:token`. Add `'/r'` to `PUBLIC_PAGES` and
  `'/api/public/run-reports'` to `PUBLIC_ROUTES` in `lib/shared/auth-paths.ts` ("add a public endpoint here, nowhere else").
  The public route authenticates by the token itself. Unknown, expired and revoked tokens all answer the same 404.
- `openapi.ts`: the three authenticated routes (tag "Runs"); the public route is documented with `security: []`.
- Gates (new): `LANDFLOW_PUBLIC_REPORT_LINKS` (default off; `1` allows creating links) and
  `LANDFLOW_PUBLIC_REPORT_MAX_DAYS` (default 14). Listed in `docs/reference/configuration.md`. A Settings -> Governance
  toggle is the better home long term (`governanceSchema` is a `strictObject`, so adding a key means a default in
  `DEFAULT_GOVERNANCE_POLICY` and the settings UI); start with the env var.

### Public page behaviour

`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, a strict CSP (no scripts
from elsewhere, no frames), server-rendered with no client call back to authenticated APIs, one column of cards (phone
first; no wide tables), a "Shared read-only on <date>, expires <date>" banner, no sidebar (like `/chat`). Views increment
`views` and `last_viewed_at`, not an audit row per view. Per-IP rate limit on the public route, shared through Valkey in
queue mode like the sign-in limits ([limitations.md](../limitations.md), Sign-in bullet; the per-IP limits trust
`X-Forwarded-For`).

### Audit and queue mode

`recordAudit()` events `run.report.share`, `run.report.revoke` (actor, execution, expiry, redaction options, never the
token). Queue mode: all state is in the database, so any main serves the link; nothing is held in process memory.

### Local-only

The URL base is `LANDFLOW_PUBLIC_URL`, which locally is `http://localhost:$PORT`; reaching it from a phone means the
LAN or a tunnel, which is the user's call and not something this work sets up.

## Implementation plan

1. Migration 2070 and `TABLES`; `run-report-shares.ts` with create/lookup/revoke/prune. Test: token hash round trip,
   expiry, revoke, prune (`apps/web/test/run-report-shares.test.ts`).
2. Redaction pipeline with the four stages. Test: a journal fixture with a credential value, an email and a file path;
   assert none appear at each setting.
3. Authenticated routes + policy rule + openapi + audit. Test: route tests as the synthetic owner; a viewer-role user
   and an API key without scope get 403; switch off gives 403 with a clear message.
4. Public route, page, auth-paths entries. Test: unauthenticated request works; expired/revoked/unknown are identical
   404s; headers present; `proxy` allows the path (`apps/web/test/auth-paths*.test.ts`).
5. UI: **Share report** on the Report tab (preview, options, copy link, list, revoke). Test: component test plus a
   manual phone-width check in the running app.
6. Rate limit and view counter. Test: limiter unit test.

## Docs to update

`docs/run-trace.md` (a "Share a report" section; remove nothing), `docs/features/audit-and-governance.md` (the events and
switch), `docs/reference/configuration.md` (two variables), `docs/reference/api.md`, `docs/limitations.md` (note that
reports, not flow pages, can be public), `docs/roadmap.md`, `docs/history.md`, and `docs/marketplace.md` if share pages later reuse the table.

## Risks and open questions

- Redaction is best-effort: pattern guardrails miss names and free-text secrets. The preview and the "Summaries" default
  are the mitigation; consider defaulting the first release to `summaries` and requiring a typed confirmation.
- An open report on the public internet is only as private as its URL; passcodes and short lifetimes matter. Should
  creating require four-eyes when governance four-eyes is on?
- Whether a report may include a team's notebook notes or approval evidence (`lib/shared/approval-evidence.ts`): exclude in v1.
- Frozen vs live: users may expect later "Needs you" decisions to show; offer "refresh" that creates a new freeze, same URL.

## Effort and first slice

Effort: M.

First slice: steps 1-4 with `summaries` content only, secret + guardrails redaction, 7-day default expiry, creation by
API and a minimal Share button; no passcode, no rate limit beyond a per-process cap, no structure options.
