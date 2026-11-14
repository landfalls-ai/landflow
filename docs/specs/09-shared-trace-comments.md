# Shared Run Trace line comments

## Problem

[limitations.md](../limitations.md) (Run Trace): "line comments on diffs live in one browser (not shared, and they
reach the agents only through a Run report's Send back)", and [roadmap.md](../roadmap.md) (~line 995): "line comments
shared between people (they live in one browser)". Today `apps/web/src/components/run-trace/line-comments.tsx`
keeps them in `localStorage` per execution id; `lib/shared/line-comments.ts` defines `LineComment` and
`lineCommentsNote()`. A reviewer on a phone cannot see what a colleague wrote on the same diff, and a private window or
second device loses the review.

## Goals / Non-goals

Goals:
- Store comments server-side per run, visible to everyone who can open the run (workflow access, `canResource` in `lib/server/projects/access.ts`).
- Several reviewers add, resolve and delete comments; changes appear live in other open views.
- Send back keeps working: the gate note is built from the stored, unresolved comments and still reaches the agents through `POST /api/executions/:id/gate`.
- Move any browser-local comments to the server once, without loss.

Non-goals:
- Threads, mentions, notifications by email or Slack (a later wave; the audit event leaves room).
- Comments outside diffs (on artifacts, steps) or on files of other runs.
- A second delivery path to agents; Send back stays the only one.

## Design

**Data.** New migration (sketch: version 2060, name `run_line_comments`; append to `MIGRATIONS`, add to `TABLES` with
key `['id']`), portable TEXT/BIGINT only:

```sql
CREATE TABLE IF NOT EXISTS run_line_comments (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  path TEXT NOT NULL, side TEXT NOT NULL, line BIGINT NOT NULL, quote TEXT NOT NULL, text TEXT NOT NULL,
  author_id TEXT NOT NULL, author_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  resolved_at TEXT, resolved_by TEXT, sent_at TEXT )
CREATE INDEX IF NOT EXISTS run_line_comments_execution ON run_line_comments (execution_id, path)
```

`sent_at` is set when a Send back included the comment, so the card can show "sent to the agents". Same fields as
`LineComment` plus author and state. Deleting or pruning an execution deletes its comments (hook where the journal's
events are removed with the execution, `lib/server/journal` and `store.deleteExecution` in `store.ts`); retention follows
the execution, and `LANDFLOW_TRACE_RETENTION_DAYS` pruning (30 days) should skip runs with unresolved comments.

**Routes** (new, under `app/api/executions/[id]/line-comments/`):
- `GET` -> `{ comments }`; `POST` `{ path, side, line, quote, text }` (text max 2000, like the gate note) -> 201;
- `PATCH /:commentId` `{ text? , resolved? }` (author edits own text; any editor resolves); `DELETE /:commentId` (author, or an admin).
- Policy: `/api/executions` already maps to `executions:read` / `executions:write` in `auth/policy.ts` (line 78), so
  reading needs read and writing needs write; the handler additionally checks `canResource(actor, 'workflow',
  record.workflowId, 'read')` for GET and a comment-level rule for PATCH/DELETE. A reviewer with only read access to a
  workflow could not comment; decide in review whether comment needs `read` (proposed: yes, read is enough, so
  reviewers need not edit workflows). That needs a distinct policy entry mapping this sub-route's POST to
  `executions:read`, the way `/api/executions/:id/(retry|rerun|debug)` is special-cased at line 37.
- `openapi.ts`: add to the Run Trace tag, with schemas matching `LineComment`.
- Use `handler()`, `json()`, `error()`, `parseBody()` from `lib/server/http.ts`.

**Live updates.** Emit on the bus (`lib/server/bus.ts`, `bus.emit`, relayed across processes in queue mode) an event
`runComment` `{ executionId, kind: 'added'|'changed'|'removed', id }`; the existing run SSE feed the Run Trace view
already follows (verify the exact stream in `run-trace-view.tsx`) carries it, and the client refetches the list.
Fallback without SSE: refetch on focus and every 15 s while the Artifacts tab is open.

**Client.** `LineCommentsProvider` keeps its context shape (`comments`, `add`, `remove`, `clear`) so `diff-view.tsx`,
`artifacts.tsx` and `sheet.tsx` do not change, but loads from the API (SWR-style), adds optimistic entries, and shows
the author's name on each comment. `clear()` ("Clear all") becomes "Resolve all", never a bulk delete of others'
comments. First open after the upgrade: if `localStorage` has comments for this run, POST them (author = the viewer),
then remove the key (migration of the old store; idempotent via a client-generated id).

**Send back.** The Note for Send back (`run-trace-view.tsx`) is built by `lineCommentsNote()` from unresolved comments,
now also those of other people. On `POST /api/executions/:id/gate` with `sent_back`, the server stamps `sent_at` on
every unresolved comment of the run and resolves them (`resolved_by` = the person who sent), inside the gate route so
a second browser does not resend the same comments. Add the author name to the note line when more than one author
(`- src/a.ts line 12 (`quote`) [Dana]: ...`). Note limit: the gate caps `note` at 2000 chars; the server truncates by
oldest-first with "and N more comments" so the agent knows.

**Audit.** `recordAudit` action `run.comment.add` (details: execution id, path, line; never the text).
**Queue mode:** rows go through the shared Postgres (replication notices keep other mains in step); bus relay does live
updates. **Local deploy:** none.

## Implementation plan

1. Migration + `TABLES` + store module `lib/server/journal/line-comments.ts` (CRUD, prune hook). Test: `apps/web/test/line-comments.test.ts` (CRUD, ownership, delete-with-execution).
2. Routes + policy special case + openapi. Test: route tests as the synthetic owner and as a read-only member (`apps/web/test/setup.ts`).
3. Client provider switched to the API, with the localStorage import. Test: component test with a mocked fetch; the migration path.
4. Bus event and live refresh. Test: two providers, one adds, the other sees it.
5. Gate route stamps `sent_at` and resolves. Test: extend the gate route test; comments from two authors appear in the note and are resolved after.
6. Docs, history; `(cd apps/web && npx vitest run) && pnpm typecheck`.

## Docs to update

`docs/run-trace.md` (Line comments paragraph, line ~464; "Not built" section), `docs/limitations.md` (drop the
"live in one browser" clause), `docs/roadmap.md` (~line 995), `docs/reference/api.md` (routes), `docs/history.md`.

## Risks and open questions

- Anchoring drift: comments match by file, side, number and quote text; if the run's diff changes (a live run), orphaned comments need a "outdated" state shown at the bottom of the file card.
- Privacy: a read-only reviewer can read every comment; comments are untrusted text that agents will read, so Send back already treats them as a note, but a reviewer's text reaching an agent is a prompt-injection surface (unchanged from today, now multi-author).
- Who may resolve or delete someone else's comment (owner/admin only?).
- Runs without a gate: comments are stored but have no delivery path; show "no Run report waiting" and offer **Copy them** as today.

## Effort and first slice

**M.** First slice: table, GET/POST/DELETE routes and the provider switched to the server, without live updates or
the gate stamping (reviewers see each other's comments on reload; Send back works as before from the stored list).
