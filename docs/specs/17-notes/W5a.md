# W5a notes: json-render for Run Trace cards

Rows for the integrator (this change edited none of the shared docs). Verdict: keep as a flag, see [research/json-render-verdict.md](../../research/json-render-verdict.md).

## docs/roadmap.md (the Vercel open source paragraph)

Replace "json-render for Run Trace cards" in **Still open** with: json-render (`@json-render/core` and `@json-render/react` 0.21.2) draws Status, Diff and Approval cards from a model-written spec behind `LANDFLOW_JSON_RENDER=1` (off by default), after a strict validator drops unknown components and rejects expressions, extra props, actions and state; a dev page shows the cards. Nothing writes specs yet.

## docs/limitations.md

- Spec cards (json-render) are a flagged prototype: no agent produces specs, the Approval card only names an approval and cannot decide it, and the browser side of the flag is `NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1` (build time).

## docs/reference/configuration.md

| Variable | Default | Meaning |
|---|---|---|
| `LANDFLOW_JSON_RENDER` | off | `1` turns on json-render spec cards in Run Trace (server side); the browser needs `NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1` too. Dev page: `/runs/json-render-gallery` |

## docs/history.md

| Date | Change |
|---|---|
| 2026-11-07 | W5a: json-render prototype for Run Trace cards (Status, Diff, Approval), pinned 0.21.2, behind `LANDFLOW_JSON_RENDER`; strict validator in `lib/shared/ui-spec.ts`, cards in `components/run-trace/ui-cards.tsx`, dev page at `/runs/json-render-gallery`; verdict: keep as a flag. |

## docs/README.md

Add `research/json-render-verdict.md` to the research list.

## Decisions

- Version 0.21.2, the newest at least two weeks old on 2026-11-07 (0.21.3: 14 days, 0.21.4: 6 days).
- The lockfile: `pnpm add` also re-resolved two unrelated entries (vitest's `@opentelemetry/api` peer, 1.9.1 to 1.10.0); those hunks were reverted so only the json-render entries changed.
- The validator runs before the renderer and strips everything json-render treats as behaviour (`$state` expressions, `on`, `visible`, `children`, `slots`, `state`).
- The dev page is a special execution id inside `RunPage` (an `app/` route was out of paths).
