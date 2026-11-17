/**
 * AG09 (wave ag2): changing an agent follows the agent. A tool a revise adds gets a step of its own and says "(asks first)"
 * when it writes; the Left row holds only what the agent's draft still lacks and follows a credential picked on its page; after
 * Apply there is Test again (the smoke test on the draft, no save); "Extract IOCs" keeps its capitals; a pending card's name
 * is the design's name for its tools now, a created agent keeps its own, and Create names the agent what the card shows.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { agentChanges, shown } from '@/lib/shared/agent-changes';
import { DEFAULT_BRIEF_GUARDRAILS, type AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { startFakeModels } from './fake-ai-services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-change-ag2-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const wire = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; json?: unknown }>,
  answers: {} as Record<string, (init: { method?: string; json?: unknown }) => unknown>,
}));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn(async (path: string, init: { method?: string; json?: unknown } = {}) => {
    wire.calls.push({ path, method: init.method, json: init.json });
    const answer = wire.answers[`${init.method ?? 'GET'} ${path}`];
    if (!answer) throw new Error(`unexpected ${init.method ?? 'GET'} ${path}`);
    return answer(init);
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/agents/ag_1', useSearchParams: () => new URLSearchParams() }));

const { AGENT_SAVED, AGENT_CHANGED, announceSaved, stillLeft } = await import('@/lib/client/agent-change');
const { AgentChangePanel } = await import('@/components/spotlight/agent-change-panel');
const { createFromCard, reviseAgentCard } = await import('@/components/editor/spotlight/agent-ask');
const { useAssistant } = await import('@/components/editor/assistant');
const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: grafana } = await import('../../../plugins/grafana/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { plugin: textToolkit } = await import('../../../plugins/text-toolkit/src/main');

// ---------------------------------------------------------------------------
// The server: a revise's step, needs and name
// ---------------------------------------------------------------------------

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));

const TRIAGE_STEPS = 'Input: an alert.\nSteps:\n1. Normalise it with normalize_alert.\n2. Judge how serious it is.\n3. Tools: normalize_alert, send_email; read before you write, and a person approves each change.\nOutput: a short summary.\nHand over when: it cannot tell.';
const triageBase = (): Partial<AgentConfig> => ({
  name: 'Alert triage agent',
  description: 'Triages an alert.',
  instructions: TRIAGE_STEPS,
  icon: 'bot',
  color: '#6366f1',
  avatar: { kind: 'face', face: 'ada' } as never,
  model: { provider: 'ollama', model: 'qwen3-coder:30b' },
  tools: [
    { id: 'tl_1', type: 'node', name: 'normalize_alert', description: 'Normalise an alert.', nodeType: 'triage.normalizeAlert', parameters: {} } as never,
    { id: 'tl_2', type: 'node', name: 'send_email', description: 'Send an email.', nodeType: 'messaging.emailSend', parameters: {}, requireApproval: true } as never,
  ],
  skills: [],
  schedules: [],
  channels: [],
  memory: { crossSession: false },
  settings: {} as never,
  guardrails: DEFAULT_BRIEF_GUARDRAILS,
});

/** A fake Ollama that proposes `instructions` and the node tools named, like a model that does not touch the steps. */
async function proposing(nodeTools: string, instructions = TRIAGE_STEPS) {
  const fake = await startFakeModels({
    reply: (_provider, body) =>
      Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Triager', instructions, description: 'Triages an alert.', model: 'ollama/qwen3-coder:30b', nodeTools } }] }
        : { text: '', toolCalls: [] },
  });
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = fake.origin;
  return {
    done: async () => {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    },
  };
}

type Body = { config: AgentConfig; changes: string[]; needs: Array<{ tool: string; kind: string; text: string }> };
const names = (config: AgentConfig) => config.tools.map((t) => ('name' in t ? t.name : t.type));
const stepLines = (text: string) => text.split('\n').filter((l) => !/^\s*\d+[.)]\s*Tools:/.test(l));

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  for (const plugin of [triage, grafana, messaging, textToolkit]) registry.registerBuiltin(plugin);
});

