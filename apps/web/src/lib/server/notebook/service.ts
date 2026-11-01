/**
 * What the notebook does (docs/team-notebook.md), for the tools a member calls and the routes a person uses. The rules:
 *
 * - **Members write to the run.** A note a member adds belongs to the execution it was written in. The lead (or any manager)
 *   promotes it to the team; promoting to the project is a suggestion in the second brain's inbox that a person applies.
 * - **Outside sources are tainted.** A note that came from a URL or a page a member fetched needs a person's Verify before it
 *   goes up a scope, so a poisoned page can't write itself into the team's memory.
 * - **Disputes keep both.** A member that disagrees with a note adds its own, linked to it; both stay and are shown side by
 *   side until a person (or the lead) settles which one holds.
 * - **`traceContent: off`** keeps where a note came from (execution, span, member) but not the quote it came with.
 */
import type { TraceContent } from '../../shared/run-trace';
import { NOTE_KINDS, type NoteKind, type NoteHit, type NoteScope, type NoteSource, type TeamNote } from '../../shared/notebook';
import { agentTeamStore } from '../agent-teams/store';
import { fingerprintOf, upsertProposal } from '../brain/proposals';
import { homeProjectId } from '../projects/store';
import { NoteError } from './approve';
import { embedModel, embedTexts } from './embed';
import { searchNotes } from './search';
import { expiryOf, noteStore } from './store';

export { NoteError } from './approve';

/** What the notebook needs to know about who is calling and for which run. */
export interface NotebookBinding {
  team: { id: string; name: string };
  projectId?: string;
  /** The execution (a team run has one; a test or an ad-hoc call makes one up). */
  runId: string;
  workflowId?: string;
  member: { id?: string; title: string };
  /** A member with reports (the lead included): may promote and settle. */
  manager: boolean;
  content: TraceContent;
}

/** What a call adds to the note's provenance. */
export interface CallExtras {
  /** The span of the call that made the note (the member's request in the Run Trace). */
  spanId?: string;
  /** The member read a web page or file earlier in this task: what it notes may come from there. */
  sawOutside?: boolean;
}

const MAX_TEXT = 600;
const MAX_QUOTE = 300;
const MAX_PER_RUN_MEMBER = 80;
const URL_IN_TEXT = /\bhttps?:\/\/\S+/i;

export const projectOf = (teamId: string) => homeProjectId('agentTeam', teamId);

const clean = (text: unknown) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');
const kindOf = (value: unknown): NoteKind => (NOTE_KINDS.includes(value as NoteKind) ? (value as NoteKind) : 'fact');

/** Make the embedding for a note; a failure leaves it found by its words. */
async function embedNote(note: TeamNote) {
  const made = await embedTexts([note.text], 'document');
  if (made) noteStore.setEmbedding(note.id, made.vectors[0], made.model || embedModel());
}

const short = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A member writes a note to the run. Returns the note, and whether it already stood in the run's notebook. */
export async function addNote(binding: NotebookBinding, args: Record<string, unknown>, extras: CallExtras = {}): Promise<{ note: TeamNote; existing: boolean }> {
  const text = clean(args.text);
  if (!text) throw new NoteError('"text" is empty: say the fact, decision or question in a sentence');
  if (text.length > MAX_TEXT) throw new NoteError(`Keep a note under ${MAX_TEXT} characters (it is ${text.length}): one fact or decision per note`);
  const kind = kindOf(args.kind);
  const here = noteStore.list({ teamId: binding.team.id, onlyRun: binding.runId, limit: 1000 });
  const same = here.find((n) => n.kind === kind && n.text.toLowerCase() === text.toLowerCase());
  if (same) return { note: same, existing: true };
  if (here.filter((n) => n.authorId === binding.member.id && n.author === binding.member.title).length >= MAX_PER_RUN_MEMBER) {
    throw new NoteError(`${binding.member.title} has written ${MAX_PER_RUN_MEMBER} notes in this run: update or dispute the ones that exist instead of adding more`);
  }
  const url = clean(args.url).slice(0, 500);
  const quote = clean(args.quote).slice(0, MAX_QUOTE);
  const source: NoteSource = {
    executionId: binding.runId,
    ...(extras.spanId && { spanId: extras.spanId }),
    tool: 'note_add',
    ...(url && { url }),
    // The quote is run content: with traceContent off the run keeps where a note came from, not what it said.
    ...(quote && binding.content !== 'off' && { excerpt: quote }),
  };
  const note = noteStore.insert({
    teamId: binding.team.id,
    ...(binding.projectId && { projectId: binding.projectId }),
    runId: binding.runId,
    ...(binding.workflowId && { workflowId: binding.workflowId }),
    kind,
    text,
    scope: 'run',
    author: binding.member.title,
    ...(binding.member.id && { authorId: binding.member.id }),
    source,
    tainted: Boolean(url) || URL_IN_TEXT.test(text) || Boolean(extras.sawOutside),
  });
  await embedNote(note);
  return { note: noteStore.get(note.id)!, existing: false };
}

