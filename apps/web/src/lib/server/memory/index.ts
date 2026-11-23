/**
 * The memory façade (docs/second-brain.md#memory-backend, C07): every caller (the four Memory nodes, the MCP tools, an
 * agent's recall, the playground) goes through `memory.<operation>`, which checks access to the container, picks the
 * backend (the project's provider, else the built-in one) and records a span with the backend, the container kind and
 * counts, never the text (FR-10).
 */
import type { Span } from '@opentelemetry/api';
import { wrapMemory } from '../../shared/memory-fence';
import { containerKey, type MemoryAddInput, type MemoryContainer, type MemoryItem, type MemoryPage, type MemoryProfile, type MemorySearchOptions, type MemorySearchResult } from '../../shared/memory';
import { withSpan } from '../telemetry';
import { assertContainer } from './access';
import { MemoryNotFoundError, type MemoryBackend, type MemoryCaller } from './backend';
import { builtInBackend } from './builtin';
import { providerBackend, providerSetting } from './remote';

export { MemoryNotFoundError, MemoryProviderError, MemoryWriteRefusedError, type MemoryBackend, type MemoryCaller } from './backend';

/** The backend that serves a container: a project's chosen provider (./remote), else the built-in one. Teams and agents are always built in (C07 D5). */
function backendFor(container: MemoryContainer): MemoryBackend {
  const provider = container.kind === 'project' ? providerSetting(container.id) : undefined;
  return provider ? providerBackend(provider, container.id) : builtInBackend;
}

async function run<T>(operation: string, container: MemoryContainer, action: 'read' | 'write', caller: MemoryCaller, call: (backend: MemoryBackend) => Promise<T>, count?: (result: T) => number): Promise<T> {
  const backend = backendFor(container);
  return withSpan(`memory.${operation}`, { attributes: { 'landflow.memory.backend': backend.name, 'landflow.memory.container': container.kind } }, async (span: Span) => {
    try {
      assertContainer(caller, container, action);
    } catch (error) {
      if (error instanceof MemoryNotFoundError) span.setAttribute('landflow.memory.denied', true);
      throw error;
    }
    const result = await call(backend);
    if (count) span.setAttribute('landflow.memory.count', count(result));
    return result;
  });
}

export const memory = {
  search: (container: MemoryContainer, query: string, options: MemorySearchOptions, caller: MemoryCaller): Promise<MemorySearchResult> =>
    run('search', container, 'read', caller, (b) => b.search(container, query, options, caller), (r) => r.items.length),
  profile: (container: MemoryContainer, caller: MemoryCaller): Promise<MemoryProfile> =>
    run('profile', container, 'read', caller, (b) => b.profile(container, caller), (r) => r.static.length + r.recent.length),
  add: (container: MemoryContainer, input: MemoryAddInput, caller: MemoryCaller): Promise<MemoryItem> => run('add', container, 'write', caller, (b) => b.add(container, input, caller), () => 1),
  forget: (container: MemoryContainer, id: string, reason: string, caller: MemoryCaller): Promise<MemoryItem> => run('forget', container, 'write', caller, (b) => b.forget(container, id, reason, caller), () => 1),
  list: (container: MemoryContainer, page: { limit?: number; cursor?: string; static?: boolean }, caller: MemoryCaller): Promise<MemoryPage> =>
    run('list', container, 'read', caller, (b) => b.list(container, page, caller), (r) => r.items.length),
};

const line = (item: MemoryItem) => `- [${item.id}] ${item.text} (${[item.kind, item.version && item.version > 1 ? `v${item.version}` : '', item.score !== undefined ? `score ${item.score.toFixed(2)}` : ''].filter(Boolean).join(', ')})`;

/**
 * Items as text for a model (FR-9): one line each inside C03's fence, so nothing in a memory can open or close a Landflow
 * block. '' for no items. `source` is `memory` for a provider's items, else the store the items came from.
 */
export function memoryToolText(items: readonly MemoryItem[]): string {
  const source = items.every((i) => i.source === 'provider') ? 'memory' : items.every((i) => i.source === 'note') ? 'team-notebook' : items.every((i) => i.source === 'agent-memory') ? 'agent-memory' : 'brain-facts';
  return wrapMemory(source, items.map(line));
}

export { containerKey };
