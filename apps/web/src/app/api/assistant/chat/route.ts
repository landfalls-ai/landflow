/**
 * One chat message to the editor assistant (Spotlight in the editor). The
 * reply streams as SSE: `step.start`, `text.delta`, `thinking`, `text`, `tool` (timed activity),
 * `proposal` (validated changes), then `done`, or `error` (with a checkpoint to `resume` from). `session` marks a
 * request from Spotlight's test-and-fix session.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { refsOf, runChat, tagMentions, type ChatEvent, type ChatState } from '@/lib/server/assistant/chat';
import { takeCheckpoint } from '@/lib/server/assistant/checkpoints';
import { errorText } from '@/lib/server/assistant/model';
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list'; // SB19:
import { roster } from '@/lib/server/assistant/roster';
import { allowedTypes, meteredWorkflowId } from '@/lib/server/assistant/scope';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, parseBody } from '@/lib/server/http'; // SB19: error
import { sseResponse } from '@/lib/server/sse';
import { runDigestSchema, workflowSchema } from '@/lib/server/schemas';
import { withOwnership } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { traceparentHeader } from '@/lib/server/telemetry';
import { splitByScopes } from '@/lib/server/mentions/key-scopes';
import { refusedRead } from '@/lib/server/mentions/resolve';
import { MENTION_TYPES } from '@/lib/shared/mentions';
import { recordUsage } from '@/lib/server/usage/ledger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20_000) }))
    .min(1)
    .max(60)
    .refine((messages) => messages.at(-1)?.role === 'user', 'The last message must be from the user'),
  workflow: workflowSchema,
  selectedNodeId: z.string().optional(),
  runs: z.record(z.string(), runDigestSchema).optional(),
  model: z.string().max(100).optional(),
  /** The saved workflow being edited: proposals then use only the node types its project and its own lists allow. */
  workflowId: z.string().max(200).optional(),
  /**
   * What the user tagged with @: `refs` (a kind, an id, and for a node or a run its workflow; `name` only words a refusal).
   * The older `{ nodes, types }` (node ids on the canvas, node type ids) is still read, as refs, for one release.
   * More than 8 are not an error: the server reads the first 8.
   */
  mentions: z
    .object({
      refs: z.array(z.object({ type: z.enum(MENTION_TYPES), id: z.string().min(1).max(200), workflowId: z.string().max(200).optional(), name: z.string().max(200).optional() })).max(50),
      nodes: z.array(z.string().max(200)).max(20),
      types: z.array(z.string().max(200)).max(20),
    })
    .partial()
    .optional(),
  /** Proposals from earlier replies still waiting for Apply: part of the workflow the model reads, never proposed again. */
  pending: z
    .array(z.object({ summary: z.string().max(300), ops: z.array(z.record(z.string(), z.unknown())).max(80) }))
    .max(20)
    .optional(),
  /** From Spotlight's test-and-fix session: a request for a fix to a failed run, or whether a run did what was asked. */
  session: z.enum(['fix', 'review', 'auto']).optional(),
  /** What Spotlight may do alone in that session: with `auto` it applies the fix itself, else (the default) the person's Apply is waited for. */
  autonomy: z.enum(['auto', 'asks-first']).optional(),
  /** Continue a reply that failed after some steps, from the checkpoint its `error` event gave. */
  resume: z.object({ checkpoint: z.string().max(64) }).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { workflow, workflowId, resume, mentions, ...rest } = parsed.data;
  const picked = await resolveSpotlightModel(rest.model); // SB19: a model this server offers, else the Settings default
  if ('error' in picked) return error(picked.error, 400); // SB19:
  rest.model = picked.model; // SB19:
  const types = allowedTypes(workflowId);
  // The published agents and teams the caller can see: Spotlight runs one that fits a step, or proposes a new agent.
  const { agents, teams } = roster();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());
  const actorId = currentPrincipal()?.user?.id;
  // An unknown, expired or another user's checkpoint answers 409 before the stream starts.
  const resumed = resume ? takeCheckpoint<ChatState>(actorId, resume.checkpoint) : undefined;
  let proposals = 0;
  // What was tagged, read as the caller: a tag to what they may not open reads as "Couldn't read" and reveals nothing.
  // An API key may tag only the kinds its scopes cover (as in /api/mentions and /api/brain/ask); the rest read the same.
  const { allowed, denied } = splitByScopes(refsOf(mentions, workflowId), currentPrincipal()?.apiKey?.scopes);
  const tagged = await tagMentions(routeActor(), allowed, { workflow: workflow as Workflow, ...(workflowId && { workflowId }), types, ...(rest.runs && { runs: rest.runs }) });
  if (denied.length) tagged.reads.push(...denied.map((ref) => refusedRead(ref, ref.name)));

  return sseResponse(
    request,
    async (write, close) => {
      const send = (event: ChatEvent) => {
        if (event.type === 'proposal') proposals++;
        write(event, { event: event.type });
      };
      try {
        await runChat({ ...rest, types, teams, agents, workflow: { ...workflow, id: meteredWorkflowId(workflowId ?? workflow.id) ?? 'draft' } as Workflow, signal: abort.signal, onEvent: send, trace: true, tagged, actor: routeActor(), ...(actorId && { userId: actorId }), ...(resumed && { resume: resumed }) });
      } catch (caught) {
        if (!abort.signal.aborted) send({ type: 'error', kind: 'internal', message: errorText(caught) });
      } finally {
        // What people ask for, and whether a change came of it (the brain's "unmet demand", docs/second-brain.md).
        if (!rest.session || rest.session === 'auto') {
          recordUsage({ kind: 'spotlight.asked', workflowId, actorId, message: rest.messages.at(-1)?.content, attrs: { proposals, turn: rest.messages.length } });
        }
        close();
      }
    },
    { route: '/api/assistant/chat', headers: traceparentHeader() },
  );
});
