/**
 * The notebook's tools (docs/team-notebook.md#the-tools): `note_add`, `note_search`, `note_update`, `note_dispute`, and for
 * managers `note_promote`. One definition serves both ways a member reaches them: as built-in tools of a Landflow agent in a
 * team run (`notebookTools`, bound to the team, run and member when the run builds its members), and over MCP for a Claude
 * Code member on kagent (kagent/mcp.ts, bound by ./binding.ts to the call in flight).
 */
import type { JsonObject } from '@landflow/protocol';
import type { BuiltTool, ToolContext } from '../agents/tools';
import { NOTE_KINDS, type NotebookTool, type TeamNote } from '../../shared/notebook';
import { addNote, disputeNote, findNotes, lineOf, promoteNote, updateNote, type CallExtras, type NotebookBinding } from './service';

export interface NotebookToolSpec {
  name: NotebookTool;
  description: string;
  inputSchema: JsonObject;
  /** Only managers get it. */
  manager?: boolean;
}

export const NOTEBOOK_SPECS: NotebookToolSpec[] = [
  {
    name: 'note_add',
    description:
      'Write a short note in the team notebook so the other members, and later runs, can use it: one fact, decision, open question, task status or artifact per note, in a sentence. Check note_search first so you do not repeat one. Only this run sees it until the lead promotes it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...NOTE_KINDS], description: 'fact (something true), decision (something the team settled), open_question (something nobody knows yet), task_status (where a piece of work stands), artifact_ref (a file, branch or link the team made)' },
        text: { type: 'string', description: 'The note, one sentence, under 600 characters' },
        url: { type: 'string', description: 'The page or file the note was read from, when it came from outside the team' },
        quote: { type: 'string', description: 'A short quote from where it came from' },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'note_search',
    description: 'Search the team notebook by meaning: this run\'s notes, the team\'s and the project\'s. Use it before you start and when you wonder whether the team already knows something.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in natural language' },
        kind: { type: 'string', enum: [...NOTE_KINDS], description: 'Only notes of this kind' },
        limit: { type: 'integer', description: 'At most this many notes (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'note_update',
    description: 'Change a note: reword your own, answer an open question (answer), or mark a note verified once you checked it (managers). Use note_dispute for a note you think is wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note\'s id, as note_search shows it' },
        text: { type: 'string', description: 'New wording' },
        answer: { type: 'string', description: 'The answer to an open question' },
        status: { type: 'string', enum: ['verified', 'unverified', 'open'], description: 'verified: you checked it (managers); open: an answered question needs asking again' },
      },
      required: ['id'],
    },
  },
  {
    name: 'note_dispute',
    description: 'Say a note is wrong or out of date: add what is true instead. Both notes stay, linked, until the lead or a person settles which one holds.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note you disagree with' },
        text: { type: 'string', description: 'What is true instead, and how you know' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'note_promote',
    description:
      'Promote a note this run wrote to the team, so every later run finds it (to: team), or suggest it for the project (to: project), which a person approves in their inbox. Notes read from outside the team need a person to verify them first.',
    manager: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note to promote' },
        to: { type: 'string', enum: ['team', 'project'], description: 'team (default), or project (a person approves it)' },
      },
      required: ['id'],
    },
  },
];

/**
 * A member's tools: `note_promote` for managers only, and `note_update` without `verified` for the rest (only a manager
 * verifies; offered it anyway, a model kept calling it and getting the refusal: four failed steps in one live run).
 */
export const specsFor = (manager: boolean) =>
  NOTEBOOK_SPECS.filter((spec) => !spec.manager || manager).map((spec) => (manager || spec.name !== 'note_update' ? spec : memberUpdate(spec)));

function memberUpdate(spec: NotebookToolSpec): NotebookToolSpec {
  const properties = spec.inputSchema.properties as JsonObject;
  return {
    ...spec,
    description: 'Change a note: reword your own, or answer an open question (answer). Only a manager marks a note verified. Use note_dispute for a note you think is wrong.',
    inputSchema: { ...spec.inputSchema, properties: { ...properties, status: { type: 'string', enum: ['unverified', 'open'], description: 'open: an answered question needs asking again' } } },
  };
}

