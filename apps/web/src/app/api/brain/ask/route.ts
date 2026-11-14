/**
 * POST /api/brain/ask `{ question, about?, history?, mentions? }` — ask the second brain (docs/second-brain.md#the-brain-page). It finds the
 * pages, facts and work the question is about, among what the caller can open, and the brain's model answers from them
 * with `[[type/id]]` page links and `[n]` work references (only numbers that point at a work item). `about` (`<type>/<id>`)
 * asks from a page (it counts as one `brainPage` tag); `history` is the last two turns, for a follow-up; `mentions.refs`
 * (at most 8) are what the person tagged with @ (docs/assistant.md#tagging-with-): each is checked against what the
 * caller may open, read into the prompt and told as a step, and one that is missing or not theirs says only "Couldn't read". Without a model the answer is left out and what was
 * found comes back. With `Accept: text/event-stream` the answer streams: `found`, steps, `text.delta`, `text`, `done`
 * (or `error`); otherwise it is one JSON body.
 */
import { z } from 'zod';
import { projectsOf, scopeForActor } from '@/lib/server/brain/scope';
import { vectorFactHits } from '@/lib/server/brain/study';
import { askBrainStream, askJson, askMentionsSplit } from '@/lib/server/brain/ask-stream';
import { askBrain } from '@/lib/server/brain/wiki';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { splitByScopes } from '@/lib/server/mentions/key-scopes';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { sseResponse } from '@/lib/server/sse';
import { ASK_HISTORY_CHARS } from '@/lib/shared/brain-wiki';
import { MENTION_LIMITS, MENTION_TYPES } from '@/lib/shared/mentions';

export const dynamic = 'force-dynamic';

const turn = z.object({ question: z.string().max(ASK_HISTORY_CHARS), answer: z.string().max(ASK_HISTORY_CHARS) });
const ref = z.object({ type: z.enum(MENTION_TYPES), id: z.string().min(1).max(200), workflowId: z.string().max(200).optional(), name: z.string().max(200).optional() });
const Body = z.object({
  question: z.string().trim().min(1).max(500),
  about: z.string().max(140).optional(),
  history: z.array(turn).max(2).optional(),
  mentions: z.object({ refs: z.array(ref).max(MENTION_LIMITS.refs) }).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const scope = scopeForActor(actor);
  const { question, about, history, mentions } = parsed.data;
  const vectorHits = await vectorFactHits(question, projectsOf(scope));
  const { kept, cut } = askMentionsSplit(mentions?.refs, about);
  // An API key may tag only what its scopes cover reading elsewhere; the rest is refused like a tag that is not theirs.
  const { allowed, denied } = splitByScopes(kept, currentPrincipal()?.apiKey?.scopes);
  const name = (r: { id: string; name?: string }) => (r.name ?? r.id).replace(/\s+/g, ' ').slice(0, 60);
  const refusals = [...denied.map((r) => `Couldn't read @${name(r)}`), ...cut.map((r) => `Left out @${name(r)}: too many tags`)];
  const base = { vectorHits, ...(about && { about }), ...(history && { history }), signal: request.signal };
  const options = { ...base, ...(allowed.length && { mentions: allowed }), ...(refusals.length && { refusals }) };
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return sseResponse(
      request,
      async (write, close) => {
        try {
          await askBrainStream(actor, { question, scope, ...options }, (event) => void write(event, { event: event.type }));
        } finally {
          close();
        }
      },
      { route: '/api/brain/ask' },
    );
  }
  // The JSON form with tags: the same answer as the stream, folded (askBrain does not take tags).
  if (mentions?.refs.length) return json(await askJson(actor, { question, scope, ...options }));
  return json(await askBrain(question, scope, actor, base));
});
