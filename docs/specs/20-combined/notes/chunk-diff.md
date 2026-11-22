# Notes for the integrator: P19 `chunk-diff` (C20)

- `docs/limitations.md`:
  - Chunk reuse covers folder indexing, the Notion walk and the Vector Store node with "Upsert by Key". A single upload in the knowledge dialog is a new document each time (not diffed).
  - Chunks stored before C20 have no hash, so the first index of each file (and the first walk of a Notion page that changes) embeds it once; the new section cuts change every file's chunk text then too.
  - Reuse is exact text under the same provider and model: a changed `dimensions` setting of the same model is caught only when the sizes differ (the pass then embeds everything).
  - The Vector Store node keeps the splitter sub-node's cuts: only folder indexing and the Notion walk cut at content-defined sections, so a node whose splitter packs greedily reuses fewer chunks after an insertion.
  - A folder listing cut at 200 files removes nothing that left the folder (it cannot tell which files are gone).
  - Files that left the folder lose their chunks only when that folder's pass runs (nothing watches the folder).
- `docs/roadmap.md`: C20 (chunk diffing with embedding reuse, atomic per-document swap, Upsert by Key): built. Open: reuse in the Vector Store node without a key; markdown-aware chunking; C22's sync builds on `syncDocument`.
- `docs/README.md`: no new page.
- `docs/development.md`: test list gains `chunk-diff.test.ts`, `vector-store-upsert.test.ts`; `rag.test.ts` (C20 store cases), `agent-knowledge-ag3.test.ts` (folder re-index), `notion-knowledge-nb06.test.ts` (chunk reuse); `pgvector.test.ts` (runs under `LANDFLOW_INTEGRATION=postgres`) gains the replace, rollback, concurrent-reader and `syncDocument` cases.
- `docs/observability.md` (not a P19 file): span `vector_store.replace {store}` and counter `landflow.rag.chunks{landflow.outcome=reused|embedded|removed}`.
- `docs/reference/api.md`: P19's last task is done on this branch (the folder route's row, `reference/api.md`), written before P15a merged; the integrator resolves a conflict on that one row.
