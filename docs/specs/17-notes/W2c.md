# W2c notes: browser-speech voice

Rows for the integrator (W2c edited none of the shared docs).

## docs/features/ai.md, under "Hosted chat and widget"

- **Voice** (Chat trigger option, when public): Off (default), Speech in, Speech in and out, plus an optional language tag (`Voice Language`) and `Send When the Visitor Stops` (default on). The page and widget use the visitor's browser speech. Speech in: a microphone button you hold to talk (`SpeechRecognition` / `webkitSpeechRecognition`); the words fill the input as you speak and, on release, are sent (or left to edit when Send When the Visitor Stops is off). Speech in and out adds a speaker toggle (`speechSynthesis`) that reads each finished reply aloud, without tool calls, "asked X" lines, agent names, code blocks, inline code or link addresses; it stops when the visitor holds the microphone or sends. Buttons appear only where the browser has the API (iOS Safari: often speech out only). Privacy: in Chrome, recognition sends the audio to the browser vendor's service; Landflow never stores audio. The big tap targets (48 px, 60 px mic) fit one-handed use on a phone. A flow with Voice off builds the same page as before.

## docs/reference/api.md, wire table

| Where | Change |
|---|---|
| `GET /chat/<key>/config` | `voice: 'off' \| 'in' \| 'inout'` (always present, `off` by default); when not off, `voiceSend: boolean` and, if set, `voiceLang` |

## docs/reference/ (trigger options)

Chat Message trigger: `voice` (options, off), `voiceLang` (string), `voiceSend` (boolean, true). All shown when Public is on (`voiceLang`, `voiceSend` when Voice is not Off).

## docs/limitations.md

- Voice uses the browser's speech only: recognition quality, languages and privacy are the browser's (Chrome sends audio to its vendor; Firefox has no `SpeechRecognition`; iOS Safari support is partial), and there is no local speech service yet (a later `/chat/<key>/transcribe`).
- Replies are read after they finish, not while they stream; the speaker toggle is per page load (not remembered). Hold-to-talk only; no hands-free or wake word. A text-only Markdown reading (no table or list announcements).
- Push-to-talk is ignored while a reply is being written.

## docs/roadmap.md

Chat with agents (spec 16), step 3 built (Voice option, config fields, microphone and speaker in the shared client, reading rules). Open: a local speech service behind the same buttons, streaming speech, a remembered speaker toggle.

## docs/history.md

Row: "Chat with agents, step 3: Chat trigger option 'Voice' (Off, Speech in, Speech in and out) with language and send-on-release, `voice` / `voiceLang` / `voiceSend` in the public config, a hold-to-talk microphone and a speaker toggle in the shared chat client (hidden where the browser lacks the API), and the `spokenText` reading rules with tests."
