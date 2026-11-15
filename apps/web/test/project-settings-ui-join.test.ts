/**
 * The join of project settings for agents (contracts/w9/project-agent-settings-api.md): PC13's real
 * `GET|PATCH /api/projects/:id/settings` through PC15's client helpers (`lib/client/project-agent-settings.ts`), then a Run an
 * Agent node in the project obeying what was saved. Each side tested itself with fakes (the card against the contract's
 * example, the route with direct calls); this one seeds a host and joins the real sides. Model calls go to the fake model
 * server, so "no model call" is counted at the wire.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { fetchAgentSettings, parseAgentSettings, saveAgentSettings } from '../src/lib/client/project-agent-settings';
import { startFakeModels } from './fake-ai-services';
import { routeFetch } from './join-fetch';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-settings-ui-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const projects = await import('@/lib/server/projects');
const settingsRoute = await import('@/app/api/projects/[id]/settings/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const ollama = fake.url.replace(/\/v1$/, '');
// Client helpers' /api/ requests go to the route handlers; the fake model server is reached over the real fetch.
const realFetch = globalThis.fetch;
const routed = routeFetch([['/api/projects/:id/settings', settingsRoute]]);
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return href.startsWith('/api/') ? routed(input, init) : realFetch(input, init);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// The seeded host: A (X's home, X shared to B) and B (Y's home).
const A = projects.createTeamProject({ name: 'Alpha' }).id;
const B = projects.createTeamProject({ name: 'Bravo' }).id;
const publish = (name: string, home: string, model?: { provider: 'ollama'; model: string; baseUrl: string }) => {
  const agent = agentStore.create({ name, instructions: 'Be brief.', ...(model && { model }) });
  projects.setHomeProject('agent', agent.id, home);
  agentStore.publish(agent.id);
  return agent.id;
};
const X = publish('Xavier', A, { provider: 'ollama', model: 'x-own', baseUrl: ollama });
const Y = publish('Yara', B, { provider: 'ollama', model: 'y-own', baseUrl: ollama });
const bare = publish('Bare', B);
projects.putShare('agent', X, B, 'user');

const flowFor = (id: string, agentId: string): Workflow => {
  const wf: Workflow = {
    id,
    name: id,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Agent', name: 'Agent', type: 'core.messageAgent', typeVersion: 1, position: [200, 0], parameters: { agentId, message: 'Hello there', conversation: 'new' } },
    ],
    connections: [{ id: 'Start-Agent', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  projects.setHomeProject('workflow', id, B);
  return wf;
};
const run = (wf: Workflow) => runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });

describe('PC13 settings route → PC15 card helpers', () => {
  it('the card reads B’s real answer: Y is home, X is shared', async () => {
    const state = parseAgentSettings(await fetchAgentSettings(B));
    expect(state.canEdit).toBe(true);
    expect(state.form).toEqual({ agents: { mode: 'off', ids: [] }, agentTools: { mode: 'off', kinds: [] } });
    expect(state.available).toEqual(expect.arrayContaining([
      { id: Y, name: 'Yara', home: true },
      { id: X, name: 'Xavier', home: false },
    ]));
    expect(state.available.find((a) => a.id === bare)).toMatchObject({ home: true });
  });

  it('the PATCH the card builds is accepted and read back', async () => {
    const before = parseAgentSettings(await fetchAgentSettings(B));
    const form = { ...before.form, defaultModel: { provider: 'ollama' as const, model: 'b-default', baseUrl: ollama }, agents: { mode: 'allow' as const, ids: [Y] } };
    const saved = parseAgentSettings(await saveAgentSettings(B, form, before.form, before.available));
    expect(saved.form.agents).toEqual({ mode: 'allow', ids: [Y] });
    expect(saved.form.defaultModel).toMatchObject({ provider: 'ollama', model: 'b-default' });
    const reread = parseAgentSettings(await fetchAgentSettings(B));
    expect(reread.form).toEqual(saved.form);
    // A second save of only the tool kinds keeps the rest (the card sends only what changed).
    const kinds = parseAgentSettings(await saveAgentSettings(B, { ...reread.form, agentTools: { mode: 'allow', kinds: ['node'] } }, reread.form, reread.available));
    expect(kinds.form.agents).toEqual({ mode: 'allow', ids: [Y] });
    expect(kinds.form.agentTools).toEqual({ mode: 'allow', kinds: ['node'] });
    // A is left alone.
    expect(parseAgentSettings(await fetchAgentSettings(A)).form.agents).toEqual({ mode: 'off', ids: [] });
  });
});

describe('a Run an Agent node in B obeys what the card saved', () => {
  it('refuses X, which B’s list does not name, with no model call', async () => {
    const calls = fake.requests.length;
    const record = await run(flowFor('wf_join_x', X));
    expect(record.status).toBe('error');
    expect(record.error?.message).toContain('“Xavier” isn\'t allowed in project “Bravo” (Project settings → Agents)');
    expect(fake.requests.length).toBe(calls);
  });

  it('runs Y, and an agent with no model uses B’s default model', async () => {
    const yRun = await run(flowFor('wf_join_y', Y));
    expect(yRun.error?.message ?? yRun.status).toBe('success');
    expect(fake.requests.at(-1)?.body.model).toBe('y-own');
    const bareRun = await run(flowFor('wf_join_bare', bare));
    expect(bareRun.error?.message ?? bareRun.status).toBe('success');
    expect(fake.requests.at(-1)).toMatchObject({ path: '/api/chat', body: { model: 'b-default' } });
  });
});