/** Find notes: this run's, the team's and the project's. */
export async function findNotes(binding: NotebookBinding, args: Record<string, unknown>): Promise<{ hits: NoteHit[]; via: 'meaning' | 'keywords' }> {
  const query = clean(args.query);
  if (!query) throw new NoteError('"query" is empty: say what you want to know');
  const limit = typeof args.limit === 'number' ? args.limit : 5;
  const kinds = NOTE_KINDS.includes(args.kind as NoteKind) ? [args.kind as NoteKind] : undefined;
  return searchNotes(query, { teamId: binding.team.id, ...(binding.projectId && { projectId: binding.projectId }), runId: binding.runId, ...(kinds && { kinds }) }, limit);
}

/** A note this run can see and change: found in the team's notebook (any scope) and not gone. */
function visible(binding: NotebookBinding, id: unknown): TeamNote {
  const note = typeof id === 'string' ? noteStore.get(id.trim()) : undefined;
  const mine =
    note &&
    note.status !== 'expired' &&
    ((note.teamId === binding.team.id && (note.scope !== 'run' || note.runId === binding.runId)) || (note.scope === 'project' && Boolean(binding.projectId) && note.projectId === binding.projectId));
  if (!note || !mine) throw new NoteError(`No note ${String(id ?? '')} in this run's notebook: search for it first`, 404);
  return note;
}

/** A member changes a note: its text, an open question's answer, whether it stands. A member edits its own notes; a manager edits any. */
export async function updateNote(binding: NotebookBinding, args: Record<string, unknown>): Promise<TeamNote> {
  const note = visible(binding, args.id);
  const answer = clean(args.answer);
  const text = clean(args.text);
  const status = typeof args.status === 'string' ? args.status : undefined;
  if (note.scope === 'project') throw new NoteError('A project note is changed by a person, in the Notebook tab');
  if (answer) {
    if (note.kind !== 'open_question') throw new NoteError('Only an open question takes an answer');
    return noteStore.patch(note.id, { answer: answer.slice(0, MAX_TEXT), status: 'answered' })!;
  }
  const own = note.author === binding.member.title;
  if (!own && !binding.manager) throw new NoteError(`This note is ${note.author}'s: only they or a manager change it. Dispute it with note_dispute if you disagree`, 403);
  const columns: Record<string, string | number | null> = {};
  if (text) {
    if (text.length > MAX_TEXT) throw new NoteError(`Keep a note under ${MAX_TEXT} characters`);
    columns.text = text;
    columns.embedding = null;
    columns.embedding_model = null;
  }
  if (status === 'verified') {
    if (!binding.manager) throw new NoteError('Only a manager verifies a note');
    if (note.tainted) throw new NoteError('This note was read from outside the team: a person verifies it in the Notebook tab');
    Object.assign(columns, { status: 'verified', verified_at: new Date().toISOString(), verified_by: binding.member.title });
    if (note.scope === 'team') columns.expires_at = null;
  } else if (status === 'open' || status === 'unverified') columns.status = note.kind === 'open_question' ? 'open' : status;
  else if (status) throw new NoteError('"status" is verified, unverified or open; use "answer" to answer a question');
  if (!Object.keys(columns).length) throw new NoteError('Nothing to change: give "text", "answer" or "status"');
  const next = noteStore.patch(note.id, columns)!;
  if (text) await embedNote(next);
  return noteStore.get(note.id)!;
}

