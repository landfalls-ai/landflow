/**
 * The team notebook (docs/team-notebook.md): short typed notes a team writes while it works, shared across its members and
 * runs. Members write to the run; the lead promotes a run note to the team; a person approves a team note for the project
 * through the second brain's inbox. The same types serve the store, the tools, the routes and the Notebook tab.
 */

export const NOTE_KINDS = ['fact', 'decision', 'open_question', 'task_status', 'artifact_ref'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** `run`: this run only (kept 14 days). `team`: every run of the team (30 days after last access, unless verified). `project`: approved by a person, no expiry. */
export const NOTE_SCOPES = ['run', 'team', 'project'] as const;
export type NoteScope = (typeof NOTE_SCOPES)[number];

/** `unverified`: said by a member. `verified`: a person (or the lead, for notes from inside the team) checked it. `disputed`: another note contradicts it. `open`/`answered`: an open question. `expired`: past its time. */
export const NOTE_STATUSES = ['unverified', 'verified', 'disputed', 'open', 'answered', 'expired'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** Where a note came from: ids that point into the Run Trace, and what outside source it read. */
export interface NoteSource {
  executionId?: string;
  spanId?: string;
  /** The name of the workflow step (the team node) that ran the member, when it is known. */
  step?: string;
  /** The tool call that wrote it (`note_add`). */
  tool?: string;
  /** A page or file it was read from: such a note is `tainted`. */
  url?: string;
  /** A short quote from where it came from. Not kept when the run's `traceContent` is `off`. */
  excerpt?: string;
}

export interface TeamNote {
  id: string;
  teamId: string;
  projectId?: string;
  /** The execution that wrote it (the run it belongs to while its scope is `run`). */
  runId?: string;
  workflowId?: string;
  kind: NoteKind;
  text: string;
  scope: NoteScope;
  status: NoteStatus;
  /** The member's title (a person writes as their name). */
  author: string;
  /** The member's id in the team chart, when a member wrote it. */
  authorId?: string;
  source: NoteSource;
  /** Read from outside the team (a web page, a URL): it needs a person's Verify before it goes up a scope. */
  tainted: boolean;
  /** An open question's answer. */
  answer?: string;
  /** A note that replaced this one (the other side of a dispute that was settled). */
  supersededBy?: string;
  /** The note this one disputes. */
  disputes?: string;
  /** The scope it was promoted from. */
  promotedFrom?: NoteScope;
  /** The inbox suggestion waiting to move it to the project. */
  proposalId?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string;
  /** When it goes if nobody uses or verifies it. */
  expiresAt?: string;
  /** Whether it can be found by meaning (an embedding was made). */
  embedded: boolean;
}

/** How many notes of each group, for the tab's headline. */
export interface NoteCounts {
  open: number;
  decisions: number;
  facts: number;
  disputed: number;
  total: number;
}

export interface NoteHit extends TeamNote {
  /** How well it matches the query, 0..1. */
  score: number;
}

/** The notebook tools' names (the model's side) and the plain words the canvases read them as. */
export const NOTEBOOK_TOOLS = ['note_add', 'note_search', 'note_update', 'note_dispute', 'note_promote'] as const;
export type NotebookTool = (typeof NOTEBOOK_TOOLS)[number];

/** Days a run's notes are kept unless promoted, and a team note after its last access unless verified. */
export const RUN_NOTE_DAYS = 14;
export const TEAM_NOTE_DAYS = 30;
/** Days an expired note stays in the table (the tab can show it) before it is deleted. */
export const EXPIRED_GRACE_DAYS = 14;

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  fact: 'Fact',
  decision: 'Decision',
  open_question: 'Open question',
  task_status: 'Task status',
  artifact_ref: 'Artifact',
};
