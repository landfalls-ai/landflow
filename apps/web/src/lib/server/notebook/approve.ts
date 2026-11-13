/**
 * A person's yes to "keep this for the project", given by applying the inbox suggestion a promotion made
 * (brain/proposals.ts applyProposal). Kept apart from the service so the second brain can call it without a cycle.
 */
import { noteStore } from './store';
import { HttpError } from '../errors';

export class NoteError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

/** Move a team note to the project: verified by the person, no expiry, its suggestion closed. */
export function approveProjectNote(noteId: string, by: string | undefined) {
  const note = noteStore.get(noteId);
  if (!note) throw new NoteError('The note is gone: it expired or was deleted', 404);
  if (note.tainted && !note.verifiedAt) throw new NoteError('This note was read from outside the team: verify it first', 409);
  const now = new Date().toISOString();
  return noteStore.patch(noteId, {
    scope: 'project',
    promoted_from: note.scope === 'project' ? (note.promotedFrom ?? 'team') : note.scope,
    status: note.kind === 'open_question' ? note.status : 'verified',
    verified_at: note.verifiedAt ?? now,
    verified_by: note.verifiedBy ?? by ?? 'a person',
    expires_at: null,
    proposal_id: null,
  })!;
}