/** A member disagrees with a note: its own, linked to the first; both stay until the dispute is settled. */
export async function disputeNote(binding: NotebookBinding, args: Record<string, unknown>, extras: CallExtras = {}): Promise<{ note: TeamNote; against: TeamNote }> {
  const against = visible(binding, args.id);
  const text = clean(args.text);
  if (!text) throw new NoteError('"text" is empty: say what is true instead, and why');
  if (text.length > MAX_TEXT) throw new NoteError(`Keep a note under ${MAX_TEXT} characters`);
  const note = noteStore.insert({
    teamId: binding.team.id,
    ...(binding.projectId && { projectId: binding.projectId }),
    runId: binding.runId,
    ...(binding.workflowId && { workflowId: binding.workflowId }),
    kind: against.kind === 'open_question' ? 'fact' : against.kind,
    text,
    scope: 'run',
    author: binding.member.title,
    ...(binding.member.id && { authorId: binding.member.id }),
    source: { executionId: binding.runId, ...(extras.spanId && { spanId: extras.spanId }), tool: 'note_dispute' },
    tainted: URL_IN_TEXT.test(text) || Boolean(extras.sawOutside),
    disputes: against.id,
    status: 'disputed',
  });
  noteStore.patch(against.id, { status: 'disputed' });
  await embedNote(note);
  return { note: noteStore.get(note.id)!, against: noteStore.get(against.id)! };
}

/** A manager moves a run note to the team, or suggests a team note for the project (a person applies the suggestion). */
export function promoteNote(binding: NotebookBinding, args: Record<string, unknown>): { note: TeamNote; to: NoteScope; proposalId?: string } {
  if (!binding.manager) throw new NoteError('Only a manager promotes notes: ask your manager to');
  return promote(visible(binding, args.id), args.to === 'project' ? 'project' : 'team', binding.member.title);
}

/** Moving a note up: run to team now, team to project as a suggestion. Tainted notes need a Verify first. */
export function promote(note: TeamNote, to: 'team' | 'project', by: string): { note: TeamNote; to: NoteScope; proposalId?: string } {
  if (note.status === 'expired') throw new NoteError('This note expired', 409);
  if (note.status === 'disputed') throw new NoteError('This note is disputed: settle the dispute first', 409);
  if (note.tainted && !note.verifiedAt) throw new NoteError('This note was read from outside the team (a page or URL): a person verifies it in the Notebook tab before it goes up', 409);
  if (note.scope === 'project') throw new NoteError('It is already a project note', 409);
  if (to === 'team') {
    if (note.scope === 'team') throw new NoteError('It is already a team note', 409);
    const verified = note.status === 'verified';
    const moved = noteStore.patch(note.id, { scope: 'team', promoted_from: 'run', expires_at: expiryOf('team', verified) ?? null })!;
    return { note: moved, to: 'team' };
  }
  // The project: a suggestion in the inbox. A run note goes to the team first.
  const base = note.scope === 'run' ? noteStore.patch(note.id, { scope: 'team', promoted_from: 'run', expires_at: expiryOf('team', note.status === 'verified') ?? null })! : note;
  const proposal = upsertProposal({
    source: 'notebook',
    label: 'Team notebook',
    fingerprint: fingerprintOf('notebook', base.id),
    ...(base.projectId && { projectId: base.projectId }),
    target: { type: 'team', id: base.teamId, name: teamName(base.teamId) },
    title: `Keep this for the project: ${short(base.text, 100)}`,
    why: `${by} suggests the ${teamName(base.teamId)} team's note “${short(base.text, 240)}” (${base.kind.replace('_', ' ')}, noted by ${base.author}) is worth keeping for every team in the project. Applying it makes it a project note: it stays until you delete it and the project's teams can find it.`,
    evidence: [
      { label: 'Noted by', value: base.author },
      ...(base.source.executionId ? [{ label: 'Run', href: `/runs/${base.source.executionId}?tab=trace` }] : []),
      { label: 'Notebook', href: `/agents/teams/${base.teamId}?tab=notebook` },
    ],
    ops: [],
    risk: 'low',
    confidence: 0.7,
    score: 6,
    notebook: { teamId: base.teamId, noteId: base.id },
  });
  if (!proposal) throw new NoteError('This was dismissed recently: it can be suggested again later', 409);
  const marked = noteStore.patch(base.id, { proposal_id: proposal.id })!;
  return { note: marked, to: 'project', proposalId: proposal.id };
}

