/**
 * Checkpoints of the assistant's chats (Spotlight and the Agent architect): when a model call fails or a reply stalls
 * after some tool steps, the messages so far (with the tool results) are kept here, and the client can continue from
 * them with `resume: { checkpoint }` instead of starting over. A checkpoint lives in this process for 15 minutes, at
 * most 200 are kept (the oldest is dropped), and only the user who made it can take it.
 */
import { nanoid } from 'nanoid';
import { HttpError } from '../errors';
import { singleton } from '../singleton';

export const CHECKPOINT_TTL_MS = 15 * 60_000;
export const MAX_CHECKPOINTS = 200;

export class CheckpointExpiredError extends HttpError {
  static readonly errorName: string = 'CheckpointExpiredError';

  constructor() {
    super('That chat can no longer be continued. Send your message again.', 409, { code: 'checkpoint_expired' });
  }
}

interface Entry {
  userId: string;
  at: number;
  state: unknown;
}

const store = () => singleton('assistant-checkpoints', () => new Map<string, Entry>());

/** Keep `state` for `userId`; returns the checkpoint id the client sends back to continue. */
export function saveCheckpoint(userId: string | undefined, state: unknown, now = Date.now()): string {
  const entries = store();
  for (const [id, entry] of entries) if (now - entry.at > CHECKPOINT_TTL_MS) entries.delete(id);
  // Maps keep insertion order: the first keys are the oldest.
  while (entries.size >= MAX_CHECKPOINTS) entries.delete(entries.keys().next().value as string);
  const id = `ck_${nanoid(16)}`;
  entries.set(id, { userId: userId ?? 'anonymous', at: now, state });
  return id;
}

/** The state saved under `id` for `userId`, removed from the store. Unknown, expired and other users' ids throw CheckpointExpiredError. */
export function takeCheckpoint<T>(userId: string | undefined, id: string, now = Date.now()): T {
  const entries = store();
  const entry = entries.get(id);
  if (!entry || entry.userId !== (userId ?? 'anonymous') || now - entry.at > CHECKPOINT_TTL_MS) {
    if (entry && now - entry.at > CHECKPOINT_TTL_MS) entries.delete(id);
    throw new CheckpointExpiredError();
  }
  entries.delete(id);
  return entry.state as T;
}
