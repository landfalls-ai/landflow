/**
 * One chat message to the Agent architect (docs/agents.md#agent-architect). The reply streams as SSE, one event per
 * step: `text`, `tool` (activity), `draft` (a whole agent to review), then `done`, or `error`. The architect proposes
 * agents; creating one is POST /api/agents/import with the draft.
 */
import { z } from 'zod';
import { agentResources } from '@/lib/server/assistant/agent-resources';
import type { AgentConfig } from '@/lib/shared/agents';
import type { ArchitectEvent } from '@/lib/shared/agent-architect';
import { runArchitect } from '@/lib/server/assistant/architect';
import { errorText } from '@/lib/server/assistant/model';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { handler, parseBody } from '@/lib/server/http';
import { sseResponse } from '@/lib/server/sse';
import { routeActor } from '@/lib/server/projects/http';
import { traceparentHeader } from '@/lib/server/telemetry';
import { recordUsage } from '@/lib/server/usage/ledger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(20_000),
      }),
    )
    .min(1)
    .max(60)
    .refine((messages) => messages.at(-1)?.role === 'user', 'The last message must be from the user'),
  draft: z.record(z.string(), z.unknown()).optional(),
  model: z.string().max(100).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { messages, model } = parsed.data;
  const draft = parsed.data.draft as Partial<AgentConfig> | undefined;
  const actor = routeActor();
  const types = allowedTypes(undefined, actor);
  // The models and knowledge bases the draft can use: a local model by default (docs/agents.md#agent-architect).
  const resources = await agentResources(actor);
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());
  const actorId = currentPrincipal()?.user?.id;
  let drafts = 0;

  return sseResponse(
    request,
    async (write, close) => {
      const send = (event: ArchitectEvent) => {
        if (event.type === 'draft') drafts++;
        write(event, { event: event.type });
      };
      try {
        await runArchitect({
          messages,
          ...(draft && { draft }),
          ...(model && { model }),
          types,
          actor,
          resources,
          signal: abort.signal,
          onEvent: send,
        });
      } catch (caught) {
        if (!abort.signal.aborted) send({ type: 'error', message: errorText(caught) });
      } finally {
        // What people ask agents for, and whether a draft came of it (`proposals`, as Spotlight's: the brain's "unmet demand").
        recordUsage({
          kind: 'spotlight.asked',
          actorId,
          message: messages.at(-1)?.content,
          attrs: { architect: true, proposals: drafts, turn: messages.length },
        });
        close();
      }
    },
    { headers: traceparentHeader() },
  );
});
