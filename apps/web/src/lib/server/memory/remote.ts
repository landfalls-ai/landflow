/**
 * The remote memory backend (C07 FR-7, FR-8): a project can choose a plugin node that flags `memoryProvider` as its memory.
 * The host calls it like any node (`registry.resolve(type).execute`, mode `manual`, one input item holding the request) and
 * reads the first output item. An error, a timeout or an answer that is not the contract fails the call with the provider's
 * own message; nothing falls back to the built-in store, so a project never silently reads another memory than it chose.
 * Its own HTTP goes through `ctx.http` on the plugin side; the host reaches it over the registry's transports.
 */
import { checkMemoryProvider, defaultVersionOf, PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type MemoryItemWire, type MemoryOperation, type MemoryRequestWire, type NodeDescriptor } from '@landflow/protocol';
import { containerKey, MEMORY_LIMITS, type MemoryAddInput, type MemoryContainer, type MemoryItem, type MemoryPage, type MemoryProfile, type MemorySearchResult } from '../../shared/memory';
import type { ProjectMemory } from '../../shared/project-policy';
import { credentials } from '../credentials/vault';
import { getProjectSettings } from '../governance/scopes';
import { registry } from '../plugins/registry';
import { MemoryProviderError, type MemoryBackend, type MemoryCaller } from './backend';

/** How long a provider may take (FR-8). */
const PROVIDER_TIMEOUT_MS = 10_000;
let timeoutOverride: number | undefined;
/** For tests: a shorter wait, so a hung provider does not hold a suite for ten seconds. `undefined` restores 10 s. */
export const setProviderTimeoutMs = (ms: number | undefined) => {
  timeoutOverride = ms;
};

/** The provider a project chose, if any. */
export function providerSetting(projectId: string): Extract<ProjectMemory, { backend: 'provider' }> | undefined {
  const memory = getProjectSettings(projectId).memory;
  return memory?.backend === 'provider' ? memory : undefined;
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const when = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);

function toItem(raw: unknown, at: string): MemoryItem {
  const wire = (raw && typeof raw === 'object' ? raw : {}) as Partial<MemoryItemWire>;
  if (typeof wire.id !== 'string' || typeof wire.text !== 'string') throw new MemoryProviderError('the memory provider answered an item without an id and text');
  const score = typeof wire.score === 'number' && Number.isFinite(wire.score) ? Math.max(0, Math.min(1, wire.score)) : undefined;
  return {
    id: wire.id,
    text: wire.text,
    kind: text(wire.kind, 'memory'),
    source: 'provider',
    ...(score !== undefined && { score }),
    ...(typeof wire.version === 'number' && { version: wire.version }),
    ...(wire.static === true && { static: true }),
    createdAt: when(wire.createdAt, at),
    updatedAt: when(wire.updatedAt, when(wire.createdAt, at)),
  };
}

const items = (value: unknown, at: string): MemoryItem[] => (Array.isArray(value) ? value.map((raw) => toItem(raw, at)) : []);

