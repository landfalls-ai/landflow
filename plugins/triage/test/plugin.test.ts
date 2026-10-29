import { describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, mcpToolsFromManifest } from '@landflow/protocol';
import { createDispatcher } from '@landflow/sdk/dispatcher';
import { createFetchHandler } from '@landflow/sdk/http';
import { DEFAULT_MAX_CONCURRENCY, plugin } from '../src/main';

describe('manifest', () => {
  it('is valid and lists the five nodes with inlined icons', async () => {
    const response = await createFetchHandler(plugin)(new Request(`http://plugin${HTTP_PATHS.manifest}`));
    const manifest = await response.json();
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.plugin).toMatchObject({ id: 'triage', name: 'Alert Triage', language: 'typescript' });
    expect(manifest.nodes.map((n: any) => n.name)).toEqual(['normalizeAlert', 'extractIocs', 'parseEmail', 'triageRules', 'triageDecision']);
    for (const icon of [manifest.plugin.icon, ...manifest.nodes.map((n: any) => n.icon)]) expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.stringify(manifest)).not.toContain('file:');
  });

  it('declares the output ports in order', () => {
    const { manifest } = createDispatcher(plugin);
    const outputs = (name: string) => manifest.nodes.find((n) => n.name === name)!.outputs.map((o) => o.displayName ?? o.type);
    expect(outputs('triageRules')).toEqual(['Bypass', 'Noise', 'Ask', 'Evaluate']);
    expect(outputs('triageDecision')).toEqual(['Open', 'Attach', 'Ask']);
    expect(outputs('normalizeAlert')).toEqual(['main']);
  });

  it('marks every node idempotent and maps it to the MCP idempotentHint', () => {
    const { manifest } = createDispatcher(plugin);
    expect(manifest.nodes.map((n) => [n.name, n.idempotent])).toEqual([['normalizeAlert', true], ['extractIocs', true], ['parseEmail', true], ['triageRules', true], ['triageDecision', true]]);
    for (const tool of mcpToolsFromManifest(manifest)) expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThan(0);
  });

  it('has no Noise output on the decision node: the AI path cannot drop an alert', () => {
    const decision = plugin.nodes.find((n) => n.description.name === 'triageDecision')!;
    expect(decision.description.outputs).toHaveLength(3);
    expect(decision.description.outputs.map((o) => String(o.displayName).toLowerCase())).not.toContain('noise');
  });
});
