/**
 * One chat message to the editor assistant (Spotlight in the editor). The
 * reply streams as SSE: `step.start`, `text.delta`, `thinking`, `text`, `tool` (timed activity),
 * `proposal` (validated changes), then `done`, or `error` (with a checkpoint to `resume` from). `session` marks a
 * request from Spotlight's test-and-fix session.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { runChat, type ChatEvent, type ChatState } from '@/lib/server/assistant/chat';
import { takeCheckpoint } from '@/lib/server/assistant/checkpoints';
import { errorText } from '@/lib/server/assistant/model';
import { roster } from '@/lib/server/assistant/roster';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { handler, parseBody } from '@/lib/server/http';
import { sseResponse } from '@/lib/server/sse';
import { runDigestSchema, workflowSchema } from '@/lib/server/schemas';
import { withOwnership } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { traceparentHeader } from '@/lib/server/telemetry';
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
  /** What the user tagged in the message: node ids on the canvas, node type ids. */
  mentions: z.object({ nodes: z.array(z.string().max(200)).max(20), types: z.array(z.string().max(200)).max(20) }).partial().optional(),
  /** Proposals from earlier replies still waiting for Apply: part of the workflow the model reads, never proposed again. */
  pending: z
    .array(z.object({ summary: z.string().max(300), ops: z.array(z.record(z.string(), z.unknown())).max(80) }))
    .max(20)
    .optional(),
  /** From Spotlight's test-and-fix session: a request for a fix to a failed run, or whether a run did what was asked. */
  session: z.enum(['fix', 'review', 'auto']).optional(),
  /** Continue a reply that failed after some steps, from the checkpoint its `error` event gave. */
  resume: z.object({ checkpoint: z.string().max(64) }).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { workflow, workflowId, resume, ...rest } = parsed.data;
  const types = allowedTypes(workflowId);
  // The published agents and teams the caller can see: Spotlight runs one that fits a step, or proposes a new agent.
  const { agents, teams } = roster();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());
  const actorId = currentPrincipal()?.user?.id;
  // An unknown, expired or another user's checkpoint answers 409 before the stream starts.
  const resumed = resume ? takeCheckpoint<ChatState>(actorId, resume.checkpoint) : undefined;
  let proposals = 0;

  return sseResponse(
    request,
    async (write, close) => {
      const send = (event: ChatEvent) => {
        if (event.type === 'proposal') proposals++;
        write(event, { event: event.type });
      };
      try {
        await runChat({ ...rest, types, teams, agents, workflow: { id: workflowId ?? 'draft', ...workflow } as Workflow, signal: abort.signal, onEvent: send, trace: true, ...(actorId && { userId: actorId }), ...(resumed && { resume: resumed }) });
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