const teamName = (teamId: string): string => agentTeamStore.get(teamId)?.draft.name || 'team';

// ---------------------------------------------------------------------------
// A person at the Notebook tab
// ---------------------------------------------------------------------------

function mustHave(teamId: string, id: string): TeamNote {
  const note = noteStore.get(id);
  if (!note || note.teamId !== teamId) throw new NoteError('Note not found', 404);
  return note;
}

/** A person adds a note to the team's notebook (it stands as verified: they said it). */
export async function personAdd(teamId: string, by: string, input: { kind?: unknown; text: unknown }): Promise<TeamNote> {
  const text = clean(input.text);
  if (!text) throw new NoteError('Write the note first');
  if (text.length > MAX_TEXT) throw new NoteError(`Keep a note under ${MAX_TEXT} characters`);
  const kind = kindOf(input.kind);
  const note = noteStore.insert({
    teamId,
    ...(projectOf(teamId) && { projectId: projectOf(teamId) }),
    kind,
    text,
    scope: 'team',
    status: kind === 'open_question' ? 'open' : 'verified',
    author: by,
    verifiedBy: by,
    source: {},
  });
  await embedNote(note);
  return noteStore.get(note.id)!;
}

/** A person checks a note: it stays, and a team note no longer expires. */
export function verify(teamId: string, id: string, by: string): TeamNote {
  const note = mustHave(teamId, id);
  if (note.status === 'expired') throw new NoteError('This note expired', 409);
  return noteStore.patch(id, {
    status: note.kind === 'open_question' ? note.status : 'verified',
    verified_at: new Date().toISOString(),
    verified_by: by,
    ...(note.scope === 'team' && { expires_at: null }),
  })!;
}

export function answer(teamId: string, id: string, text: unknown): TeamNote {
  const note = mustHave(teamId, id);
  const reply = clean(text);
  if (note.kind !== 'open_question') throw new NoteError('Only an open question takes an answer', 409);
  if (!reply) throw new NoteError('Write the answer first');
  return noteStore.patch(id, { answer: reply.slice(0, MAX_TEXT), status: 'answered' })!;
}

export function reopen(teamId: string, id: string): TeamNote {
  const note = mustHave(teamId, id);
  if (note.kind !== 'open_question') throw new NoteError('Only an open question can be reopened', 409);
  return noteStore.patch(id, { status: 'open', answer: null })!;
}

/** A person adds a note that disagrees with another (the Dispute button). */
export async function personDispute(teamId: string, id: string, by: string, text: unknown): Promise<{ note: TeamNote; against: TeamNote }> {
  const against = mustHave(teamId, id);
  const said = clean(text);
  if (!said) throw new NoteError('Say what is true instead');
  const note = noteStore.insert({
    teamId,
    ...(against.projectId && { projectId: against.projectId }),
    ...(against.runId && { runId: against.runId }),
    kind: against.kind === 'open_question' ? 'fact' : against.kind,
    text: said.slice(0, MAX_TEXT),
    scope: against.scope,
    author: by,
    source: {},
    disputes: against.id,
    status: 'disputed',
  });
  noteStore.patch(against.id, { status: 'disputed' });
  await embedNote(note);
  return { note: noteStore.get(note.id)!, against: noteStore.get(against.id)! };
}

