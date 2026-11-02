/**
 * One note of a team's notebook (docs/team-notebook.md#the-routes).
 *
 * POST   /api/agent-teams/:id/notes/:noteId { action, ... } — what a person does with a note:
 *   `verify` (it stands, a team note stops expiring), `answer` { text } (an open question), `reopen`, `dispute` { text } (add a
 *   note that disagrees; both stay), `resolve` { keep } (settle a dispute: `keep` is the id of the note that holds),
 *   `promote` { to? } (run to team now; team to project as a suggestion in the inbox: `{ note, to, proposalId? }`),
 *   `edit` { text }.
 * DELETE /api/agent-teams/:id/notes/:noteId — forget the note.
 */
import { z } from 'zod';
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { personOf } from '@/lib/server/notebook/http';
import { answer, NoteError, personDispute, promote, remove, reopen, resolveDispute, verify } from '@/lib/server/notebook/service';
import { noteStore } from '@/lib/server/notebook/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; noteId: string }> };

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('verify') }),
  z.object({ action: z.literal('answer'), text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('reopen') }),
  z.object({ action: z.literal('dispute'), text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('resolve'), keep: z.string().min(1) }),
  z.object({ action: z.literal('promote'), to: z.enum(['team', 'project']).optional() }),
  z.object({ action: z.literal('edit'), text: z.string().min(1).max(2000) }),
]);

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, noteId } = await params;
  if (!agentTeamStore.get(id)) return error('Agent team not found', 404);
  const body = await parseBody(request, actionSchema);
  if (!body.ok) return body.response;
  const by = personOf();
  try {
    const a = body.data;
    switch (a.action) {
      case 'verify':
        return json({ note: verify(id, noteId, by) });
      case 'answer':
        return json({ note: answer(id, noteId, a.text) });
      case 'reopen':
        return json({ note: reopen(id, noteId) });
      case 'dispute':
        return json(await personDispute(id, noteId, by, a.text), 201);
      case 'resolve':
        return json(resolveDispute(id, noteId, a.keep, by));
      case 'promote': {
        const note = noteStore.get(noteId);
        if (!note || note.teamId !== id) return error('Note not found', 404);
        return json(promote(note, a.to ?? (note.scope === 'run' ? 'team' : 'project'), by));
      }
      case 'edit': {
        const note = noteStore.get(noteId);
        if (!note || note.teamId !== id) return error('Note not found', 404);
        return json({ note: noteStore.patch(noteId, { text: a.text.replace(/\s+/g, ' ').trim().slice(0, 600), embedding: null, embedding_model: null }) });
      }
    }
  } catch (caught) {
    if (caught instanceof NoteError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id, noteId } = await params;
  if (!agentTeamStore.get(id)) return error('Agent team not found', 404);
  try {
    remove(id, noteId);
    return json({ ok: true });
  } catch (caught) {
    if (caught instanceof NoteError) return error(caught.message, caught.status);
    throw caught;
  }
});
