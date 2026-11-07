# Chat with agents: one chat, many agents or a team, by text and voice

Status: proposed (2026-11-07). Part of the [specs](README.md).

## Problem

The Chat trigger already serves a public page and an embeddable widget with streamed replies, files, sessions, feedback and Basic Auth
([features/ai.md](../features/ai.md#hosted-chat-and-widget), `lib/server/chat.ts`, `lib/server/chat-client.ts`, `app/chat/[...path]/route.ts`).
What it lacks is the thing a person building a support or concierge chat wants:

1. **One chat in front of several agents or a team.** Today a flow can wire an AI Agent, Message Agent or Run Team behind the trigger, but the
   end user can't tell who answered, can't ask for a particular agent, and every reply is the one conversation's single voice.
2. **Voice.** The end user can only type.

The builder side must stay simple: one Chat trigger, agents behind it with their tools, memory and knowledge, able to read and write data.

## Decisions (made 2026-11-07)

- **Routing: both.** A lead agent answers by default and delegates; a roster lets the user ask for a specific agent or team.
- **Voice: the browser's own speech first.** Push-to-talk speech in and spoken replies through `SpeechRecognition` and `speechSynthesis`.
  A local speech service can replace it later behind the same interface. Nothing new runs on the host, and nothing is configured.

## Design

### 1. Lead agent delegates (default)

- The Chat trigger's output goes to one **front-door** agent (an AI Agent, or a Message Agent for a saved persona). Specialists and teams are its
  tools: Message Agent and Run Team already work as agent tools and carry a required `reason` argument, so the journal says why one asked another.
- **Attribution.** A chunk and a final reply carry who wrote them: `{ agent: { id, name, face? } }` on the `node.chunk` wire chunk
  (`wireChunk` in `lib/server/streaming.ts`) and on stored transcript messages. The page shows the name and face above a bubble and a
  short "asked Billing" line when the lead delegated (the delegation's `reason` is the line).
- No change for builders who ignore it: a flow without agent labels streams exactly as today.

### 2. Roster (user picks)

- A Chat trigger option **Agents the visitor can pick**: a list of `{ key, label, face?, target }` where `target` names a node in the same flow
  (an agent or team node) the trigger can start. The public config (`GET /chat/<key>/config`) lists them (label and face only, never the node).
- The page shows the roster above the input (a row of faces on a phone, one tap to pick) and "Ask Billing" jumps to that agent. The message is sent
  with `agentKey`; the run starts at that target (the run API's `startNode` already exists), with the lead agent as the default when none is picked.
- **Sessions and memory.** The transcript is keyed `(workflowId, sessionId)` today (`loadTranscript`, `appendTranscript`). Add an `agentKey` to each
  message, keep one visible conversation, and give each agent its own memory session id (`<sessionId>:<agentKey>`) so a specialist does not see the
  lead's private notes. Whether the specialist also sees the visible transcript is a setting on the roster entry (default: yes, read-only).
- A visitor can never reach a node that isn't on the roster.

### 3. Tools, reading and saving information

Nothing new to build: the agents behind the chat use the tools they already have (Data Table, HTTP Request, MCP tools, plugin nodes, knowledge
bases). The spec adds only the **template** and **checks**: a built-in template "Chat with a team" (a Chat trigger, a lead agent, two specialists,
a data table to save to) and a Guardrails node placed between trigger and lead by default, since the page is public.

### 4. Voice

- **In:** a microphone button (push to talk). `SpeechRecognition` (`webkitSpeechRecognition`) fills the input as the visitor speaks and sends on
  release when "Send when I stop" is on. Language comes from the page or a trigger option.
- **Out:** a speaker toggle. `speechSynthesis` reads each finished reply; it never reads tool calls, names or code blocks, and stops when the visitor
  speaks or sends. A trigger option **Voice** (Off, Speech in, Speech in and out) controls whether the buttons show.
- **Where:** the hosted page and the widget share `chat-client.ts`, so one change serves both. Buttons are hidden where the browser lacks the API.
- **Privacy:** in Chrome, recognition sends audio to the browser vendor's service. The trigger's settings say so in one line, and a flow that must
  keep audio local leaves Voice off until the local-speech option exists. Audio is never stored by Landflow.
- **Later, behind the same interface:** a `/chat/<key>/transcribe` route to a local speech service. The unmerged `voice-spotlight` worktree's
  `/api/assistant/transcribe` route is the closest existing work and is not a dependency.

### Wire changes (all additive)

| Where | Change |
|---|---|
| `POST /chat/<key>` | optional `agentKey` |
| `GET /chat/<key>/config` | `agents: [{ key, label, face? }]`, `voice: 'off' \| 'in' \| 'inout'`, `voiceLang?` |
| SSE chunk | optional `agent: { id, name, face? }` |
| transcript message | optional `agentKey`, `agentName` |

## Plan

1. **Attribution.** Labels on chunks and stored messages; the page shows who answered and who was asked. Tests: wire chunk shape, transcript round trip,
   a flow without labels streams as before.
2. **Roster.** Trigger option, config exposure, `agentKey` on send, start at the target, per-agent memory ids, the visitor can't name a node off the
   roster. Tests: an off-roster key is refused, memory ids differ per agent, the lead is the default.
3. **Voice.** Trigger option, buttons in `chat-client.ts`, reading rules (what is spoken), stop on speak. Tests: the config flag, the text that is
   spoken (no tool calls or code), buttons hidden without the API. Check by hand in a visible Chrome and on a phone.
4. **Template and docs.** "Chat with a team", the Guardrails default, `features/ai.md`, `reference/api.md`, `limitations.md`, `roadmap.md`.

## First slice

Step 1 plus the lead-agent template: a chat where the lead delegates to two specialists and the page shows who answered. It needs no new trigger option
and proves the wire change.

## Open questions

- Does the existing chat session keep an agent's memory under the trigger's `sessionId`, and where does Simple Memory take its key? (Step 2 starts by
  reading it; the per-agent id above assumes the key can be set per agent node.)
- How a Run Team's members surface in the stream: one team voice, or each member labelled. Start with one label per team node.
- Voice on iOS Safari: `SpeechRecognition` support is partial, so the buttons must hide cleanly.

## Not planned here

Phone calls and telephony, server-side streaming audio (WebRTC or a realtime model), a visitor-facing agent builder.
