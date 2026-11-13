/**
 * Pausing a team member and taking over (docs/run-trace.md#pause-and-take-over). A person asks a member to stop; a member
 * that is a Landflow agent (the lead too) stops at its next step boundary (after the model call or tool calls it is in the
 * middle of), keeps its session and waits for the person's instruction, which is added to its transcript as a message from
 * the person before the loop goes on. A remote member can't be stopped between steps from outside, so pausing it is "Stop and
 * redirect": its A2A task is canceled and the instruction goes to the same conversation as a new message.
 *
 * The wait is in this process, inside the team run's open call (a timeout, `LANDFLOW_TEAM_PAUSE_MINUTES`, lets it carry on
 * without an instruction); a host restart ends the run as it does any run (the pause is not saved). The pause and the
 * person's instruction are journaled: a wait span under the member's request, and a message from the person.
 */
import type { RunActor } from '../../shared/run-trace';
import { singleton } from '../singleton';
import { liveJournal } from '../journal/writer';
import { HttpError } from '../errors';

export type PauseState = 'working' | 'pausing' | 'paused';

export interface PausedMember {
  member: string;
  kind: 'agent' | 'remote';
  state: PauseState;
  /** Since when it is paused (or a pause was asked for). */
  since?: string;
}

export interface PausePerson {
  id: string;
  name: string;
}

/** What the agent loop (agents/runtime.ts) asks of a member's pause. */
export interface MemberPause {
  /** A person asked for a pause and the member has not paused yet. */
  requested(): boolean;
  /** Pause here: resolves with the person's instruction (none when it timed out, was canceled, or came empty). */
  wait(where: { summary: string; signal?: AbortSignal }): Promise<string | undefined>;
}

export interface HeldMember extends MemberPause {
  release(): void;
}

type Answer = { message?: string; by?: PausePerson; timedOut?: boolean };

interface Slot extends PausedMember {
  executionId: string;
  holders: number;
  under?: string;
  actor: RunActor;
  wake?: (answer: Answer) => void;
  /** A remote member: cancel the task it is working on (resolves once it has been asked to stop). */
  stop?: () => Promise<void>;
  waits: number;
}

const slots = singleton('team-pauses', () => new Map<string, Slot>());
const keyOf = (executionId: string, member: string) => `${executionId}\u0000${member.trim().toLowerCase()}`;

/** How long a pause waits for a person before the member goes on without an instruction. */
export const pauseLimitMs = () => Math.max(1, Number(process.env.LANDFLOW_TEAM_PAUSE_MINUTES) || 30) * 60_000;

const human = (person?: PausePerson): RunActor => ({ id: `human:${person?.id ?? 'unknown'}`, name: person?.name || 'A person', type: 'human' });
const view = (s: Slot): PausedMember => ({ member: s.member, kind: s.kind, state: s.state, ...(s.since && { since: s.since }) });

/** The members of an execution that are working now, paused or about to be (in this process). */
export function activeMembers(executionId: string): PausedMember[] {
  return [...slots.values()].filter((s) => s.executionId === executionId).map(view);
}

/** Every member held in the process, with its execution (tests). */
export function allActiveMembers(): Array<PausedMember & { executionId: string }> {
  return [...slots.values()].map((s) => ({ ...view(s), executionId: s.executionId }));
}

/**
 * A member starts working in an execution: it can be paused until `release()`. `under` is the span of the request that asked
 * it (the node's span for the lead), where the pause is journaled.
 */
