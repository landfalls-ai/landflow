/**
 * What the code around a model call knows about it that the model adapter does not: why it is made (purpose), which
 * step of an agent loop it is (iteration), and the prompt as Landflow built it (draft, in memory only). Opened with
 * AsyncLocalStorage around the call, read by telemetry/ai.ts and ai-usage/index.ts (SP01), and handed to whoever
 * listens for recorded calls (SP03 writes the parts).
 *
 * Contract file: owned by SP01 (`apps/web/src/lib/server/ai-usage/call-context.ts`), copied byte for byte by SP02 and
 * SP03 (backbone/contracts/s11/README.md). Server only.
 *
 * Rules:
 * - `purpose`, `iteration` and `callerAgentId` are inherited by nested notes; an inner value overrides an outer one.
 * - `draft` is never inherited by a nested `withCallNote`, and it is taken once: the first chat call recorded inside
 *   the note gets it (a fallback model that answers after the first failed gets it, since a failed call records
 *   nothing); every later call inside the same note gets none.
 * - The draft holds prompt text in memory for the length of one call. It is never stored, logged, put on a span or
 *   sent anywhere; only the sizes, token counts and hashes made from it are (constitution note 17).
 * - The listener is one function, replaced by each `setRecordedCallListener` (constitution note 10). It is called
 *   synchronously from the meter's `record()` after the row is written; it must not throw (a throw is caught and
 *   logged) and does any slow work after returning (queueMicrotask / setImmediate). Accounting never waits for it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallPurpose } from '../../shared/ai-call';
import type { PromptPart } from '../../shared/ai-call-parts';
import { singleton } from '../singleton';

/** One piece of the prompt as sent, in order. `where` is the request field it went into. */
export interface DraftSegment {
  part: PromptPart;
  where: 'tools' | 'system' | 'messages';
  /** The text (for tools: the JSON of the tool's name, description and input schema as the adapter sends it). */
  text: string;
  /** The adapter asks for a cache breakpoint right after this segment. */
  breakpoint?: boolean;
}

/** The prompt one call is about to send, as Landflow built it. In memory only. */
export interface PromptDraft {
  segments: DraftSegment[];
  /** Images in the messages (counted as a part of their own; never hashed). */
  images?: number;
  /** Tool names in the order sent. */
  toolNames?: string[];
}

export interface CallNote {
  purpose?: CallPurpose;
  /** The agent loop's step, from 1. */
  iteration?: number;
  /** The agent that asked (a team member's call, an agent tool, a sub-agent). */
  callerAgentId?: string;
  draft?: PromptDraft;
}

/** What the meter hands the listener after a row is written (a new row, or an imported row a call took over). */
export interface RecordedCall {
  usageId: string;
  at: string;
  provider: string;
  model: string;
  operation: 'chat' | 'embeddings';
  /** The whole prompt, cached tokens included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  gatewayRequestId?: string;
  executionId?: string;
  agentId?: string;
  sessionId?: string;
  /** The note in force for this call: its purpose, iteration and caller, and the draft when this call took it. */
  note: CallNote;
}

interface Store {
  note: CallNote;
  /** Shared by every call inside one note: the draft is taken once. */
  draftTaken: { value: boolean };
}

const storage = singleton('ai-call-context', () => new AsyncLocalStorage<Store>());

/** Run `fn` with `note` in force (merged over the outer note; the draft is not inherited). */
export function withCallNote<T>(note: CallNote, fn: () => T): T {
  const outer = storage.getStore()?.note;
  const merged: CallNote = {};
  const purpose = note.purpose ?? outer?.purpose;
  const iteration = note.iteration ?? outer?.iteration;
  const callerAgentId = note.callerAgentId ?? outer?.callerAgentId;
  if (purpose !== undefined) merged.purpose = purpose;
  if (iteration !== undefined) merged.iteration = iteration;
  if (callerAgentId !== undefined) merged.callerAgentId = callerAgentId;
  if (note.draft) merged.draft = note.draft;
  return storage.run({ note: merged, draftTaken: { value: false } }, fn);
}

/** Shorthand: run `fn` with only a purpose set. */
export function withCallPurpose<T>(purpose: CallPurpose, fn: () => T): T {
  return withCallNote({ purpose }, fn);
}

/** The note in force now, without its draft (for spans and rows). */
export function currentCallNote(): Omit<CallNote, 'draft'> {
  const note = storage.getStore()?.note;
  if (!note) return {};
  const { draft: _draft, ...rest } = note;
  return rest;
}

/** Take the draft for the call being recorded now (chat calls only); undefined once taken or when there is none. */
export function takeCallDraft(): PromptDraft | undefined {
  const store = storage.getStore();
  if (!store?.note.draft || store.draftTaken.value) return undefined;
  store.draftTaken.value = true;
  return store.note.draft;
}

type Listener = (call: RecordedCall) => void;
const listener = singleton('ai-call-recorded-listener', () => ({ current: undefined as Listener | undefined }));

/** Set (replace) the one listener for recorded calls; `undefined` removes it. */
export function setRecordedCallListener(fn: Listener | undefined): void {
  listener.current = fn;
}

/** Called by the meter after a row is written. Never throws. */
export function notifyRecorded(call: RecordedCall, warn: (message: string, error: unknown) => void = () => {}): void {
  try {
    listener.current?.(call);
  } catch (error) {
    warn('recorded-call listener failed', error);
  }
}
