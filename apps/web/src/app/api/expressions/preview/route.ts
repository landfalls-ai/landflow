import { z } from 'zod';
import { collectSecretReferences, ExpressionResolver, type SecretValues } from '@landflow/engine';
import { handler, json, parseBody } from '@/lib/server/http';
import { externalSecrets, PARAMETERS_NOT_ALLOWED, secretsAllowedInParameters } from '@/lib/server/secrets';
import { variables } from '@/lib/server/variables';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { canResource } from '@/lib/server/projects/access';

export const dynamic = 'force-dynamic';

const Items = z.array(z.object({ json: z.record(z.string(), z.unknown()) }).passthrough()).max(200);
const Body = z.object({
  value: z.string().max(10_000),
  items: Items.default([]),
  itemIndex: z.number().int().min(0).default(0),
  nodeOutputs: z.record(z.string(), Items).default({}),
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** The workflow being edited: `$vars` reads its project's variables first. */
  workflowId: z.string().max(200).optional(),
});

/** What a secret shows as in a preview: values are read at run time only and never shown. */
const SECRET_PREVIEW = '[secret]';

/**
 * `$secrets` in a preview, when node parameters may read them: every referenced secret (or its key) reads as
 * “[secret]”; an unknown provider or a name it doesn't list says so. Undefined when the value reads none.
 */
function maskedSecrets(value: string): SecretValues | { error: string } | undefined {
  const references = collectSecretReferences(value);
  if (!references.length) return undefined;
  if (!secretsAllowedInParameters()) return { error: PARAMETERS_NOT_ALLOWED };
  const names = externalSecrets.names();
  const masked: SecretValues = {};
  for (const { provider, name, key } of references) {
    if (!names[provider]) return { error: `No external secrets provider “${provider}” is set up and turned on (Settings → External secrets)` };
    if (names[provider].length && !names[provider].includes(name)) return { error: `“${provider}” doesn’t list a secret “${name}” (refresh it in Settings → External secrets)` };
    const secrets = (masked[provider] ??= {});
    const current = secrets[name];
    secrets[name] = key === undefined ? (typeof current === 'object' ? current : SECRET_PREVIEW) : { ...(typeof current === 'object' ? current : {}), [key]: SECRET_PREVIEW };
  }
  return masked;
}

/** POST { value, items, nodeOutputs } → what `value` resolves to for one input item, as the parameter editor previews it. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { value, items, itemIndex, nodeOutputs, parameters, workflowId } = parsed.data;
  const secrets = maskedSecrets(value);
  if (secrets && 'error' in secrets && typeof secrets.error === 'string') return json({ ok: false, error: secrets.error });
  const resolver = new ExpressionResolver({
    items: items as never,
    nodeOutputs: nodeOutputs as never,
    workflow: { id: 'preview', name: 'preview' },
    execution: { id: 'preview', mode: 'manual' },
    parameters,
    // A workflow the caller can't see doesn't lend its project's variables.
    variables: variables.forWorkflow(workflowId && canResource(currentPrincipal()?.user, 'workflow', workflowId, 'read') ? workflowId : undefined),
    ...(secrets && { secrets: secrets as SecretValues }),
  });
  try {
    return json({ ok: true, value: resolver.resolveValue(value, itemIndex) ?? null });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
