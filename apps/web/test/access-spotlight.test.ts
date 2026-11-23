/** Spotlight knows the access nodes and Ask a Person's two new options (C35-C2 U-6): the parameter lines the builder's prompt carries. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-spotlight-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { makeWorld } = await import('./fixtures/access-world');
const chatRoute = await import('@/app/api/assistant/chat/route');
const suggestRoute = await import('@/app/api/assistant/suggest/route');
const { PARAMETER_FORMATS } = await import('@/lib/server/flow-builder');
const line = (type: string) => PARAMETER_FORMATS.split('\n').find((l) => l.startsWith(`- ${type}`)) ?? '';

describe('Spotlight and the access nodes', () => {
  it('names the three access nodes', () => {
    expect(line('core.accessRequestTrigger')).toContain('once per request');
    expect(line('core.accessDecision')).toContain('requestId');
    expect(line('core.accessDecision')).toContain('no request id: it applies nothing');
    expect(line('core.fileAccessRequest')).toContain('only files an access request');
  });
  it('Ask a Person’s line carries Answer Choices and People Only', () => {
    const ask = line('core.confirmDraft');
    expect(ask).toContain('choices');
    expect(ask).toContain('peopleOnly');
  });
  it('says the catalog is edited on the Access page and Spotlight never decides or grants', () => {
    expect(PARAMETER_FORMATS).toMatch(/never approves or grants/);
  });
});

describe('Spotlight is read-only on the installed access flows', () => {
  it('refuses to chat about or suggest for them, for an admin too, and still serves any other workflow', async () => {
    const w = await makeWorld();
    w.as(w.owner);
    const flow = { name: 'x', nodes: [{ id: 'n1', type: 'core.manualTrigger', name: 'T', position: [0, 0], parameters: {} }], connections: [], settings: {} };
    const post = (route: { POST: (r: Request) => Promise<Response> }, data: unknown) => route.POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }));
    for (const id of [w.setup!.workflowId!, w.setup!.chatWorkflowId!]) {
      const chat = await post(chatRoute, { workflow: flow, workflowId: id, messages: [{ role: 'user', content: 'change it' }] });
      expect(chat.status, JSON.stringify(await chat.clone().json())).toBe(403);
      expect(((await chat.json()) as { error: string }).error).toMatch(/installed access flow.*make a copy/);
      const suggest = await post(suggestRoute, { workflow: flow, workflowId: id, nodeId: 'n1', run: { status: 'success', nodes: {} } });
      expect(suggest.status).toBe(403);
    }
    const other = await post(chatRoute, { workflow: flow, workflowId: 'wf_other', messages: [{ role: 'user', content: 'hi' }] });
    expect(other.status).not.toBe(403);
  });
});