/** Settle a dispute: `keep` stands (verified), the other is marked as replaced by it and expires. */
export function resolveDispute(teamId: string, id: string, keep: string, by: string): { kept: TeamNote; dropped: TeamNote } {
  const a = mustHave(teamId, id);
  // The pair: the note that disputes, and the one it disputes (either may be named).
  const first = a.disputes ? mustHave(teamId, a.disputes) : a;
  const second = a.disputes ? a : noteStore.all(teamId).find((n) => n.disputes === a.id);
  if (!second) throw new NoteError('Nothing disputes this note', 409);
  if (keep !== first.id && keep !== second.id) throw new NoteError('Keep one of the two notes in the dispute', 400);
  const dropped = keep === first.id ? second : first;
  const now = new Date().toISOString();
  noteStore.patch(dropped.id, { status: 'expired', superseded_by: keep, expires_at: now });
  const kept = noteStore.patch(keep, {
    status: 'verified',
    verified_at: now,
    verified_by: by,
    dispute_of: null,
    ...((first.id === keep ? first : second).scope === 'team' && { expires_at: null }),
  })!;
  return { kept, dropped: noteStore.get(dropped.id)! };
}

export function remove(teamId: string, id: string): void {
  mustHave(teamId, id);
  // A dispute's other side loses its link, and goes back to standing on its own.
  for (const other of noteStore.all(teamId)) {
    if (other.disputes === id) noteStore.patch(other.id, { dispute_of: null, status: other.kind === 'open_question' ? 'open' : 'unverified' });
  }
  noteStore.delete(id);
}

// ---------------------------------------------------------------------------
// What the model reads
// ---------------------------------------------------------------------------

/** A note as one line for the model (or the prompt). */
export function lineOf(note: TeamNote & { score?: number }): string {
  const standing = note.status === 'verified' ? 'verified' : note.status === 'unverified' ? 'unverified' : note.status;
  const scope = note.scope === 'run' ? 'this run' : note.scope;
  return `- [${note.id}] ${note.kind.replace('_', ' ')} (${standing}, ${scope}, by ${note.author}${note.tainted && !note.verifiedAt ? ', from outside: unchecked' : ''}): ${note.text}${note.answer ? ` -> Answer: ${note.answer}` : ''}${note.disputes ? ` (disputes ${note.disputes})` : ''}`;
}

/**
 * A short block for the start of a request: the team's open questions and decisions, so members don't re-ask or undo them.
 * Empty when the notebook has neither. Reading them counts as using them.
 */
export function notebookBlock(binding: NotebookBinding): string {
  const visibleNotes = noteStore.list({ teamId: binding.team.id, ...(binding.projectId && { projectId: binding.projectId }), runId: binding.runId, limit: 200 });
  const open = visibleNotes.filter((n) => n.kind === 'open_question' && n.status === 'open').slice(0, 5);
  const decisions = visibleNotes.filter((n) => n.kind === 'decision' && n.status !== 'disputed').slice(0, 5);
  const disputed = visibleNotes.filter((n) => n.status === 'disputed' && n.kind !== 'open_question').slice(0, 3);
  if (!open.length && !decisions.length && !disputed.length) return '';
  noteStore.touch([...open, ...decisions]);
  return [
    'Team notebook (shared notes: search it with note_search before you start, add what you learn with note_add):',
    ...(decisions.length ? ['Decisions so far:', ...decisions.map((n) => `- ${n.text}`)] : []),
    ...(open.length ? ['Open questions:', ...open.map((n) => `- ${n.text}`)] : []),
    ...(disputed.length ? ['Disputed (do not rely on these):', ...disputed.map((n) => `- ${n.text}`)] : []),
  ].join('\n');
}
