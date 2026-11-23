# Notes for the integrator from W5 P27 `extract` (C28)

Apply these after the last merge of the wave; P27 edited no shared doc (`docs/history.md`, `docs/limitations.md`,
`docs/roadmap.md`, `docs/README.md`, `docs/development.md`).

## `docs/limitations.md`

- Memory Extract is a node only: nothing extracts after an agent session (C28-D2), and a model cannot call it as a tool.
- Memory profiles are per container (a project, a team, an agent and user), not per subject or person; `subject` is a field of an
  extracted fact only. The sampled profile reads at most 2,000 items.
- The relative dates Landflow works out itself are English phrases (today, yesterday, tomorrow, last or next a weekday, N days,
  weeks or months ago or ahead, last, this or next week, month, quarter or year, in UTC days); anything else, and every other
  language, is the model's answer, kept only when it is a real date within ten years of the reference date.
- A fact's `validAt` travels in its evidence, not in a column of its own, so a memory cannot be searched or sorted by it.
- An update of a static memory is not written (only a person changes one); an extracted fact whose kind is `static` is written as
  static when it is new, so a later extraction cannot supersede it either.
- Comparison finds the five nearest items by words (and meaning when embeddings are on): a stored item that shares no word with
  a fact is not seen, so a paraphrase can be written as `new`. Extraction relations other than `updates` and `duplicate` are not
  written (C10 draws graph relations).
- A memory provider receives `confidence` and `evidence` in the `add` request (optional fields of the contract) and may ignore
  them; the Go and Python SDK typings of the memory provider request do not name them yet.

## `docs/roadmap.md`

- C28 memory extraction (Memory Extract node, sampled Memory Profile): built (2026-11-23, W5 P27). No migration. Open: per-subject
  profiles, an agent option to extract after each session, a `validAt` column, relations beyond `updates` and `duplicate`.

## `docs/README.md`

- Feature map: no new page. Memory Extract and the Sampled profile are in `second-brain.md#memory-extract`; add the anchor to the
  Memory row if the integrator keeps one.

## `docs/development.md`

- Memory Extract tests (no container; the Ollama fake and a scripted model): `cd apps/web && npx vitest run
  test/memory-dates.test.ts test/memory-sample.test.ts test/memory-extract.test.ts test/memory-extract-node.test.ts`.

## `docs/protocol.md` (memory providers) and the SDKs

- The `add` request may carry `confidence` (0..1) and `evidence` (at most 6 rows of `label`, `value`, `href`). P27 added the two
  optional fields to `MemoryRequestWire` in `packages/protocol/src/memory-provider.ts` (outside P27's file list: one line, a
  type only); the protocol page's memory-provider section and the Go and Python SDK typings should name them.
