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
- The test chat remembers under the person's own user id; older test sessions that say "you" are continued as the person now chatting. Memories saved under "you" before this are editor-only on the memory card and no longer recalled.
  A person who may run an agent may also edit it (run and update are one right), so they can list and forget other people's memories of that agent.
- An agent's write is Landflow's: it cannot replace a static memory (it forgets it and remembers the new one); only a person may.
- The near-duplicate check (words, then the nearest embedding) and the write that follows are not one transaction: two `remember` calls for the same new fact at the same moment can both add it; the next study or a forget tidies it. The 1,000 bound is likewise checked after the add.
- `forget_memory` on kagent acts at once; project Ask rules are not applied to the memory tools there (documented in a2a.md).
- A kagent conversation's own store holds the first message's memory key for its 24 hours.
- Telegram's shared-chat author fix has no test (no harness for it); Slack and Teams are tested in agent-channels.test.ts.
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
- `AgentSession.memory` is set by the run by the trace content mode (`applyContent`): `full` and `summaries` the sources, `off` none. `AgentSession.memoryText` is never set: the session record is readable by everyone with the agent's project, so the text is only in the journal span (`saw.memoryText`, on `full`).
- P9 added the policy line (`kagent` untouched): `resourceAction` makes a non-read method under an agent's `memories` the `run` right. Two OpenAPI operations
  (`listAgentMemories`, `changeAgentMemory`) and two `api.md` rows are in; P11 adds its lines after them.
- No SQL migration (2916 stays free).

## Second review

- A kagent deployment made before this commit has no stored `kagent.a2aUrl` (unless the landflow-harness mod's `trace.a2aUrl` was set) and gets no memory key until it is redeployed.
- A run that pauses for an approval keeps whose memory it ran for (`session.pending.memoryUser`); the resumed run reads and writes that person's memory again (a resumed run reads memory at its start like any run), whoever approves.
- `saw.memoryFor` and `saw.memoryAgent` (who the memory text is for) are on the journal's saw event and are removed with the text for readers who may not see it.
- Telegram's author fix is tested through `asAuthor` (agents/author.ts), which all three channel handlers use; the Telegram handler itself has no harness.
- The live journal stream and the journal read route both hide `saw.memoryText` (and `memoryFor`, `memoryAgent`) from anyone but the person, the agent's editors and admins; a queue-mode relay delivers through the same emit.
- A memory key's shape (`mk_…`) is a pattern rule of the central redactor (`secrets/redact.ts`), so it is redacted in every process without being remembered; `hasSecretValues()` is now always true.
