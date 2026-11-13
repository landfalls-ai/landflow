---
name: landflow-feature
description: "Walks a new Landflow feature or multi-step change through research, a plan of disjoint packages, parallel implementation in worktrees, security and code review, integration with the regression gate, a UI check at desktop and phone, a secret scan and a PR. Use when researching or implementing a new Landflow feature, a review's findings, or any change that spans several files or areas of this repository."
---

# Landflow feature pipeline

The order every feature in this repository follows. The rules are in `docs/constitution.md`; the agents are in
`.claude/agents/`. Keep the person informed at each step, and ask before anything the constitution says needs their
yes (commit, push, PR, merge, deploy, real credentials).

## 0. Start

- Read `docs/constitution.md` and `CLAUDE.md` (the constitution is imported into every session; reread the parts for
  the area you touch).
- Write down the request in one paragraph: the outcome, who sees it, what must not change. If something essential is
  unclear (scope, target repo, whether a UI change is wanted), ask once, then proceed.

## 1. Research — `landflow-researcher` (sonnet)

Brief it with the question, the areas to map and what you already know. It answers with how the area works today
(file:line), what to reuse, gaps and open questions. For a small change you may do this yourself, following the same
output.

## 2. Plan — `landflow-planner` (opus)

Give it the request and the research. It returns packages with **disjoint files**, waves of at most five, tests, docs
and acceptance criteria per package, and the regression and live checks per wave. Show the plan to the person and get
a yes before implementing anything large. Save the briefs outside the repository (the session's scratchpad).

## 3. Implement — `landflow-implementer` (sonnet) or a specialist

One agent per package, each in its own worktree branched from `origin/main`, **at most three or four at once**. Use
the specialist for its area: `landflow-data-engineer` (migrations, store, Postgres), `landflow-ui-engineer` (pages and
components), `landflow-ai-assistant-engineer` (Spotlight, agents, teams, brain, Run Trace), `landflow-plugin-engineer`
(plugins, protocol, SDKs, transports), `landflow-observability-engineer` (logs, spans, metrics, health),
`landflow-test-engineer` (tests and the gate), `landflow-docs-writer` (docs). Each brief says: the package text, the
worktree and branch, "work only inside your worktree", "don't push or merge", "don't start sub-agents", and when other
agents share the machine, "run typecheck and your targeted tests, not the full host suite".

```bash
# <worktree> is one absolute path, for example /path/to/<repo-name>-<feature>/<package>
git -C <repo> fetch origin
git -C <repo> worktree add <worktree> -b <feature>/<package> origin/main
cd <worktree> && pnpm install --frozen-lockfile --prefer-offline
```

## 4. Review — `landflow-security-reviewer` + `landflow-code-reviewer` (fable)

For each package branch, run both reviewers on `git diff origin/main...<branch>` with the brief. **At most two fable
agents at a time**; queue the rest. Send "changes required" findings back to the package's implementer, then review
again. A package moves on only when both say **approve**.

## 5. Integrate — `landflow-integrator` (sonnet)

It merges the wave's approved branches into one branch from `origin/main`, resolves the shared docs, regenerates the
lockfile and generated docs, and runs the gate:

```bash
pnpm install
pnpm typecheck
(cd apps/web && npx vitest run)
pnpm test        # runs the host suite again (apps/web has a test script); `pnpm -r --if-present --filter '!@landflow/web' test` skips it
pnpm check:deps  # the dependency rules; `pnpm check` is typecheck + test + check:deps, the local gate (no hosted CI)
# then the wave's own commands: integration flags (LANDFLOW_INTEGRATION=postgres|queue|…, Postgres files one at a time),
# Go (go test ./...) and Python (.venv/bin/python -m unittest discover -s tests) suites for what changed
```

A change to the boot, `instrumentation.ts`, the proxy or anything the worker imports also needs `next build`
(`cd apps/web && rm -rf .next && npx next build`, then `git checkout apps/web/next-env.d.ts`) and the queue stack
(`COMPOSE_BAKE=false docker --context orbstack compose -f deploy/compose.queue.yml up -d --build --wait`, then
`python3 deploy/scripts/queue-e2e.py`). A test file that writes or deletes shared state (folders under the data
directory included) sets its own `LANDFLOW_DATA_DIR` (as `marketplace.test.ts` does). If
`apps/web/test/marketplace.test.ts` fails, rerun it alone and report both results.
Compare every count with the last green run on `main`; a new failure stops the wave.

## 6. Check it live

- Anything that needs infrastructure goes through `landflow-local-ops` (OrbStack only, `landflow-*` projects,
  `landflow-dev` namespace).
- UI changes: the scratch host from `docs/development.md` ("Checking a change live"), opened at
  `http://localhost:3100` in a **headed** browser, at 1440×900 and 390×844, light and dark, console free of errors;
  compare desktop shots with the ones from before the change.
- AI changes: drive them through Spotlight on the scratch host with the local model.

## 7. Scan, then PR when asked

Scan the whole diff for secrets and personal data (the repository is public):

```bash
git diff origin/main...HEAD | grep -nEi 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-|sk-(ant-)?[A-Za-z0-9_-]{20,}|lf_[A-Za-z0-9_-]{24,}|/Users/[a-z]|@[a-z0-9-]+\.(ai|com|io|org|net|dev)\b|claude\.ai/(code|share|artifact)|session_[A-Za-z0-9]{16,}'
git diff origin/main...HEAD --name-only | grep -E '(^|/)\.data(/|$)|(^|/)(MEMORY\.md|encryption\.key|credentials\.json|[^/]*kubeconfig[^/]*|\.env(\.[^/]*)?)$' | grep -v '\.env\.example$'
```

Every hit is either a known fake (test fixtures, `deploy/.env.example`) or removed before going on. The scan reads
file contents; the `Claude-Session:` trailer of commit messages is the accepted exception. Then, only when the
person asks: push the branch and open the PR. Its body lists what a user sees change, what changes on a desktop, the
gate results and the live checks. Merge only when the person says so.

## Rules for the whole pipeline

- Sub-agents never start sub-agents; you orchestrate.
- Never touch the person's own checkout, other worktrees or `apps/web/.data`.
- Local only: no cloud, no image push, LocalStack for AWS, development credentials from `deploy/.env.example`.
- Every commit gets a `docs/history.md` row; the docs move with the code.
