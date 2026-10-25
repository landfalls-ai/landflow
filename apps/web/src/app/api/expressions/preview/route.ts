import { z } from 'zod';
import { ExpressionResolver } from '@landflow/engine';
import { handler, json, parseBody } from '@/lib/server/http';
import { variables } from '@/lib/server/variables';

export const dynamic = 'force-dynamic';

const Items = z.array(z.object({ json: z.record(z.string(), z.unknown()) }).passthrough()).max(200);
const Body = z.object({
  value: z.string().max(10_000),
  items: Items.default([]),
  itemIndex: z.number().int().min(0).default(0),
  nodeOutputs: z.record(z.string(), Items).default({}),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

/** POST { value, items, nodeOutputs } → what `value` resolves to for one input item, as the parameter editor previews it. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { value, items, itemIndex, nodeOutputs, parameters } = parsed.data;
  const resolver = new ExpressionResolver({
    items: items as never,
    nodeOutputs: nodeOutputs as never,
    workflow: { id: 'preview', name: 'preview' },
    execution: { id: 'preview', mode: 'manual' },
    parameters,
    variables: variables.record(),
  });
  try {
    return json({ ok: true, value: resolver.resolveValue(value, itemIndex) ?? null });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
