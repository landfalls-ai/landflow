// @vitest-environment happy-dom
/**
 * Re-check (wave ag4): the agent page's pickers offer only what the agent's home project may use, and never pick on their own
 * before that list is known (a team agent used to auto-pick the person's only, personal, credential, and the autosave then
 * refused it for good). Real ModelCard and NodeCredentials in happy-dom; the routes are a stubbed fetch with made-up data.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ModelCard } = await import('@/components/agents/model-card');
const { NodeCredentials } = await import('@/components/credentials/node-credentials');
const { AgentScopeProvider } = await import('@/components/credentials/agent-scope');
const { useCredentialStore } = await import('@/components/credentials/use-credentials');

const personal = { id: 'c_personal', name: 'My key', type: 'core.openAiApi' };
const team = { id: 'c_team', name: 'Team key', type: 'core.openAiApi' };
let container: HTMLDivElement;
let root: Root;
let scoped: Array<typeof personal> | 'fail';
let everything = [personal, team];
const urls: string[] = [];
beforeEach(() => {
  urls.length = 0;
  everything = [personal, team];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useCredentialStore.setState({ credentials: undefined, types: undefined } as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    urls.push(u);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/credentials\?agentId=/.test(u)) return scoped === 'fail' ? new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }) : ok({ credentials: scoped, projectId: 'proj_team' });
    if (/\/api\/credentials/.test(u)) return ok({ credentials: everything });
    if (/credential-types/.test(u)) return ok({ types: [] });
    return ok({ options: [] });
  }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const mount = async (updates: Array<(c: never) => unknown>) => {
  const config = { name: 'A', model: { provider: 'openai', model: '' }, tools: [], skills: [], channels: [], schedules: [] };
  await act(async () => root.render(createElement(AgentScopeProvider, { value: 'ag_team' }, createElement(ModelCard, { config: config as never, update: ((f: (c: never) => unknown) => updates.push(f)) as never }))));
  await settle();
};
const optionNames = () => [...container.querySelectorAll('select#agent-credential option')].map((o) => o.textContent);

describe('the agent page’s model credential', () => {
  it('lists only the agent’s project’s credentials and picks the only one of them', async () => {
    scoped = [team];
    const updates: Array<(c: never) => unknown> = [];
    await mount(updates);
    expect(urls.some((u) => /credentials\?agentId=ag_team/.test(u))).toBe(true);
    expect(optionNames()).not.toContain('My key');
    expect(optionNames()).toContain('Team key');
    const picked = updates.map((f) => f({ model: { provider: 'openai', model: '' } } as never) as { model: { credential?: { id: string } } });
    expect(picked.map((p) => p.model.credential?.id)).toEqual(['c_team']);
  });

  it('picks nothing when the agent’s project has none (the person’s own credential is not offered)', async () => {
    scoped = [];
    everything = [personal]; // the only credential the person sees is personal: the old page picked it
    const updates: Array<(c: never) => unknown> = [];
    await mount(updates);
    expect(optionNames()).not.toContain('My key');
    expect(updates).toHaveLength(0);
  });

  it('a failed filter says so, offers Retry and picks nothing', async () => {
    scoped = 'fail';
    everything = [personal];
    const updates: Array<(c: never) => unknown> = [];
    await mount(updates);
    expect(container.textContent).toMatch(/Couldn’t check which credentials this agent’s project may use/);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
    expect(updates).toHaveLength(0);
  });
});

describe('a tool dialog’s credentials on the agent page', () => {
  it('offers the agent’s project’s credentials only and picks nothing before they are known', async () => {
    scoped = [team];
    const changes: unknown[] = [];
    await act(async () => root.render(createElement(AgentScopeProvider, { value: 'ag_team' }, createElement(NodeCredentials, { nodeType: 'x', requirements: [{ name: 'openAiApi', required: true }] as never, onChange: (n: unknown) => changes.push(n) }))));
    await settle();
    expect(urls.some((u) => /credentials\?agentId=ag_team/.test(u))).toBe(true);
  });
});
