// C07: a plugin node can declare itself a memory provider (docs/protocol.md#memory-providers). The host refuses a
// manifest whose provider node lacks one of the five operations or an output the host reads, naming the node.
import { describe, expect, it } from 'vitest';
import { MEMORY_OPERATIONS, MEMORY_OUTPUT_REQUIRED, checkMemoryProvider, parseManifest, type NodeDescriptor, type PluginManifest } from '../src';

const out = (required: string[]) => ({ type: 'object', required, properties: Object.fromEntries(required.map((k) => [k, {}])) });

const provider = (override: (node: NodeDescriptor) => void = () => undefined): PluginManifest => {
  const node: NodeDescriptor = {
    name: 'vecmem',
    displayName: 'Vec Memory',
    description: 'A memory provider',
    version: 1,
    kind: 'action',
    memoryProvider: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'search',
        options: MEMORY_OPERATIONS.map((op) => ({ name: op, value: op, outputSchema: out(MEMORY_OUTPUT_REQUIRED[op]) })),
      },
    ],
  };
  override(node);
  return { protocol: 'landflow.plugin/v1', plugin: { id: 'vec', name: 'Vec', version: '1.0.0', language: 'typescript' }, nodes: [node] };
};

describe('memory provider flag', () => {
  it('accepts a node with the five operations and their output schemas', () => {
    expect(parseManifest(provider())).toMatchObject({ ok: true });
    expect(checkMemoryProvider(provider().nodes[0])).toBeUndefined();
  });

  it('refuses a provider missing forget, naming the node', () => {
    const manifest = provider((node) => {
      const op = node.properties[0];
      op.options = op.options!.filter((o) => o.value !== 'forget');
    });
    const result = parseManifest(manifest);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('vecmem');
    expect(!result.ok && result.error).toContain('forget');
  });

  it('refuses a search whose output schema does not require items', () => {
    const manifest = provider((node) => {
      const search = node.properties[0].options!.find((o) => o.value === 'search')!;
      search.outputSchema = out(['hits']);
    });
    const result = parseManifest(manifest);
    expect(!result.ok && result.error).toMatch(/vecmem.*search.*items/);
  });

  it('refuses a trigger and a node without the operation property', () => {
    expect(checkMemoryProvider({ ...provider().nodes[0], kind: 'trigger' })).toMatch(/vecmem/);
    expect(checkMemoryProvider({ ...provider().nodes[0], properties: [] })).toMatch(/operation/);
  });

  it('leaves a node without the flag alone', () => {
    const manifest = provider((node) => {
      delete node.memoryProvider;
      node.properties = [];
    });
    expect(parseManifest(manifest)).toMatchObject({ ok: true });
  });
});
