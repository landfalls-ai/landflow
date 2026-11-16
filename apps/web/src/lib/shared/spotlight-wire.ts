/**
 * What Spotlight's chat stream adds in wave sb2, beside the events of lib/server/assistant/chat.ts (`ChatEvent`) and
 * components/editor/assistant.ts (`StreamEvent`): a question back to the person (`ask_user`, SB11, finding 2.2) and a
 * credential to pick (SB12, decision D2). Both server and editor import these shapes; neither redefines them.
 *
 * Contract file: backbone/contracts/sb2/spotlight-wire.ts, copied byte for byte to
 * apps/web/src/lib/shared/spotlight-wire.ts by SB11 (owner), SB12 and SB10 (the scenario harness reads both events into
 * `Outcome.asked` and `Outcome.offers`, contracts/sb2/spotlight-scenario.ts). Change it in the contracts folder first.
 * Pure: types, constants and pure functions only, no imports, no I/O.
 */

/** The tool the chat offers for a question back (SB11). Not offered in a test-and-fix session (`session` fix/review). */
export const ASK_USER_TOOL = 'ask_user';

/** At most this many choices; at least two. A choice is a short phrase the person could have typed (≤ 80 characters). */
export const ASK_CHOICES_MIN = 2;
export const ASK_CHOICES_MAX = 4;
export const ASK_CHOICE_MAX_CHARS = 80;

/**
 * `ask_user`'s input, as the model sends it. The chat checks it (2–4 non-empty, distinct choices, each ≤ 80 characters,
 * a question ≤ 300 characters): a bad one is sent back once as a tool error, then the reply ends with the question as
 * plain text. An `ask_user` ends the reply: no `propose_changes` in the same step is applied or held (it is dropped
 * and listed in the trace), and the model is not called again until the person answers.
 */
export interface AskUserInput {
  question: string;
  choices: string[];
}

/**
 * The stream event of a question back (after the step's `text`, before `done`). The editor shows it as a row with one
 * chip per choice and the box below for an answer of one's own; a chip sends its words as the next message, typed by
 * the person (never `auto`), so `askKind` and the scope rules read it as any typed message.
 */
export interface AskEvent {
  type: 'ask';
  question: string;
  choices: string[];
  step?: number;
}

/**
 * SB09 × SB11: a reply that asked, as the editor sends it back in the history (after the reply's text). The next
 * person's message is the answer (a chip's words, or their own), not the request: the request is the message before
 * the question with the answer after it (`requestAcrossAsk`), so the chat's checks of what was asked (a day named,
 * "continue on error", a duration) read the request, not "Morning" or "Call".
 */
export const askedLine = (choices: readonly string[]) => `[Asked; choices: ${choices.map((c) => `“${c}”`).join(', ')}]`;

const ASKED_LINE = /^\[Asked; choices: .*\]$/m;

/**
 * The request the latest person's message belongs to: that message alone, or, when the reply before it asked
 * (`askedLine`), the person's message before the question, then the answer, one per line (through several questions in
 * a row). '' when there is no person's message.
 */
export function requestAcrossAsk(messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): string {
  let at = messages.findLastIndex((m) => m.role === 'user');
  if (at < 0) return '';
  const parts = [messages[at].content];
  while (at >= 2 && messages[at - 1].role === 'assistant' && ASKED_LINE.test(messages[at - 1].content) && messages[at - 2].role === 'user') {
    parts.unshift(messages[at - 2].content);
    at -= 2;
  }
  return parts.join('\n');
}

/** The reply part the editor keeps for it (`ReplyPart` in components/editor/assistant.ts). `answered`: a chip was sent. */
export interface AskPart {
  kind: 'ask';
  ask: { question: string; choices: string[]; answered?: string };
}

/**
 * The stream event of a credential to pick (SB12, decision D2): a step of the change needs a credential it has none
 * of. Spotlight never sees, picks or sets a secret: it names the step and the credential types the step accepts, and
 * the editor's picker lists the person's own credentials of those types (GET /api/credentials?workflowId=, names only)
 * with "Create one". Nothing is set until the person picks, never on its own when exactly one fits. The editor turns
 * the event into a `needs` part (`Need.what: 'credential'`, with `nodeId` and `credentialTypes`).
 */
export interface CredentialOfferEvent {
  type: 'credential';
  /** The step's name and id in the workflow as it is after the proposal (a step the proposal adds has its id once applied: the editor resolves by name then). */
  node: string;
  nodeId?: string;
  /** The credential types the step accepts for its current settings (the node type's `credentials` whose `displayOptions` hold), in order. */
  credentialTypes: string[];
  /** One line for the row: "“Fetch status” needs a credential: pick one or create one." */
  text: string;
  step?: number;
}

/** The fields SB12 adds to `Need` (components/editor/assistant.ts) for a credential row; the rest of `Need` stays. */
export interface CredentialNeedFields {
  nodeId?: string;
  credentialTypes?: string[];
  /** After a pick: the credential's name (never its id in text, never its data). */
  picked?: string;
}

/** The two events wave sb2 adds to the stream, for a `switch` on `type`. */
export type SpotlightWireEvent = AskEvent | CredentialOfferEvent;