/** Make the backend of a project's chosen provider. */
export function providerBackend(setting: Extract<ProjectMemory, { backend: 'provider' }>): MemoryBackend {
  async function call(request: MemoryRequestWire, caller: MemoryCaller): Promise<JsonObject> {
    const resolved = registry.resolve(setting.nodeType);
    if ('error' in resolved) throw new MemoryProviderError(`the memory provider “${setting.nodeType}” is not installed`);
    const descriptor: NodeDescriptor = resolved.descriptor;
    const problem = descriptor.memoryProvider ? checkMemoryProvider(descriptor) : `node “${descriptor.displayName}” is no longer a memory provider`;
    if (problem) throw new MemoryProviderError(problem);
    const parameters = { operation: request.operation } as JsonObject;
    // The credential the project chose goes to every credential the node declares (a provider names one); resolved right before the call.
    const refs = setting.credentialId ? Object.fromEntries((descriptor.credentials ?? []).map((c) => [c.name, { id: setting.credentialId!, name: setting.credentialId! }])) : undefined;
    const creds = { ...credentials.resolveFor({ type: setting.nodeType, credentials: refs, parameters }, descriptor) };
    const executionId = caller.run?.executionId ?? `memory_${request.operation}`;
    const payload = { protocol: PROTOCOL_VERSION } as const;
    const execute: ExecuteRequest = {
      ...payload,
      executionId,
      workflowId: caller.run?.agentId ? `agent:${caller.run.agentId}` : 'memory',
      mode: 'manual',
      node: { id: 'memory', name: descriptor.displayName, type: setting.nodeType, typeVersion: defaultVersionOf(descriptor) },
      parameters,
      itemParameters: [parameters],
      inputs: [[{ json: request as unknown as JsonObject }]],
      ...(Object.keys(creds).length > 0 && { credentials: creds }),
    };
    let response;
    try {
      response = await resolved.execute(execute, { signal: AbortSignal.timeout(timeoutOverride ?? PROVIDER_TIMEOUT_MS) });
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      throw new MemoryProviderError(timedOut ? `the memory provider did not answer in ${(timeoutOverride ?? PROVIDER_TIMEOUT_MS) / 1000} s` : `the memory provider failed: ${(error as Error).message}`);
    }
    if (response.error) throw new MemoryProviderError(`the memory provider failed: ${[response.error.message, response.error.description].filter(Boolean).join(' - ')}`);
    const first = response.outputs[0]?.[0]?.json;
    if (!first || typeof first !== 'object') throw new MemoryProviderError('the memory provider answered nothing');
    return first as JsonObject;
  }

  const required = (output: JsonObject, op: MemoryOperation, key: string) => {
    if (!(key in output)) throw new MemoryProviderError(`the memory provider’s ${op} answer lacks “${key}”`);
    return output[key];
  };
  const now = () => new Date().toISOString();

  return {
    name: 'provider',
    async search(c, query, options, caller): Promise<MemorySearchResult> {
      const limit = Math.max(MEMORY_LIMITS.search.min, Math.min(MEMORY_LIMITS.search.max, options.limit ?? MEMORY_LIMITS.search.default));
      const out = await call({ operation: 'search', container: containerKey(c), query, mode: options.mode ?? 'hybrid', limit, threshold: options.threshold ?? 0 }, caller);
      const threshold = options.threshold ?? 0;
      const found = items(required(out, 'search', 'items'), now());
      // The provider is asked for the threshold; an item it scored under it anyway is dropped here and counted.
      const under = found.filter((i) => i.score !== undefined && i.score < threshold);
      return { items: found.filter((i) => !under.includes(i)).slice(0, limit), via: 'meaning', dropped: { count: under.length, ...(under.length && { best: Math.max(...under.map((i) => i.score!)) }) } };
    },
    async profile(c, caller): Promise<MemoryProfile> {
      const out = await call({ operation: 'profile', container: containerKey(c) }, caller);
      return { static: items(required(out, 'profile', 'static'), now()), recent: items(required(out, 'profile', 'recent'), now()) };
    },
    async add(c, input: MemoryAddInput, caller): Promise<MemoryItem> {
      const out = await call(
        { operation: 'add', container: containerKey(c), text: input.text, ...(input.kind && { kind: input.kind }), ...(input.static && { static: true }), ...(input.forgetAfter && { forgetAfter: input.forgetAfter }), ...(input.replaces && { replaces: input.replaces }) },
        caller,
      );
      return toItem(required(out, 'add', 'item'), now());
    },
    async forget(_c: MemoryContainer, id, reason, caller): Promise<MemoryItem> {
      const out = await call({ operation: 'forget', id, reason }, caller);
      return toItem(required(out, 'forget', 'item'), now());
    },
    async list(c, page, caller): Promise<MemoryPage> {
      const limit = Math.max(MEMORY_LIMITS.list.min, Math.min(MEMORY_LIMITS.list.max, page.limit ?? MEMORY_LIMITS.list.default));
      const out = await call({ operation: 'list', container: containerKey(c), ...(page.cursor && { cursor: page.cursor }), limit }, caller);
      return { items: items(required(out, 'list', 'items'), now()), ...(typeof out.nextCursor === 'string' && out.nextCursor && { nextCursor: out.nextCursor }) };
    },
  };
}
