# Notes from P10 (graph, C10) for the integrator

## docs/limitations.md

- The memory graph draws facts and their versions only: no entity-to-entity edges, no work events, people or knowledge base chunks. (C10 D3)
- "One link away" reads at most 50 neighbouring subjects: an entity page's related pages, and the agents and workflows a workflow or agent uses.
- The layout runs in the browser (`d3-force`, about 2 s for 500 nodes, then it stops); nothing is laid out on the server and there is no WebGL renderer.
- Version edges across two pages of a whole-brain graph join only once both pages are loaded (Load more); the page order is newest first, not by chain.
- The Graph tab does not edit: no dragging a fact onto another to link them.

## docs/roadmap.md

- Combined wave 2, C10: the Brain page's Graph tab (`GET /api/brain/graph`, `components/brain/graph/`) is built. Open: entity-to-entity edges, a server layout for very large brains.

## docs/README.md

- No new page. `docs/second-brain.md` gets "The graph" (T-9, after P7 merged).

## For the integrator at the close

- `THIRD_PARTY_NOTICES.md` is new at the repo root; keep it when the notes are applied.
- After rebasing on P7: `lib/server/brain/graph.ts` reads facts through its own keyset page over `listFacts` (`readFacts`, which filters the scope in JavaScript and caps a read at 20,000 facts); switch it to P7's `pageFacts` (scope in SQL, same cursor shape `{ s: lastSeen, i: id }` if P7 keeps it). P7's `project` subject and `agent-user` rule need no change in the UI: `agent-user` is already left out, `project` shows as a subject square once `FACT_SUBJECTS` has it (the route's subject parser reads `FACT_SUBJECTS`).
