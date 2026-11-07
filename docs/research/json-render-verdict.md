# json-render verdict (2026-11-07)

Part of the [Landflow docs](../README.md). W5a of the [parallel build plan](../specs/17-parallel-build-plan.md): can Run Trace draw cards from a model-written JSON spec with Vercel's [json-render](https://github.com/vercel-labs/json-render)?

**Verdict: keep as a flag (`LANDFLOW_JSON_RENDER=1`, off by default).** It works and costs little, but only behind a validator Landflow writes itself, and nothing in Run Trace produces specs yet, so it should not be on by default or built on further until a real source of specs exists.

## What was built

- `@json-render/core` and `@json-render/react` pinned at **0.21.2** (published 2026-10-23, 15 days old; 0.21.3 was 14 days old and 0.21.4 six days old, so both were skipped). Only those two packages' lockfile entries changed (`zod` and `react` were already in the tree). Both exist on npm; the React package depends on core and needs `zod ^4` and `react ^19.2.3`, which this app has.
- A catalog of three leaf cards, `Status`, `Diff` and `Approval` (`apps/web/src/lib/shared/ui-spec.ts` for the schemas and the validator, `apps/web/src/components/run-trace/ui-cards.tsx` for the `defineCatalog` / `defineRegistry` and the React cards).
- A dev page at `/runs/json-render-gallery` (one small edit in `run-page.tsx`) showing the three cards, an unknown component and malicious props.
- Tests: `apps/web/test/ui-spec.test.ts` (catalog validation, unknown component ignored, malicious props rejected) and `ui-cards.test.ts` (server render of the cards, flag off renders nothing, text escaped).

## Why a validator in front of the renderer

json-render's spec format is more than data. A prop can be `{ "$state": "/path" }`, `$template`, `$computed` or `$bindState`; an element can carry `on` (actions), `visible`, `children`, `slots`, and the spec a `state`. Its catalog props schemas are zod, but the renderer does not reject extra fields, and the registry's fallback for an unknown type is a component you supply. For untrusted model output that is too much surface, so `parseUiSpec` runs first and only its result reaches the renderer:

- only `root` and each element's `type` and `props` are read; `state`, `children`, `slots`, `visible`, `on` and anything else is dropped before json-render sees it;
- props are `z.strictObject` per component: named fields only, plain bounded strings and enums, no control characters, so an expression object, a `href`, an `onClick` or `dangerouslySetInnerHTML` fails the whole card;
- an unknown component (including `constructor`, `__proto__`) is dropped and named in a plain-text note; the renderer's fallback returns null;
- at most 8 elements, 200 diff lines, 100 KB of JSON text; the root must be a valid card, and cards are leaves;
- the provider is mounted with no handlers, navigate, functions or directives, and the Approval card has no buttons: it names an approval and points to the run's existing approval card, so nothing is decided through a spec.

## What I saw

- Server render works under vitest with React 19.3 and Next 16.4 (the cards are client components); the renderer needs its providers (`JSONUIProvider`) even for a static card, found by a failing test.
- In a headed browser on a scratch host (port 3190, own data directory) the dev page drew the three cards in one 420 px column; the unknown component and the object-valued title each showed "This card could not be shown" with the reason.
- Bundle: the two packages are about 1.2 MB unpacked on disk (core), loaded only by the cards module; not measured in the built client bundle.
- Full web vitest: 2656 passed; the 3 failures are the known unrelated ones (audit-chain, marketplace). `pnpm typecheck` passes.

## Reasons not to adopt it more widely yet

- Nothing writes specs. The agent runtime would have to be told the catalog (`catalog.prompt()` exists) and a place in the trace chosen for the cards; today the three cards duplicate richer hand-written ones (`approval-card.tsx`, `diff-view.tsx`), which have line comments and real decisions.
- The library is young (0.x, minor releases every few days), so the pin matters and an upgrade needs the tests re-run.
- The security rests on Landflow's validator, not on the library; the library adds the registry and catalog typing, which a plain `switch` over three cards would also give.

## Known gaps and follow-ups

- The flag's browser side is `NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1` (inlined at build); `LANDFLOW_JSON_RENDER=1` alone enables the server side only. A settings entry or a `next.config` `env` line would need edits outside this change's paths.
- The dev page lives inside the run route under the id `json-render-gallery`, because adding an `app/` route was outside the allowed paths.
- Adopting would mean: a place to attach a spec to a span or artifact, `catalog.prompt()` in the agent persona, and a decision path for an Approval card that goes through the existing approval route.
