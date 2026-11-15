/** The manifest over HTTP: nodes, credential type, icons, and the MCP tools with read-only hints on the reads only. */
import { describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, mcpToolsFromManifest, type PluginManifest } from '@landflow/protocol';
import { createDispatcher } from '@landflow/sdk/dispatcher';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';

describe('manifest', () => {
  it('is valid over HTTP, icons inlined, the key a password', async () => {
    const handle = createFetchHandler(plugin);
    const manifest = (await (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json()) as PluginManifest;
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.plugin).toMatchObject({ id: 'clickland', name: 'Clickland', language: 'typescript' });
    expect(manifest.nodes.map((n) => [n.name, n.kind, n.triggerSource])).toEqual([
      ['clickland', 'action', undefined],
      ['clicklandAlertTrigger', 'trigger', 'appWebhook'],
      ['clicklandTrigger', 'trigger', 'poll'],
    ]);
    for (const icon of [manifest.plugin.icon, ...manifest.nodes.map((n) => n.icon), ...(manifest.credentialTypes ?? []).map((c) => c.icon)]) expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.stringify(manifest)).not.toContain('file:');
    const [credential] = manifest.credentialTypes ?? [];
    expect(credential).toMatchObject({ name: 'clicklandApi', testable: true });
    expect(credential.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true);
    expect(credential.properties.find((p) => p.name === 'baseUrl')?.default).toBe('http://clickland-api.clickland-dev.svc.cluster.local:4710');
    expect(manifest.nodes[0]).toMatchObject({ usableAsTool: true, idempotent: false });
  });
});

describe('MCP tools', () => {
  const tools = mcpToolsFromManifest(createDispatcher(plugin).manifest);

  it('one per resource and operation, no trigger tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'alerts_create',
      'alerts_delete',
      'alerts_get',
      'alerts_getEvents',
      'alerts_list',
      'alerts_update',
      'knowledge_search',
      'logs_getHistogram',
      'logs_getPatterns',
      'logs_search',
      'metrics_getSeries',
      'metrics_list',
      'notes_create',
      'notes_list',
      'services_list',
      'traces_get',
      'traces_search',
      'views_addPanel',
      'views_get',
      'views_list',
      'views_pin',
      'views_removePanel',
      'views_render',
      'views_update',
    ]);
  });

  it('read-only hints on exactly the reads', () => {
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual([
      'alerts_get',
      'alerts_getEvents',
      'alerts_list',
      'knowledge_search',
      'logs_getHistogram',
      'logs_getPatterns',
      'logs_search',
      'metrics_getSeries',
      'metrics_list',
      'notes_list',
      'services_list',
      'traces_get',
      'traces_search',
      'views_get',
      'views_list',
    ]);
  });

  it('views_render explains the panel types in its spec parameter', () => {
    const render = tools.find((t) => t.name === 'views_render')!;
    const spec = (render.inputSchema.properties as Record<string, { description?: string }>).spec;
    expect(spec.description).toMatch(/timeseries/);
    expect(spec.description).toMatch(/\[\[clickland:view|Example/);
    expect(render.description).toMatch(/marker/);
  });
});
