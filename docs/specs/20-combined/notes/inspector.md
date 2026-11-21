# Notes: C11 memory inspector and search playground (P11 `inspector`)

## docs/limitations.md

- The playground does not preview what memory a run would get for a hypothetical message, and does not score retrieval over a
  labelled set; a knowledge base a plugin answers (`source: 'node'`) has no playground (it searches through its own node).
- Cohere reranking in the playground is tested with a stub only (a hosted API); the local check uses the chat-model reranker on Ollama.
- A rerank call is recorded as the person's rerank-purpose AI usage, not under a separate `memory-playground` origin.
- What it saw → Memory shows an item's text from the item's state now (read on open), not the text as recorded; the recorded text
  is in **Show the exact text of the memory** (trace content `full` only).
- A facts playground searches one project's facts (the caller's home project when none is given), not every project at once.

## docs/roadmap.md

- C11 built: What it saw → Memory (sources, versions, scores, the exact text by content mode, forgotten since) and the search
  playground on the knowledge card, the Notebook tab and Brain → What Landflow knows.

## docs/README.md

No new page.

## For the integrator and P9

- P11's T-1 (`SawMemory*` types, `SawAttrs.memory` / `memoryText`, content modes) is its own commit on `combined/w2-inspector`: P9 records
  what a run recalled by setting `attrs.saw.memory` (one `SawMemorySource` per source: `agent-profile` for static memories,
  `agent-relevant` for searched ones with `mode` and `score`, a `hash`) and `attrs.saw.memoryText` through `RunRequest.sawMemory`.
  `journal/content.ts` applies the content mode when the event is written; P9 sets both fields unconditionally.
- `notebookBlockFor(binding)` in `notebook/service.ts` gives `{ text, saw }`; the team runtime's last task (T-9, after P9) passes `saw` as `sawMemory: [saw]`.
- `AgentSession` gains optional `memory` / `memoryText` in P9; `sessions-tab.tsx` already reads them through a cast.
- **T-9 is not done** (it runs after P9 merged): `auth/policy.ts` line `if (under('/api/memory')) return { scope: 'workflows:read' };`
  (until then `/api/memory/search` and `/api/memory/items` answer only an owner or admin), the two `openapi.ts` operations
  (`searchMemoryPlayground`, `memoryItemsState`), `docs/reference/api.md` (the two routes), `docs/agents.md` (one line under the knowledge card),
  `docs/second-brain.md` (one line under "What Landflow knows"), and `agent-teams/runtime.ts` (`notebookBlockFor` at the two call sites and `sawMemory`).
- `components/run-trace/sheet.tsx` is not in the W2 table; one line there passes `memory` and `memoryText` to `WhatItSaw`.