export function holdMember(executionId: string, member: string, kind: 'agent' | 'remote', options: { under?: string; actor: RunActor; stop?: () => Promise<void> }): HeldMember {
  const key = keyOf(executionId, member);
  let slot = slots.get(key);
  if (!slot) {
    slot = { executionId, member, kind, state: 'working', holders: 0, actor: options.actor, waits: 0 };
    slots.set(key, slot);
  }
  const mine = slot;
  mine.holders++;
  mine.under = options.under ?? mine.under;
  mine.actor = options.actor;
  if (options.stop) mine.stop = options.stop;
  let released = false;
  return {
    requested: () => mine.state === 'pausing',
    async wait(where) {
      const journal = liveJournal(executionId);
      const under = mine.under ?? 'run';
      const waitId = `${under}/pause:${++mine.waits}`;
      mine.state = 'paused';
      mine.since = new Date().toISOString();
      try {
        journal?.record({
          type: 'span.started',
          spanId: waitId,
          parentSpanId: under,
          kind: 'wait',
          name: `${member} is paused`,
          actor: human(),
          caller: mine.actor,
          input: where.summary,
          attrs: { wait: 'pause', member, mode: mine.kind === 'remote' ? 'redirect' : 'pause' },
        });
        journal?.record({ type: 'span.updated', spanId: under, state: 'paused', note: where.summary });
      } catch {}
      const answer = await new Promise<Answer>((resolve) => {
        const finish = (value: Answer) => {
          clearTimeout(timer);
          where.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish({});
        const timer = setTimeout(() => finish({ timedOut: true }), pauseLimitMs());
        timer.unref?.();
        mine.wake = finish;
        if (where.signal?.aborted) onAbort();
        else where.signal?.addEventListener('abort', onAbort, { once: true });
      });
      mine.wake = undefined;
      mine.state = 'working';
      mine.since = undefined;
      const text = answer.message?.trim();
      try {
        if (text) journal?.record({ type: 'message', spanId: waitId, from: human(answer.by), to: mine.actor, text });
        else if (answer.timedOut) journal?.record({ type: 'message', spanId: waitId, from: mine.actor, text: `Nobody took over within ${Math.round(pauseLimitMs() / 60_000)} minutes: ${member} carried on.` });
        journal?.record({ type: 'span.ended', spanId: waitId, status: where.signal?.aborted ? 'canceled' : 'success' });
        journal?.record({ type: 'span.updated', spanId: under, state: 'working', note: '' });
      } catch {}
      return text || undefined;
    },
    release() {
      if (released) return;
      released = true;
      mine.holders--;
      if (mine.holders <= 0) {
        mine.wake?.({});
        slots.delete(key);
      }
    },
  };
}

export class PauseError extends HttpError {
  static readonly errorName: string = 'PauseError';
  constructor(
    message: string,
    status = 409,
  ) {
    super(message, status, { expose: true });
  }
}

/** Ask a member to pause: an agent stops at its next step boundary, a remote member's task is canceled now. */
export async function requestPause(executionId: string, member: string, by?: PausePerson): Promise<PausedMember> {
  const slot = slots.get(keyOf(executionId, member));
  if (!slot) throw new PauseError(`${member} is not working in this run now (or the run is on another server)`, 404);
  if (slot.state !== 'working') return view(slot);
  slot.state = 'pausing';
  slot.since = new Date().toISOString();
  const who = by?.name ?? 'A person';
  try {
    if (slot.under) liveJournal(executionId)?.record({ type: 'span.updated', spanId: slot.under, state: 'pausing', note: slot.kind === 'remote' ? `${who} stopped ${member} to redirect it` : `${who} asked ${member} to pause after its current step` });
  } catch {}
  if (slot.kind === 'remote') {
    try {
      await slot.stop?.();
    } catch (error) {
      slot.state = 'working';
      slot.since = undefined;
      throw new PauseError(`Could not stop ${member}: ${(error as Error).message}`, 502);
    }
  }
  return view(slot);
}

/** The person's instruction for a paused member: it goes on with it. An empty one lets it go on as it was. */
export function continueMember(executionId: string, member: string, message: string | undefined, by?: PausePerson): PausedMember {
  const slot = slots.get(keyOf(executionId, member));
  if (!slot) throw new PauseError(`${member} is not working in this run now`, 404);
  if (slot.state !== 'paused' || !slot.wake) throw new PauseError(`${member} is not paused${slot.state === 'pausing' ? ' yet: it stops after its current step' : ''}`);
  const before = view(slot);
  slot.wake({ ...(message?.trim() && { message: message.trim() }), ...(by && { by }) });
  return { ...before, state: 'working' };
}
