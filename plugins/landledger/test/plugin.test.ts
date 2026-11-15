/** The manifest over HTTP and the MCP tools: Decision → Relay is never a tool; the reads carry read-only hints. */
import { describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, mcpToolsFromManifest, type PluginManifest } from '@landflow/protocol';
import { createDispatcher } from '@landflow/sdk/dispatcher';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';

describe('manifest', () => {
  it('is valid over HTTP, icons inlined, the key and the webhook secret passwords', async () => {
    const handle = createFetchHandler(plugin);
    const manifest = (await (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json()) as PluginManifest;
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.plugin).toMatchObject({ id: 'landledger', name: 'Landledger', language: 'typescript' });
    expect(manifest.nodes.map((n) => [n.name, n.kind, n.triggerSource])).toEqual([
      ['landledger', 'action', undefined],
      ['landledgerTrigger', 'trigger', 'appWebhook'],
    ]);
    for (const icon of [manifest.plugin.icon, ...manifest.nodes.map((n) => n.icon), ...(manifest.credentialTypes ?? []).map((c) => c.icon)]) expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.stringify(manifest)).not.toContain('file:');
    const [credential, relay, notes] = manifest.credentialTypes ?? [];
    expect(credential).toMatchObject({ name: 'landledgerApi', testable: true });
    expect(relay).toMatchObject({ name: 'landledgerRelayApi', testable: true });
    expect(notes).toMatchObject({ name: 'landledgerNotesKey', testable: true });
    expect(notes.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true);
    expect(relay.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true);
    // A relay takes the relay key, a note the notes key; every other operation the flows' key.
    expect(manifest.nodes[0].credentials).toEqual([
      { name: 'landledgerApi', required: true, displayOptions: { hide: { resource: ['decision', 'note'] } } },
      { name: 'landledgerRelayApi', required: true, displayOptions: { show: { resource: ['decision'] } } },
      { name: 'landledgerNotesKey', required: true, displayOptions: { show: { resource: ['note'] } } },
    ]);
    expect(credential.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true);
    expect(credential.properties.find((p) => p.name === 'webhookSecret')?.typeOptions?.password).toBe(true);
    expect(credential.properties.find((p) => p.name === 'baseUrl')?.default).toBe('http://landledger-api.landflow-dev.svc.cluster.local:4810');
    expect(manifest.nodes[0]).toMatchObject({ usableAsTool: true, idempotent: false });
    expect(manifest.nodes[0].toolDescription).not.toMatch(/relay/i);
  });
});

describe('MCP tools', () => {
  const tools = mcpToolsFromManifest(createDispatcher(plugin).manifest);

  it('one per resource and operation, without Decision → Relay and without the trigger', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'budget_check',
      'close_getSnapshot',
      'contract_getSeats',
      'cost_query',
      'cost_window',
      'key_me',
      'note_getFigures',
      'note_submitDraft',
      'period_getStatus',
      'request_create',
      'request_get',
      'request_list',
      'request_markApplied',
      'request_releaseSeats',
      'reservation_create',
      'reservation_release',
    ]);
  });

  it('read-only hints on exactly the reads', () => {
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual(['budget_check', 'close_getSnapshot', 'contract_getSeats', 'cost_query', 'cost_window', 'key_me', 'note_getFigures', 'period_getStatus', 'request_get', 'request_list']);
  });

  it('request_create asks for the agent and its sponsor', () => {
    const create = tools.find((t) => t.name === 'request_create')!;
    const properties = create.inputSchema.properties as Record<string, { description?: string }>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['agentId', 'agentName', 'sponsor', 'amount', 'costCenter', 'evidence']));
  });
});
