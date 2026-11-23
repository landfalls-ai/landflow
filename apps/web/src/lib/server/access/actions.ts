/**
 * Calling an access system (docs/access-requests.md#grants): add, remove or check a member through the system's plugin node
 * with the catalog entry's credential. The host calls the node itself (as an agent's node tool does, agents/tools.ts), so
 * a flow node doesn't have to hold a credential per entry and a person never types one into a request.
 *
 * The call runs in mode `trigger`, never `tool`: the GitHub node refuses every write in `tool` and `mcp` mode, so a model
 * can never grant access, and this host-side call is what a person's approval ends in. A credential no longer usable by the
 * access project (unshared, moved, deleted) is refused before any call. The plugin's message is passed on with every
 * credential value scrubbed out of it.
 *
 * Plain server module (no Next.js import).
 */
import { nanoid } from 'nanoid';
import { defaultVersionOf, PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/protocol';
import type { AccessSystem } from '../../shared/access';
import { credentials } from '../credentials/vault';
import { registry } from '../plugins/registry';
import { credentialUsableBy } from '../projects/access';
import { logger } from '../telemetry/logger';
import { AccessActionError, AccessError } from './errors';
import { accessSettings } from './store';
import { callOf, resultOf, SYSTEMS, type ActionResult, type Operation } from './systems';

/** What an action needs of a grant or an entry: where it points, who it is for, which credential. */
export interface ActionTarget {
  system: AccessSystem;
  config: Record<string, string>;
  credentialId?: string | null;
  /** The person's account in the system (GitHub login, Google email). */
  account: string;
}

/** Every string value of a credential's data, so a plugin message that echoes one can be scrubbed. */
function secretsOf(data: Record<string, JsonObject>): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.length >= 6) found.push(value);
    } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(data);
  return found;
}

const scrub = (text: string, secrets: string[]) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);

export async function runAction(target: ActionTarget, op: Operation): Promise<ActionResult> {
  const spec = SYSTEMS[target.system];
  if (!spec.nodeType) throw new AccessError('A manual entry has no automatic action', 400);
  if (!target.credentialId) throw new AccessActionError('This entry has no credential, so Landflow cannot reach the system');
  if (!credentialUsableBy(target.credentialId, accessSettings().projectId)) {
    throw new AccessActionError('The entry’s credential can no longer be used by the access requests project: share it with that project or pick another');
  }
  const { nodeType, parameters: base } = callOf(target.system, op, target.config, target.account);
  const resolved = registry.resolve(nodeType);
  if ('error' in resolved) throw new AccessActionError(`The ${spec.label} plugin is not available: ${resolved.error}`);
  const { descriptor } = resolved;
  const stored = credentials.get(target.credentialId);
  if (!stored) throw new AccessActionError('The entry’s credential was deleted');
  // Google has two credential types behind one `authentication` parameter.
  const parameters: Record<string, unknown> = { ...base, ...(target.system === 'google-group' && { authentication: stored.type === 'google.googleOAuth2Api' ? 'oAuth2' : 'serviceAccount' }) };
  let creds: Record<string, JsonObject>;
  try {
    creds = credentials.resolveFor({ type: nodeType, credentials: Object.fromEntries((descriptor.credentials ?? []).map((requirement) => [requirement.name, { id: stored.id, name: stored.name }])), parameters }, descriptor);
  } catch (error) {
    throw new AccessActionError((error as Error).message);
  }
  const secrets = secretsOf(creds);
  const items: NodeItem[] = [{ json: {} }];
  const request: ExecuteRequest = {
    protocol: PROTOCOL_VERSION,
    executionId: `access-${nanoid(10)}`,
    workflowId: 'access-requests',
    mode: 'trigger',
    node: { id: 'access', name: 'Access', type: nodeType, typeVersion: defaultVersionOf(descriptor) },
    parameters: parameters as JsonObject,
    itemParameters: [parameters as JsonObject],
    inputs: [items],
    credentials: creds,
  };
  let response;
  try {
    response = await resolved.execute(request, {});
  } catch (error) {
    logger.warn('an access action failed', { 'landflow.access.system': target.system, error: scrub((error as Error).message, secrets) });
    throw new AccessActionError(scrub((error as Error).message, secrets));
  }
  if (response.error) throw new AccessActionError(scrub([response.error.message, response.error.description].filter(Boolean).join(': '), secrets));
  const output = (response.outputs[0]?.[0]?.json ?? {}) as Record<string, unknown>;
  return resultOf(target.system, op, output);
}
