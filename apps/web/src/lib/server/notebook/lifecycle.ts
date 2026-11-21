/**
 * What a person does to a team note beyond writing it (docs/team-notebook.md#forgetting-a-note): forget it softly with a
 * reason, restore it, and settle a dispute so the loser leaves recall in the same transaction as the winner's verify. It is
 * the same vocabulary as a brain fact's forget (brain/fact-lifecycle.ts); a note keeps its own columns and `superseded_by`.
 */
import { recordAudit } from '../audit';
import { checkForgetAfter } from '../brain/facts';
import { noteStore } from './store';
import { NoteError } from './approve';
import type { TeamNote } from '../../shared/notebook';

const MAX_REASON = 500;

function mustHave(teamId: string, id: string): TeamNote {
  const note = noteStore.get(id);
  if (!note || note.teamId !== teamId) throw new NoteError('Note not found', 404);
  return note;
}

const audit = (action: 'notebook.note_forgotten' | 'notebook.note_restored', note: TeamNote, details: Record<string, string | number | boolean>) =>
  recordAudit({ action, target: { type: 'team_note', id: note.id, name: note.teamId }, project: note.projectId ?? null, details: { team: note.teamId, ...details } });

/**
 * Forget a note: it leaves every read and the prompt block but stays (with who and why) until restored or deleted, and the
 * sweeper never deletes it. With `forgetAfter` it only sets the note's expiry to that time (a note's forget-after is its expiry).
 */
export function forgetNote(teamId: string, id: string, input: { reason: string; forgetAfter?: string }, by: string): TeamNote {
  const reason = input.reason?.trim() ?? '';
  if (!reason || reason.length > MAX_REASON) throw new NoteError(`A reason of 1 to ${MAX_REASON} characters is required`);
  const note = mustHave(teamId, id);
  let forgetAfter: string | undefined;
  try {
    forgetAfter = checkForgetAfter(input.forgetAfter);
  } catch (caught) {
    throw new NoteError((caught as Error).message);
  }
  const columns: Record<string, string> = forgetAfter ? { expires_at: forgetAfter, forget_reason: reason, forgotten_by: by } : { forgotten_at: new Date().toISOString(), forget_reason: reason, forgotten_by: by };
  const forgotten = noteStore.patch(id, columns)!;
  audit('notebook.note_forgotten', note, { reason, from: 'live', to: forgetAfter ? 'expiring' : 'forgotten', ...(forgetAfter && { forgetAfter }) });
  return forgotten;
}

/** Bring a forgotten note back. A note whose expiry already passed is expired, not forgotten: that is not undone here. */
export function restoreNote(teamId: string, id: string, _by: string): TeamNote {
  const note = mustHave(teamId, id);
  if (!note.forgottenAt && !note.forgetReason) throw new NoteError('This note is not forgotten', 409);
  const restored = noteStore.patch(id, { forgotten_at: null, forget_reason: null, forgotten_by: null })!;
  audit('notebook.note_restored', note, { from: 'forgotten', to: 'live' });
  return restored;
}

/**
 * Settle a dispute in one transaction: `drop` is marked replaced by `keep` and expires now, `keep` stands verified. Either
 * both writes happen or neither does.
 */
export function supersedeNote(keep: TeamNote, drop: TeamNote, by: string, now = new Date().toISOString()): { kept: TeamNote; dropped: TeamNote } {
  const [dropped, kept] = [
    { id: drop.id, columns: { status: 'expired', superseded_by: keep.id, expires_at: now } },
    {
      id: keep.id,
      columns: { status: 'verified', verified_at: now, verified_by: by, dispute_of: null, ...(keep.scope === 'team' && { expires_at: null }) },
    },
  ];
  const done = noteStore.patchMany([dropped, kept]);
  return { dropped: done.find((n) => n.id === drop.id)!, kept: done.find((n) => n.id === keep.id)! };
}