const WEB_TOOL = /web_?fetch|web_?search|fetch|browse|curl|wget|http|url/i;
/** Whether the member read something from outside the team earlier in its session (a web or fetch tool). */
export const sawOutside = (names: Iterable<string>) => [...names].some((name) => WEB_TOOL.test(name.replace(/^mcp__[^_]+__/, '')));

const scopeWords = (note: TeamNote) => (note.scope === 'run' ? 'Only this run sees it until the lead promotes it to the team' : `It is a ${note.scope} note`);

/** Run a notebook tool for a binding. The text is what the model reads; `note` is the note it wrote or changed, for the canvases. */
export async function callNotebookTool(binding: NotebookBinding, name: string, args: Record<string, unknown>, extras: CallExtras = {}): Promise<{ text: string; note?: TeamNote }> {
  switch (name as NotebookTool) {
    case 'note_add': {
      const { note, existing } = await addNote(binding, args, extras);
      if (existing) return { text: `The run's notebook already has this (${note.id}).`, note };
      const taint = note.tainted ? ' It came from outside the team, so a person has to verify it before it can go up.' : '';
      return { text: `Noted (${note.id}) as ${note.kind.replace('_', ' ')}. ${scopeWords(note)}.${taint}`, note };
    }
    case 'note_search': {
      const { hits, via } = await findNotes(binding, args);
      if (!hits.length) return { text: `Nothing in the notebook matches “${String(args.query ?? '').trim()}”.` };
      return { text: `${hits.length} note${hits.length === 1 ? '' : 's'} (matched by ${via}):\n${hits.map(lineOf).join('\n')}` };
    }
    case 'note_update': {
      const note = await updateNote(binding, args);
      return { text: `Updated ${note.id}${note.status === 'answered' ? ' (answered)' : note.status === 'verified' ? ' (verified)' : ''}.`, note };
    }
    case 'note_dispute': {
      const { note, against } = await disputeNote(binding, args, extras);
      return { text: `Disputed ${against.id}. Your note ${note.id} is linked to it; both stay until the lead or a person settles which holds. Do not rely on ${against.id} meanwhile.`, note };
    }
    case 'note_promote': {
      const { note, to, proposalId } = promoteNote(binding, args);
      return {
        text: to === 'project' ? `Suggested ${note.id} for the project: the suggestion (${proposalId}) is in the person's inbox, and the note is a team note until they decide.` : `Promoted ${note.id} to the team: every later run finds it.`,
        note,
      };
    }
    default:
      throw new Error(`The notebook has no tool ${name}`);
  }
}

/** The tools of one member in one run, as built-in tools of its agent loop. */
export function notebookTools(binding: NotebookBinding): BuiltTool[] {
  return specsFor(binding.manager).map((spec) => ({
    kind: 'notebook' as const,
    name: spec.name,
    label: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    requireApproval: false,
    async invoke(input: Record<string, unknown>, ctx: ToolContext) {
      const names = ctx.session.timeline.flatMap((entry) => (entry.type === 'tool' ? [entry.tool] : []));
      const { text } = await callNotebookTool(binding, spec.name, input, { ...(ctx.callSpan && { spanId: ctx.callSpan }), sawOutside: sawOutside(names) });
      return { output: text };
    },
  }));
}

/**
 * The tools of a Claude Code member on kagent, by name only: kagent's Agent lists them, and the MCP endpoint answers each
 * call by binding it to the run in flight (kagent/mcp.ts, ./binding.ts). They take a `run` argument to name the run when
 * two ask the agent at once.
 */
export function notebookStubs(): BuiltTool[] {
  return specsFor(false).map((spec) => ({
    kind: 'notebook' as const,
    name: spec.name,
    label: spec.name,
    description: spec.description,
    inputSchema: { ...spec.inputSchema, properties: { ...(spec.inputSchema.properties as JsonObject), run: { type: 'string', description: 'The notebook run key from your request. Only needed when a note tool says several runs are asking you at once' } } },
    requireApproval: false,
    async invoke() {
      throw new Error('The notebook tools are bound by the MCP endpoint of a team run');
    },
  }));
}
