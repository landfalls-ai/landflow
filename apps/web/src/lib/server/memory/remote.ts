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
import { credentialUsableBy } from '../projects/access';
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

const when = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);

/** What a provider's item may carry (its answer is untrusted: the id and kind reach a model, so they are shaped here, not trusted). */
const ID = /^[\w:./#@-]{1,200}$/;
const KIND = /^[\w-]{1,40}$/;
const MAX_TEXT = 2_000;
/** A profile half: the built-in profile reads 50 static facts, so a provider gets no more. */
const PROFILE_HALF = 50;

function toItem(raw: unknown, at: string): MemoryItem {
  const wire = (raw && typeof raw === 'object' ? raw : {}) as Partial<MemoryItemWire>;
  if (typeof wire.id !== 'string' || typeof wire.text !== 'string') throw new MemoryProviderError('the memory provider answered an item without an id and text');
  if (!ID.test(wire.id)) throw new MemoryProviderError('the memory provider answered an item whose id is not a plain id (letters, digits and : . / # @ _ -, up to 200)');
  const kind = wire.kind ?? 'memory'; // null (Python None, a Go field without omitempty) is absent
  if (typeof kind !== 'string' || !KIND.test(kind)) throw new MemoryProviderError('the memory provider answered an item whose kind is not a plain word (up to 40 characters)');
  if (wire.version != null && !(Number.isInteger(wire.version) && (wire.version as number) >= 1)) throw new MemoryProviderError('the memory provider answered an item whose version is not a whole number');
  const score = typeof wire.score === 'number' && Number.isFinite(wire.score) ? Math.max(0, Math.min(1, wire.score)) : undefined;
  return {
    id: wire.id,
    text: wire.text.length > MAX_TEXT ? `${wire.text.slice(0, MAX_TEXT - 1)}…` : wire.text,
    kind,
    source: 'provider',
    ...(score !== undefined && { score }),
    ...(wire.version != null && { version: wire.version }),
    ...(wire.static === true && { static: true }),
    createdAt: when(wire.createdAt, at),
    updatedAt: when(wire.updatedAt, when(wire.createdAt, at)),
  };
}

/** The items of an answer, at most `cap` of them (a provider that sends more is cut, not trusted). */
const items = (value: unknown, at: string, cap: number): MemoryItem[] => (Array.isArray(value) ? value.slice(0, cap).map((raw) => toItem(raw, at)) : []);

/** Make the backend of a project's chosen provider. */
export function providerBackend(setting: Extract<ProjectMemory, { backend: 'provider' }>, projectId: string): MemoryBackend {
  async function call(request: MemoryRequestWire, caller: MemoryCaller): Promise<JsonObject> {
    const resolved = registry.resolve(setting.nodeType);
    if ('error' in resolved) throw new MemoryProviderError(`the memory provider “${setting.nodeType}” is not installed`);
    const descriptor: NodeDescriptor = resolved.descriptor;
    const problem = descriptor.memoryProvider ? checkMemoryProvider(descriptor) : `node “${descriptor.displayName}” is no longer a memory provider`;
    if (problem) throw new MemoryProviderError(problem);
    // The credential was checked when the project saved it; it may have moved or been unshared since (docs/projects-and-goals.md).
    if (setting.credentialId && !credentialUsableBy(setting.credentialId, projectId)) throw new MemoryProviderError('the memory provider’s credential is no longer usable by this project');
    const parameters = { operation: request.operation } as JsonObject;
    // The credential the project chose goes to every credential the node declares (a provider names one); resolved right before the call.
    const refs = setting.credentialId ? Object.fromEntries((descriptor.credentials ?? []).map((c) => [c.name, { id: setting.credentialId!, name: setting.credentialId! }])) : undefined;
    let creds: Record<string, JsonObject>;
    try {
      creds = { ...credentials.resolveFor({ type: setting.nodeType, credentials: refs, parameters }, descriptor) };
    } catch (error) {
      throw new MemoryProviderError(`the memory provider’s credential could not be read: ${(error as Error).message}`);
    }
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
      const found = items(required(out, 'search', 'items'), now(), limit);
      // The provider is asked for the threshold; an item it scored under it anyway is dropped here and counted.
      const under = found.filter((i) => i.score !== undefined && i.score < threshold);
      return { items: found.filter((i) => !under.includes(i)).slice(0, limit), via: 'meaning', dropped: { count: under.length, ...(under.length && { best: Math.max(...under.map((i) => i.score!)) }) } };
    },
    async profile(c, caller): Promise<MemoryProfile> {
      const out = await call({ operation: 'profile', container: containerKey(c) }, caller);
      return { static: items(required(out, 'profile', 'static'), now(), PROFILE_HALF), recent: items(required(out, 'profile', 'recent'), now(), PROFILE_HALF) };
    },
    async add(c, input: MemoryAddInput, caller): Promise<MemoryItem> {
      const out = await call(
        { operation: 'add', container: containerKey(c), text: input.text, ...(input.kind && { kind: input.kind }), ...(input.static && { static: true }), ...(input.forgetAfter && { forgetAfter: input.forgetAfter }), ...(input.replaces && { replaces: input.replaces }) },
        caller,
      );
      return toItem(required(out, 'add', 'item'), now());
    },
    async forget(c: MemoryContainer, id, reason, caller): Promise<MemoryItem> {
      // The container goes too: a provider serving two projects refuses an id that is not in this one.
      const out = await call({ operation: 'forget', container: containerKey(c), id, reason }, caller);
      return toItem(required(out, 'forget', 'item'), now());
    },
    async list(c, page, caller): Promise<MemoryPage> {
      const limit = Math.max(MEMORY_LIMITS.list.min, Math.min(MEMORY_LIMITS.list.max, page.limit ?? MEMORY_LIMITS.list.default));
      const out = await call({ operation: 'list', container: containerKey(c), ...(page.cursor && { cursor: page.cursor }), limit }, caller);
      return { items: items(required(out, 'list', 'items'), now(), limit), ...(typeof out.nextCursor === 'string' && out.nextCursor && { nextCursor: out.nextCursor }) };
    },
  };
}
