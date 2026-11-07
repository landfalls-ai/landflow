# Parallel build plan: landing the 2026-11-07 session, and what it left open

Status: proposed (2026-11-07). Part of the [specs](README.md). A plan for a team of agents working at once, each in its own worktree.

## 0. What the session produced

**Built, not committed** (on `feature-specs`, mixed in the working tree with the composite-governance work, which belongs to someone else's change):

| Change | Files |
|---|---|
| Node retry backoff (`retryBackoff: exponential`, wait in the node's Settings, Spotlight can set it) | `packages/engine/src/{types,executor}.ts`, `packages/engine/test/executor.test.ts`, `apps/web/src/lib/server/schemas.ts`, `apps/web/src/lib/shared/assistant-ops.ts`, `apps/web/src/components/editor/node-panel.tsx` |
| Browser plugin (agent-browser): Read, Act, Screenshot, allow-list and ceiling, aliases, `outputSchema`; 12 tests | `plugins/browser/**`, `package.json` (`plugin:browser`), `pnpm-lock.yaml` |
| Spotlight: conditional-hook crash fixed; node docs and the flow-builder catalog list a node's output fields | `apps/web/src/components/editor/spotlight.tsx`, `apps/web/src/lib/server/assistant/research.ts`, `apps/web/src/lib/server/flow-builder.ts`, `apps/web/test/assistant.test.ts` |
| Docs | `docs/research/workflow-sdk-spike.md`, rows in `docs/{README,assistant,development,history,limitations,roadmap}.md`, `docs/features/engine.md`, specs 16 and 17 |

**Checked:** `pnpm typecheck`, `apps/web` vitest (2,588 pass), `plugins/browser` vitest (12 pass), the engine suite; the Browser node live through the host, and a seven-node form flow whose extracted ticket matched an independently computed one.

**Not mine, do not commit with these:** `apps/web/src/app/api/workflows/import/route.ts`, `lib/server/governance/*`, `lib/server/publish*.ts`, `lib/server/templates/index.ts`, `lib/shared/governance.ts`, `docs/composites.md`, `docs/reference/api.md`, `apps/web/test/composite-rules.test.ts`, `docs/specs/14-*`. The shared docs files (`README`, `history`, `limitations`, `roadmap`) hold both changes' rows: split them with `git add -p`.

## 1. Ground rules for every agent

- **A worktree per agent**, branched from `main` (or from W0's branch once it exists), never the dirty `feature-specs` tree.
- **Own your paths.** Edit only the files listed for your workstream; if you need another, stop and say so.
- **Checks before you report**, from `CLAUDE.md`: `(cd apps/web && npx vitest run) && pnpm typecheck`, `pnpm test`, plus the suites of what you touched.
- **Docs rows go to the integrator.** Each agent writes its docs rows into `docs/specs/17-notes/<workstream>.md` (feature page text, limitations line, roadmap line, history row) instead of editing `history.md`, `roadmap.md` or `limitations.md`. The integrator merges them. This removes the one place every branch conflicts.
- **`pnpm-lock.yaml`:** only W0 and W6 add dependencies; others rebase on it.
- **Local only:** the OrbStack engine and cluster, LocalStack, the development credentials, no pushes of images, no prune. Scan for secrets before any push (the repo is public).
- **Show the work:** UI changes are checked in a visible Chrome with `agent-browser --headed`, recorded, on a scratch host (`docs/development.md`, "Checking a change live"), on port 3100+ so they don't take the dev host's ports. One scratch host per agent, on its own port and data directory.
- **Usage:** two or three agents at a time, on Sonnet; keep Fable for a final review, one at a time.

## 2. Workstreams

### W0. Land the session (do first, one agent or by hand)

Branch `vercel-oss-adoption` from `main` with only the files in section 0's table. Split the shared docs with `git add -p`, add the history row with the real hashes, run every check, scan for secrets, open the PR. **Done when** the PR's diff has no governance files and CI-equivalent checks pass locally. Also: stop the scratch host, the Browser plugin and the form server; delete the `zz` and `Support request filer` flows; keep `demo.mp4` only if wanted.

### W1. Debugging a remote workflow from a local Claude Code

The instance MCP server (`lib/server/mcp/instance-tools.ts`, 11 tools) and the CLI (`packages/cli`) can build, validate and run, but cannot say why a run failed.

| | Work | Paths | Depends on |
|---|---|---|---|
| **W1a** | `get_node_type` returns `outputSchema`; `validate_workflow` flags an expression that names a field the node before it doesn't write (from `outputSchema`, else from the last run's data); new tools `explain_failure` (failing node, resolved parameters, a sample input item, upstream output fields, error text, what to check), `get_run_trace` (the journal), `get_plugin_logs`, `retry_execution`, `run_node` with pinned input | `lib/server/mcp/{instance-tools,workflows}.ts`, `lib/server/journal/*` (read only), tests in `apps/web/test/` | W0 for `outputSchema` on the Browser node |
| **W1b** | `landflow debug-bundle <execution>` (a redacted folder: workflow JSON, run data, trace, node manifests, plugin versions and logs); `landflow replay <bundle>` (a scratch host with the data pinned, run against fakes); `landflow claude init` (writes `.mcp.json` and a short skill: the workflow JSON format and the node docs of the connected host); `landflow executions watch <id>` | `packages/cli/**`, `docs/` for the CLI | W1a's tools for the bundle's contents |
| **W1c** | A short-lived read-only debug token (`landflow debug-token --execution <id> --ttl 1h`, scopes `executions:read`, `trace:read`) and a one-node override that runs a remote workflow's node against a local plugin build for one debug run | `lib/server/auth/*`, `lib/server/mcp/tokens*`, the transport override in `lib/server/plugins/*` | W1a; needs a design note first (redaction, audit) |

**Done when:** an agent given only a failed execution id and the debug token explains the failure in one MCP call, and the fixture for today's bug (a Code node reading `$json.browserSnapshot`) is caught by `validate_workflow` before any run.

### W2. Chat with agents (spec [16](16-chat-with-agents.md))

| | Work | Paths |
|---|---|---|
| **W2a** | Attribution on chunks and messages; the page shows who answered; the "Chat with a team" template (first slice) | `lib/server/{streaming,chat}.ts`, `lib/server/chat-client.ts`, `lib/server/templates/builtin.ts`, `apps/web/test/` |
| **W2b** | Roster: trigger option, config, `agentKey`, start at the target, per-agent memory ids, off-roster refusal | `lib/server/nodes/triggers.ts`, `lib/server/chat.ts`, `app/chat/[...path]/route.ts`, `lib/server/chat-client.ts` |
| **W2c** | Voice: trigger option, buttons, spoken-text rules, stop on speak | `lib/server/chat-client.ts`, `lib/server/nodes/triggers.ts` |

W2b and W2c both touch `chat-client.ts` and `triggers.ts`: run W2a, then W2b and W2c in sequence, or give W2c the file first and have W2b rebase. **Done when** a visitor on a phone talks to a lead that delegates to two specialists, picks one by tapping a face, and hears the reply, with the three checks of the spec passing.

### W3. Browser node: the editor experience and what it returns

From the live review: the Steps box is raw JSON with no help, and nothing can pull a value out of a page.

- A **step builder** (a fixed collection: action, target, text) beside the JSON, so a person doesn't author JSON.
- An **Extract** step (`getText`, `getValue`, `getAttr`) that returns `results: { name: value }`, so the next node reads a field instead of parsing the snapshot.
- **Per-step results** in the output (`steps: [{ action, target, ok, ms }]`), so a failure names the step.
- **Screenshot after steps** as an option; a preview of the PNG in the output panel (host work, `components/editor`).
- **Allowed Domains** defaults to the URL's host with a visible notice; **Show the Browser Window** moves out of Options.
- Check the **Screenshot** operation through the host with a real binary store, and a login-free slow page.

Paths: `plugins/browser/**`, `docs`; the output preview touches `apps/web/src/components/editor/` (one file). **Done when** a flow fills a form and reads the confirmation with an Extract step, without a Code node.

### W3b. Packaging the Browser plugin

Add it to `dev:all` (an optional entry), `deploy/compose*.yml` scan hosts, the node-plugin Dockerfile args and a cluster manifest, and say in `docs/deployment.md` that the image needs Chrome (a separate image: the code-runner pattern). Paths: `deploy/**`, `docs/deployment.md`, `package.json`. Needs W0.

### W4. Spotlight reliability

Found while building the form flow: it announced proposal cards that never appeared; it added stray nodes (one wired the success branch into the rejection); it "fixed" a failure by making the node stop throwing; it guessed field and step names. Work:

- A check after a build that flags a connection from a branch output to a node that a sibling branch also reaches, and a node with no purpose (nothing reads its output).
- When a reply says "apply" and no proposal exists, Spotlight says so and retries once, instead of ending the turn.
- A "fix" that makes a node swallow its error is shown as a warning.
- Fixtures from today's conversation as regression tests.

Paths: `lib/server/assistant/*`, `lib/shared/assistant-ops.ts`, `apps/web/test/assistant.test.ts`, and the small edits in `components/editor/spotlight.tsx` (the `voice-spotlight` worktree edits the same file: coordinate or rebase). **Done when** the seven-node form flow builds in one prompt with no stray nodes.

### W5. Prototypes, behind flags, each its own small branch

| | What | Where | Done when |
|---|---|---|---|
| **W5a** | json-render for Run Trace cards (a status, a diff and an approval card) | `components/run-trace/`, a small catalog | one card renders from a model-written spec and ignores an unknown component |
| **W5b** | An AI SDK multi-provider model node and `@ai-sdk/otel` spans next to the Run Trace export | a TypeScript plugin (`plugins/ai-sdk`) | a flow runs on a non-Anthropic provider and its spans appear in the trace |
| **W5c** | just-bash as an agent shell tool over an in-memory filesystem, no host mounts | a plugin node | an agent lists and reads files it was given; nothing on the host is reachable |
| **W5d** | One capped deepsec scan of this repository, local mode, `--max-cost-usd` set | a doc and a run, no code | findings triaged into `docs/` or issues; the cost stays under the cap |

Each carries a one-page verdict (adopt, keep as a flag, or drop) in `docs/research/`.

### W6. Small engine follow-ups

`retryBackoff` for composite frames and n8n imports (both drop the wait today, `lib/shared/composites.ts` around lines 510 and 613, `lib/server/n8n-import.ts` around 1494); an optional jitter; the same for whole-run retry's settings screen if missing. Tests next to each. Paths: those files and `packages/engine`. **Done when** `limitations.md` loses its two backoff caveats.

## 3. Order and waves

```text
Wave 1 (three agents):  W0 (land)  |  W3 (browser UX)  |  W1a (MCP debug tools)
Wave 2 (three agents):  W2a -> then W2b, W2c  |  W4 (Spotlight)  |  W1b (CLI bundle, init)
Wave 3 (optional):      W1c (needs a design note)  |  W3b (packaging)  |  W6  |  W5a-d, one at a time
```

- W0 first or at the same time as W3 and W1a, which only need its `outputSchema` change on the Browser node: have them branch from `main` and rebase once W0 merges.
- Merge order: W0, W3, W1a, W2a, W4, W2b, W2c, W1b, then the rest. After each merge the next agent rebases and re-runs its checks.
- The integrator (one agent, or a person) owns `docs/history.md`, `roadmap.md`, `limitations.md`, `docs/README.md` rows and the final `pnpm test`.

## 4. Risks

- **Mixed working tree.** The governance work shares four docs files with this session. W0 must split them by hunk; an agent that runs `git add -A` ships someone else's change.
- **`spotlight.tsx`** is edited by W4 and by the unmerged `voice-spotlight` worktree. Merge that branch first, or keep W4's edits to the hook fix and one small block.
- **`chat-client.ts` and `triggers.ts`** are shared by W2a to W2c; sequence them.
- **Browser safety.** W3's Extract step returns page text to later nodes: keep the content fence and the allow-list; an Extract result is untrusted data, and the docs must say so.
- **Scratch hosts.** A broad `pkill -f "next dev"` killed a host and may have killed an unrelated project's dev server today. Agents stop only the processes they started, by port.
- **Debug tokens (W1c)** are a new way into a remote host: no merge without an audit event per use, a time limit and redaction of credentials and `$vars` in everything the token returns.

## 5. What is deliberately left out

The Workflow SDK ([research notes](../research/workflow-sdk-spike.md)), Streamdown (the app renders no streamed markdown), a durable timer table (timers already re-arm from the store at boot), the AI SDK's HarnessAgent, and the skills CLI.
