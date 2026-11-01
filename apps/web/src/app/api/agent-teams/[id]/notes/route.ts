/**
 * The team notebook (docs/team-notebook.md#the-routes).
 *
 * GET  /api/agent-teams/:id/notes?scope=&kind=&status=&q=&run=&expired=1 — `{ notes, counts }`: the team's notes of every run
 *   (and its project's), newest first. `q` searches them by meaning (words when the embedding model is down) and adds `via`
 *   and each note's `score`. `run` limits to one execution's notes.
 * POST /api/agent-teams/:id/notes { kind?, text } — a person writes a note; it stands as verified, in the team's scope.
 */
import { z } from 'zod';
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { personOf } from '@/lib/server/notebook/http';
import { searchNotes } from '@/lib/server/notebook/search';
import { NoteError, personAdd, projectOf } from '@/lib/server/notebook/service';
import { noteStore } from '@/lib/server/notebook/store';
import { NOTE_KINDS, NOTE_SCOPES, NOTE_STATUSES, type NoteKind, type NoteScope, type NoteStatus, type TeamNote } from '@/lib/shared/notebook';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentTeamStore.get(id)) return error('Agent team not found', 404);
  const url = new URL(request.url);
  const pick = <T extends string>(all: readonly T[], name: string): T[] | undefined => {
    const wanted = url.searchParams.get(name);
    return wanted && (all as readonly string[]).includes(wanted) ? [wanted as T] : undefined;
  };
  const projectId = projectOf(id);
  const scopes = pick<NoteScope>(NOTE_SCOPES, 'scope');
  const kinds = pick<NoteKind>(NOTE_KINDS, 'kind');
  const statuses = pick<NoteStatus>(NOTE_STATUSES, 'status');
  const filter = {
    teamId: id,
    ...(projectId && { projectId }),
    allRuns: true,
    expired: url.searchParams.get('expired') === '1',
    ...(scopes && { scopes }),
    ...(kinds && { kinds }),
    ...(statuses && { statuses }),
  };
  const run = url.searchParams.get('run') || undefined;
  const q = url.searchParams.get('q')?.trim();
  let notes: Array<TeamNote & { score?: number }>;
  let via: 'meaning' | 'keywords' | undefined;
  if (q) {
    const found = await searchNotes(q, filter, 50);
    notes = found.hits;
    via = found.via;
  } else {
    notes = noteStore.list(run ? { ...filter, onlyRun: run } : filter);
  }
  return json({ notes, counts: noteStore.counts(id, projectId), ...(via && { via }) });
});

const addSchema = z.object({ kind: z.enum(NOTE_KINDS).optional(), text: z.string().min(1).max(2000) });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentTeamStore.get(id)) return error('Agent team not found', 404);
  const body = await parseBody(request, addSchema);
  if (!body.ok) return body.response;
  try {
    return json({ note: await personAdd(id, personOf(), body.data) }, 201);
  } catch (caught) {
    if (caught instanceof NoteError) return error(caught.message, caught.status);
    throw caught;
  }
});
