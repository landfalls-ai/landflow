# FinishChat notes: chat leftovers

Rows for the integrator (docs/history.md, roadmap.md, limitations.md and README.md are untouched).

## docs/limitations.md: remove or shorten

- "The roster and Guardrails" line: delete "The roster's Node field is typed as a name or id; there is no node picker yet." and "Answer feedback for a picked agent skips the 'belongs to this session' check (...)". Replace the per-agent memory sentence's tail with: "a key typed as a fixed string, or read from the trigger node by name, is not changed, but validation and the trigger panel now warn about it."
- "Voice" line: delete "Replies are read after they finish, not while they stream; the speaker toggle is per page load (not remembered)." Add: "Replies are read sentence by sentence as they stream (a sentence needs the white space after its full stop, so abbreviations such as 'e.g.' can split one); switching the speaker on mid-reply reads from the start of that reply; the toggle is remembered per chat in localStorage."

## docs/features/ai.md (Hosted chat and widget), docs/reference

- Roster **Node** is a list of the workflow's Run an Agent, Run a Team and AI Agent nodes ("Other (type a name or id)" still accepts free text). It is a `string` property with `typeOptions.loadOptionsMethod: 'workflowNodes:<type>|<type>'`; the editor (param-form `WorkflowNodeSelect`) lists the workflow's own nodes, the plugin is not asked. The same convention works for any string parameter.
- Under the Node list the panel shows a warning when the chosen node's Session Key is a fixed string or reads the trigger by name; `validate_workflow` gives the same text as a warning prefixed "Public chat:". Nothing is rewritten.
- Feedback on a picked agent's answer: the session is read from the run itself (the trigger item's `visitorSessionId`, else the start node's input), so another session gets 403 for picked agents too. This also fixes a flow that routes through the trigger: its item's `sessionId` is `<visitor>:<agentKey>`, which used to be refused for the visitor.
- Speaker toggle remembered in `localStorage` key `landflow-chat-speak:<chat key>` (try/catch). Replies are read per completed sentence while streaming; code, names and the "asked" line are never read; stopped on speak and send.

## docs/roadmap.md

Chat with agents: open items "roster node picker", "remembered speaker toggle", "streaming speech", "feedback session check" are built. Still open: a local speech service.

## docs/history.md

Row: "Chat leftovers: roster Node picker (`workflowNodes:` string options in the parameter form), session check for picked agents' feedback from the run data, warnings for fixed or by-name Session Keys on roster targets (validate_workflow and the trigger panel), remembered speaker toggle, and sentence-by-sentence speech while a reply streams (`takeSentences`), with tests."

## Files touched beyond the list

New `apps/web/src/lib/shared/chat-roster-hints.ts` (pure rule shared by server and editor); `components/editor/node-panel.tsx` (passes the workflow's nodes in the preview data). No protocol change.
