# Notes: C09 agent memory (P9 `agent-memory`)

## docs/limitations.md

- `docs/limitations.md` "no cross-session memory on kagent" is lifted for a Landflow agent reached by Landflow's A2A node or an agent's A2A tool
  (the memory key in the first message); a caller that is not Landflow (kagent's own UI, another A2A client) gets no key and so no memory.
- The memory key lasts 24 hours from the first message of a conversation; a longer conversation loses memory until a new one starts.
- The `agent_memory` table is kept, read-only, for one release (a later migration drops it); the import runs once per database, on first use.
- The recall query is the run's first message only (read once, so the cache rule holds); the agent cannot ask again mid-run on Landflow's runtime.
- Meaning search over an agent's memories lives in `agents/memory.ts`: the built-in memory backend searches an agent container by words only, so
  `memory.search` (MCP, nodes) over an agent container is still keywords.
- The profile shows at most 50 static memories and the 10 newest others; a person with more static ones loses the oldest from the prompt (the cap is 4,000 characters anyway).
- The test chat's user is "you", shared by everyone who chats with the agent there: those memories are the agent's editors' to see on the memory card.
  A person who may run an agent may also edit it (run and update are one right), so they can list and forget other people's memories of that agent.
- An agent's write is Landflow's: it cannot replace a static memory (it forgets it and remembers the new one); only a person may.
- The thresholds (0.3 recall, 0.92 near-duplicate) are guesses; C11's playground shows scores to tune them.
- With Ollama down the relevant part is by words and an embedding failure is left alone for a minute (process-local).

## docs/roadmap.md

- C09 built: agent memory with a profile, relevant recall, static and replaces, `forget_memory`, the 1,000 bound, the import, the memory card, and
  kagent memory through the signed key. The W1 follow-up `RemoteRun.blocked` is closed (typed in `lib/shared/agents.ts`).

## docs/README.md

No new page.

## For the integrator and P11

- `RunRequest.sawMemory` (sources) and `RunRequest.sawMemoryText` (their text, joined after the agent's own block in `saw.memoryText`): the team runtime's last task passes
  `sawMemory: [saw]` and `sawMemoryText: text` from `notebookBlockFor`.
- `AgentSession.memory` / `memoryText` are set by the run by the trace content mode (`applyContent`): `full` both, `summaries` memory only, `off` neither.
- P9 added the policy line (`kagent` untouched): `resourceAction` makes a non-read method under an agent's `memories` the `run` right. Two OpenAPI operations
  (`listAgentMemories`, `changeAgentMemory`) and two `api.md` rows are in; P11 adds its lines after them.
- No SQL migration (2916 stays free).