describe('a revise names the tool it adds in a step', () => {
  it('Extract IOCs gets a step that calls extract_iocs, not only the Tools line; the Tools line stays last', async () => {
    const run = await proposing('triage.normalizeAlert, triage.extractIocs, messaging.emailSend');
    try {
      const body = (await (await post({ name: 'Alert triage agent', preview: true, base: { config: triageBase() }, change: 'also pull out the IOCs' })).json()) as Body;
      expect(names(body.config)).toContain('extract_iocs');
      const lines = body.config.instructions.split('\n');
      const step = lines.find((l) => /^\d+\. When .*call extract_iocs/.test(l));
      expect(step, body.config.instructions).toBeDefined();
      expect(stepLines(body.config.instructions).join('\n')).toMatch(/extract_iocs/);
      // numbered in order, the Tools line after it, and before Output
      const steps = lines.filter((l) => /^\d+\. /.test(l));
      expect(steps.map((l) => Number(/^(\d+)\./.exec(l)![1]))).toEqual(steps.map((_l, i) => i + 1));
      expect(steps.at(-1)).toMatch(/^\d+\. Tools: /);
      expect(lines.indexOf(step!)).toBeLessThan(lines.findIndex((l) => l.startsWith('Output:')));
      expect(body.changes).toEqual(['Adds the tool Extract IOCs']);
    } finally {
      await run.done();
    }
  });

  it('a configuration ask ("add Send Email as a tool") writes no "asked to add" step', async () => {
    const base = triageBase();
    base.tools = base.tools!.filter((t) => 'name' in t && t.name !== 'send_email');
    base.instructions = TRIAGE_STEPS.replace('normalize_alert, send_email', 'normalize_alert').replace(' send_email', '');
    const run = await proposing('triage.normalizeAlert, messaging.emailSend', base.instructions);
    try {
      const body = (await (await post({ name: 'Alert triage agent', preview: true, base: { config: base }, change: 'add Send Email as a tool' })).json()) as Body;
      const step = body.config.instructions.split('\n').find((l) => /call send_email/.test(l) && !/Tools:/.test(l));
      expect(step, body.config.instructions).toBeDefined();
      expect(step).not.toMatch(/add send email|asked to add/i);
    } finally {
      await run.done();
    }
  });

  it('a configuration ask writes one clause from the first sentence of what the tool is for', async () => {
    const base = triageBase();
    base.instructions = TRIAGE_STEPS;
    const run = await proposing('triage.normalizeAlert, text-toolkit.slugify', base.instructions);
    try {
      const body = (await (await post({ name: 'Alert triage agent', preview: true, base: { config: base }, change: 'add Slugify as a tool' })).json()) as Body;
      const step = body.config.instructions.split('\n').find((l) => /call slugify/.test(l) && !/Tools:/.test(l));
      expect(step, body.config.instructions).toBeDefined();
      expect(step).not.toMatch(/`|Pass the|add slugify|asked to add/i);
      expect(step!.replace(/^\d+\. /, '').split('. ').length).toBe(1);
    } finally {
      await run.done();
    }
  });

  it('a tool that writes says it asks the person first', async () => {
    const base = triageBase();
    base.tools = base.tools!.filter((t) => 'name' in t && t.name !== 'send_email');
    base.instructions = TRIAGE_STEPS.replace('normalize_alert, send_email', 'normalize_alert').replace(' send_email', '');
    const run = await proposing('triage.normalizeAlert, messaging.emailSend', base.instructions);
    try {
      const body = (await (await post({ name: 'Alert triage agent', preview: true, base: { config: base }, change: 'also email the summary with Send Email' })).json()) as Body;
      const step = body.config.instructions.split('\n').find((l) => /call send_email/.test(l) && !/Tools:/.test(l));
      expect(step, body.config.instructions).toMatch(/it asks the person first/);
      expect(body.changes[0]).toBe('Adds the tool Send Email (asks first)');
    } finally {
      await run.done();
    }
  });
});

describe('the Left row of a change keeps what the change leaves', () => {
  const grafanaBase = (credentialSet: boolean): Partial<AgentConfig> => ({
    ...triageBase(),
    name: 'Grafana observer',
    instructions: 'Input: a question.\nSteps:\n1. Read the alerts with get_alerts.\n2. Tools: get_alerts.\nOutput: each alert explained.\nHand over when: it is not about alerts.',
    tools: [{ id: 'tl_1', type: 'node', name: 'get_alerts', description: 'Get alerts.', nodeType: 'grafana.getAlerts', parameters: {}, ...(credentialSet && { credentials: { grafana_alertmanager_api_token: { id: 'cr_1', name: 'Local Grafana' } } }) } as never],
  });

  it('with the credential set on the base, no Get Alerts credential line comes back; Acknowledge Alert’s is kept, and says it asks first', async () => {
    const run = await proposing('grafana.getAlerts, grafana.acknowledgeAlert', grafanaBase(true).instructions);
    try {
      const body = (await (await post({ name: 'Grafana observer', preview: true, base: { config: grafanaBase(true) }, change: 'also let it acknowledge an alert' })).json()) as Body;
      expect(body.needs.filter((n) => n.kind === 'credential').map((n) => n.tool)).toEqual(['acknowledge_alert']);
      expect(body.needs.some((n) => n.tool === 'get_alerts' && n.kind === 'credential')).toBe(false);
      expect(body.changes).toContain('Adds the tool Acknowledge Alert (asks first)');
    } finally {
      await run.done();
    }
  });

  it('with the credential unset on the base, its line stays', async () => {
    const run = await proposing('grafana.getAlerts, grafana.acknowledgeAlert', grafanaBase(false).instructions);
    try {
      const body = (await (await post({ name: 'Grafana observer', preview: true, base: { config: grafanaBase(false) }, change: 'also let it acknowledge an alert' })).json()) as Body;
      expect(body.needs.filter((n) => n.kind === 'credential').map((n) => n.tool).sort()).toEqual(['acknowledge_alert', 'get_alerts']);
    } finally {
      await run.done();
    }
  });

  it('stillLeft drops a credential line whose slot is set on the draft, and nothing else', () => {
    const lines = ['get_alerts: pick a grafana_alertmanager_api_token credential (you have “Local Grafana”)', 'acknowledge_alert: pick a grafana_alertmanager_api_token credential', 'Pick a model: none'];
    const draft = { tools: [{ name: 'get_alerts', credentials: { grafana_alertmanager_api_token: { id: 'c' } } }, { name: 'acknowledge_alert' }] };
    expect(stillLeft(lines, draft)).toEqual(lines.slice(1));
    expect(stillLeft(lines, undefined)).toEqual(lines);
  });
});

describe('the words', () => {
  it('keeps acronyms and says a write asks first', () => {
    expect(shown('extract_iocs')).toBe('Extract IOCs');
    expect(shown('jwt_decode')).toBe('JWT Decode');
    expect(shown('get_uuid')).toBe('Get UUID');
    expect(shown('get_alert_details')).toBe('Get Alert Details');
    expect(shown('parse_xyz', 'Parse XYZ')).toBe('Parse XYZ');
    expect(shown('Hash')).toBe('Hash');
    const before = { tools: [{ type: 'node', name: 'a', nodeType: 'x.a' }] };
    const after = { tools: [...before.tools, { type: 'node', name: 'acknowledge_alert', nodeType: 'x.b', requireApproval: true }, { type: 'node', name: 'extract_iocs', nodeType: 'x.c' }] };
    expect(agentChanges(before, after)).toEqual(['Adds the tool Acknowledge Alert (asks first)', 'Adds the tool Extract IOCs']);
  });

  it('a name the design made again says why; a name the person gave does not', () => {
    const before = { name: 'Crypto Toolkit agent', tools: [{ type: 'node', name: 'hash', nodeType: 'x.a' }] };
    const after = { name: 'Utility helper', tools: [...before.tools, { type: 'node', name: 'slugify', nodeType: 'x.b' }] };
    expect(agentChanges(before, after)).toEqual(['Adds the tool Slugify', 'Renames it to Utility helper (its tools changed)']);
    expect(agentChanges(before, { ...after, name: 'Hashy' })).toEqual(['Adds the tool Slugify', 'Renames it to Hashy']);
  });
});

// ---------------------------------------------------------------------------
// The panel on the agent's page
// ---------------------------------------------------------------------------

// The plugins above read files by `new URL(…, import.meta.url)`, which the DOM's URL cannot resolve: this file runs in Node and the panel's DOM is happy-dom's, installed here.
const { Window } = await import('happy-dom');
const dom = new Window({ url: 'http://localhost:3000/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLSelectElement', 'HTMLDivElement', 'SVGElement', 'Element', 'Node', 'DocumentFragment', 'Text', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent', 'PointerEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'localStorage', 'sessionStorage'] as const) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) Object.defineProperty(globalThis, key, { value: key === 'window' ? dom : typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...a: unknown[]) => unknown).bind(dom) : value, configurable: true, writable: true });
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  Object.assign(wire, { calls: [], answers: {} });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const draftWith = (credential: boolean) => ({
  id: 'ag_1',
  name: 'Watcher',
  tools: [{ type: 'node', name: 'get_alerts', nodeType: 'grafana.getAlerts', parameters: {} }, { type: 'node', name: 'acknowledge_alert', nodeType: 'grafana.acknowledgeAlert', parameters: {}, requireApproval: true, ...(credential && { credentials: { grafana_alertmanager_api_token: { id: 'cr_1', name: 'Local Grafana' } } }) }],
});
const ACK_NEED = 'acknowledge_alert: pick a grafana_alertmanager_api_token credential (none yet: create one under Credentials)';
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const click = async (label: RegExp) => {
  const button = [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));
  expect(button, `a button ${label}`).toBeDefined();
  await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
};
const text = () => container.textContent ?? '';

describe('the agent page’s change card follows the draft', () => {
  it('Test again after Apply posts the smoke test and saves nothing; AGENT_SAVED re-reads the draft and the Left row drops the credential now set', async () => {
    let draft = draftWith(false);
    const config = { name: 'Watcher', tools: draft.tools };
    wire.answers['GET /api/agents/ag_1'] = () => ({ agent: draft });
    wire.answers['POST /api/agents/design'] = () => ({ config, changes: ['Adds the tool Acknowledge Alert (asks first)'], needs: [{ tool: 'acknowledge_alert', kind: 'credential', text: ACK_NEED }], missing: [], designed: true, notAdded: [] });
    wire.answers['PUT /api/agents/ag_1'] = () => ({ agent: draft });
    let smokes = 0;
    wire.answers['POST /api/agents/ag_1/smoke-test'] = () => ({ smoke: ++smokes === 1 ? { state: 'untested', reason: 'needs a credential: Acknowledge Alert' } : { state: 'passed' } });
    await act(async () => root.render(createElement(AgentChangePanel, { agentId: 'ag_1', name: 'Watcher', onClose: () => {}, conversation: {} as never, starters: [] })));
    await click(/Make its answers shorter/);
    expect(text()).toContain('Adds the tool Acknowledge Alert (asks first)');
    expect(text()).toContain('Left');
    expect(text()).toContain(ACK_NEED);
    await click(/Apply to its draft/);
    expect(text()).toContain('Saved to its draft · not tested yet: needs a credential');
    expect(wire.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    // the person picks the credential on the agent's page: its builder saves, and says so
    draft = draftWith(true);
    await act(async () => announceSaved('ag_1'));
    await settle();
    expect(text()).not.toContain(ACK_NEED);
    expect(text()).not.toContain('Left');

    // Test again: the smoke test on the draft, no save
    wire.calls.length = 0;
    await click(/Test again/);
    expect(wire.calls.map((c) => `${c.method ?? 'GET'} ${c.path}`)).toEqual(['POST /api/agents/ag_1/smoke-test']);
    expect(text()).toContain('Saved to its draft · tested, 1 of 1 passed');
    expect([...container.querySelectorAll('button')].some((b) => /^Publish$/.test(b.textContent ?? ''))).toBe(true);
  });

  it('re-reads the draft on AGENT_CHANGED too, for its own agent only', async () => {
    let reads = 0;
    wire.answers['GET /api/agents/ag_1'] = () => ({ agent: (reads++, draftWith(false)) });
    wire.answers['POST /api/agents/design'] = () => ({ config: {}, changes: ['Adds the tool X'], needs: [{ tool: 'acknowledge_alert', kind: 'credential', text: ACK_NEED }], missing: [], designed: true, notAdded: [] });
    await act(async () => root.render(createElement(AgentChangePanel, { agentId: 'ag_1', name: 'Watcher', onClose: () => {}, conversation: {} as never, starters: [] })));
    await click(/Make its answers shorter/);
    const before = reads;
    await act(async () => window.dispatchEvent(new CustomEvent(AGENT_CHANGED, { detail: { agentId: 'someone-else' } })));
    await settle();
    expect(reads).toBe(before);
    await act(async () => window.dispatchEvent(new CustomEvent(AGENT_SAVED, { detail: { agentId: 'ag_1' } })));
    await settle();
    expect(reads).toBeGreaterThan(before);
  });
});

describe('the builder tells the cards when it saves', () => {
  it('persist dispatches AGENT_SAVED after a successful PUT, once, and never AGENT_CHANGED', () => {
    const source = readFileSync(new URL('../src/components/agents/builder.tsx', import.meta.url), 'utf8');
    const persist = source.slice(source.indexOf('const persist = useCallback'), source.indexOf('const update: UpdateConfig'));
    expect(persist.match(/announceSaved\(agentId\)/g)).toHaveLength(1);
    expect(persist).not.toMatch(/announceChange|AGENT_CHANGED/);
    expect(persist.indexOf("method: 'PUT'")).toBeLessThan(persist.indexOf('announceSaved'));
    expect(persist.indexOf('announceSaved')).toBeLessThan(persist.indexOf('catch'));
  });
});

// ---------------------------------------------------------------------------
// The editor's card: the name is the agent's
// ---------------------------------------------------------------------------

describe('the pending card’s name is the design’s, and Create names the agent what the card shows', () => {
  const card = (name: string, configName = name) => ({
    name,
    description: 'Decodes and hashes.',
    tools: [{ name: 'hash', type: 'go-crypto.hash', writes: false, requireApproval: false }],
    guardrails: [],
    cases: [],
    needs: [],
    missing: [],
    config: { name: configName, description: 'Decodes and hashes.', instructions: 'Input: x.\nSteps:\n1. Hash it.\nOutput: y.\nHand over when: z.', tools: [{ type: 'node', name: 'hash', nodeType: 'text-toolkit.slugify', parameters: {} }] },
    state: 'designed' as const,
  });

  it('Create posts config.name equal to card.name', async () => {
    useAssistant.getState().reset();
    wire.answers['POST /api/agents/import'] = () => ({ agent: { id: 'ag_9', name: 'x' } });
    useAssistant.getState().append([{ id: 'it1', role: 'assistant', parts: [{ kind: 'agentCard', card: card('Utility helper', 'Crypto Toolkit agent') as never }] }]);
    await createFromCard('it1', card('Utility helper', 'Crypto Toolkit agent') as never);
    const imported = wire.calls.find((c) => c.path === '/api/agents/import');
    expect((imported?.json as { config: { name: string } }).config.name).toBe('Utility helper');
  });

  it('a pending card named by fallbackName is named again from its new tools; one the person named keeps its name', async () => {
    const run = await proposing('text-toolkit.slugify');
    const pending = { ...triageBase(), name: 'Text toolkit agent', description: 'Slugs.', instructions: 'Input: x.\nSteps:\n1. Slug it.\nOutput: y.\nHand over when: z.' };
    pending.tools = [{ id: 'tl_1', type: 'node', name: 'slugify', description: 'Slug.', nodeType: 'text-toolkit.slugify', parameters: {} } as never];
    delete (pending as { memory?: unknown }).memory;
    delete (pending as { settings?: unknown }).settings;
    try {
      const named = (await (await post({ name: 'Hashy', preview: true, base: { config: { ...pending, name: 'Hashy' } }, change: 'also change the case of text' })).json()) as Body;
      expect(named.config.name).toBe('Hashy');
      const saved = (await (await post({ name: 'Text toolkit agent', preview: true, base: { config: { ...triageBase(), name: 'Text toolkit agent', tools: pending.tools } }, change: 'also change the case of text' })).json()) as Body;
      expect(saved.config.name).toBe('Text toolkit agent'); // an agent that exists: only a rename renames it
    } finally {
      await run.done();
    }
  });
});
