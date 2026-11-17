// @vitest-environment happy-dom
/**
 * SB15 (wave sb3): the build summary. `draftSummary` words a draft from its plan, else from its nodes in edge order; the
 * build route's answer carries it with the whole guarded `left`; the card's buttons open the step or offer the credential
 * picker and never pick (decision D2); a row is done when the canvas says so; the reply is one sentence, the summary, the
 * test button. Made-up data; the credential and project hooks that fetch are stubbed, the editor's store is real.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { BuildPlan } from '@/lib/shared/build-plan';
import type { DraftLeft } from '@/lib/shared/draft-left';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-build-summary-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The model is not the point here: the builder answers a recorded draft, the route's guards and summary are the real ones.
vi.mock('@/lib/server/flow-builder', async (original) => ({
  ...(await original<typeof import('@/lib/server/flow-builder')>()),
  buildFlow: vi.fn(async () => ({
    name: 'Status',
    model: 'test',
    durationMs: 1,
    dropped: [],
    nodes: [
      { key: 'a', type: 'core.schedule', name: 'Weekdays at 8', x: 0, y: 0, parameters: {} },
      { key: 'b', type: 'core.httpRequest', name: 'Get status', x: 0, y: 0, parameters: { method: 'GET', url: 'http://127.0.0.1:3399/s', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } },
      { key: 'c', type: 'core.set', name: 'Mark', x: 0, y: 0, parameters: { mode: 'manual', fields: { values: [{ name: 'k', type: 'string', value: 'v' }] } } },
    ],
    edges: [['a', 'b', 0, 'main'], ['b', 'c', 0, 'main']],
  })),
}));

let listed: Array<{ id: string; name: string; type: string }> = [];
vi.mock('@/components/credentials/use-credentials', async (original) => ({
  ...(await original<typeof import('@/components/credentials/use-credentials')>()),
  useCredentials: () => ({ credentials: listed, types: [] }),
}));
vi.mock('@/components/projects/use-projects', async (original) => ({
  ...(await original<typeof import('@/components/projects/use-projects')>()),
  useCredentialScope: () => ({ scope: undefined, reload: async () => {} }),
}));
vi.mock('@/components/credentials/credential-dialog', () => ({ CredentialDialog: ({ allowedTypes }: { allowedTypes: string[] }) => createElement('div', { 'data-testid': 'dialog', 'data-types': allowedTypes.join(',') }) }));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
vi.mock('@/lib/client/api', () => ({ api: vi.fn(async () => ({ versions: [] })), streamEvents: vi.fn() }));
vi.mock('@/components/editor/test-session', () => ({ testUntilItRuns: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { draftSummary, summaryText, isFilled, credentialLabel } = await import('@/lib/shared/draft-summary');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { noteOpened } = await import('@/components/editor/spotlight-autonomy');
const { testUntilItRuns } = await import('@/components/editor/test-session');
const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');
const { BuildSummaryCard } = await import('@/components/editor/spotlight/build-summary');
const { setStepCredential } = await import('@/components/editor/spotlight/credential-picker');
const { openNodeNamed } = await import('@/components/editor/spotlight/reply');

registry.registerBuiltin(corePlugin);

const label = (type: string) => ({ 'core.schedule': 'Schedule', 'core.httpRequest': 'HTTP Request', 'core.set': 'Edit Fields', 'core.if': 'If' })[type] ?? type;

describe('draftSummary', () => {
  const plan: BuildPlan = {
    name: 'Bug triage',
    steps: [
      { key: 's1', type: 'core.schedule', name: 'Weekdays', does: 'Every weekday at 8' },
      { key: 's2', type: 'core.httpRequest', name: 'Get issues', does: 'Read the new bug issues', from: 's1' },
    ],
    assumptions: ['“every morning” read as 8:00 every day'],
    cannot: ['post to Microsoft Teams: no Teams node is installed'],
  };
  const left: DraftLeft[] = [{ node: 'Get issues', field: 'credential', kind: 'credential', text: '“Get issues” needs a Header Auth credential: pick one' }];

  it('with a plan: its lines, assumptions and cannot, and left as the draft has it', () => {
    const nodes = [{ key: 's1', type: 'core.schedule', name: 'Weekdays' }, { key: 's2', type: 'core.httpRequest', name: 'Get issues' }];
    const summary = draftSummary({ nodes, edges: [['s1', 's2', 0, 'main']], plan, left }, label);
    expect(summary.steps).toEqual(['1. Every weekday at 8 (Schedule)', '2. Read the new bug issues (HTTP Request)']);
    expect(summary.assumptions).toEqual(plan.assumptions);
    expect(summary.cannot).toEqual(plan.cannot);
    expect(summary.left).toEqual(left);
  });

  it('without a plan: a line per node in edge order from the trigger, sub-nodes right after their parent', () => {
    const nodes = [
      { key: 'c', type: 'core.set', name: 'Mark' },
      { key: 'model', type: 'core.chatModel', name: 'Model' },
      { key: 'b', type: 'core.httpRequest', name: 'Get issues' },
      { key: 'a', type: 'core.schedule', name: 'Weekdays' },
    ];
    const edges: Array<[string, string, number, string]> = [['a', 'b', 0, 'main'], ['b', 'c', 0, 'main'], ['model', 'b', 0, 'ai_languageModel']];
    const summary = draftSummary({ nodes, edges }, label);
    expect(summary.steps).toEqual(['1. Weekdays (Schedule)', '2. Get issues (HTTP Request)', '3. Model (core.chatModel)', '4. Mark (Edit Fields)']);
    expect(summary.assumptions).toEqual([]);
    expect(summary.cannot).toEqual([]);
  });

  it('summaryText is the plain words, and names what is left', () => {
    const text = summaryText('Bug triage', { steps: ['1. A (X)', '2. B (Y)'], assumptions: ['read as 8:00'], cannot: ['no Teams node'], left });
    expect(text).toContain('Built “Bug triage” in 2 steps.');
    expect(text).toContain('Left for you:\n- “Get issues” needs a Header Auth credential: pick one');
    expect(text).toContain('Assumed:\n- read as 8:00');
    expect(text).toContain('Not possible here:\n- no Teams node');
    expect(summaryText('X', { steps: [], assumptions: [], cannot: [], left: [] })).not.toContain('Left for you');
  });

  it('reads emptiness and the credential’s display name', () => {
    expect([undefined, '', '  ', [], {}].map(isFilled)).toEqual([false, false, false, false, false]);
    expect([0, 'a', [1], { a: 1 }, false].map(isFilled)).toEqual([true, true, true, true, true]);
    expect(credentialLabel(left[0])).toBe('Header Auth');
  });
});

describe('the build route', () => {
  it('answers a summary whose left equals the guarded left, with the credential item the route added after buildFlow', async () => {
    const route = await import('@/app/api/ai/build/route');
    const response = await route.POST(new Request('http://sb15.test/api/ai/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Every weekday at 8, get the status and mark it' }) }));
    expect(response.status).toBe(200);
    const { draft } = (await response.json()) as { draft: { left: DraftLeft[]; summary: { left: DraftLeft[]; steps: string[] } } };
    expect(draft.summary.left).toEqual(draft.left);
    // buildFlow's own draft held no credential item: the route adds it after the guards.
    expect(draft.summary.left.some((l) => l.kind === 'credential' && l.node === 'Get status' && /Header Auth/.test(l.text))).toBe(true);
    expect(draft.summary.steps).toEqual(['1. Weekdays at 8 (Schedule)', '2. Get status (HTTP Request)', '3. Mark (Edit Fields)']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------------------------

const flow = (): Workflow =>
  ({
    id: 'wf_s',
    name: 'Orders',
    active: false,
    nodes: [
      { id: 'n1', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'n2', name: 'Big order?', type: 'core.if', typeVersion: 1, position: [240, 0], parameters: {} },
      { id: 'n3', name: 'Get status', type: 'core.httpRequest', typeVersion: 1, position: [480, 0], parameters: { method: 'GET', url: 'http://127.0.0.1:3399/s', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } },
    ],
    connections: [
      { id: 'c1', type: 'main', source: 'n1', sourceIndex: 0, target: 'n2', targetIndex: 0 },
      { id: 'c2', type: 'main', source: 'n2', sourceIndex: 0, target: 'n3', targetIndex: 0 },
    ],
  }) as unknown as Workflow;

const LEFT: DraftLeft[] = [
  { node: 'Big order?', field: 'conditions', kind: 'empty', text: '“Big order?”: the condition is empty' },
  { node: 'Get status', field: 'credential', kind: 'credential', text: '“Get status” needs a Header Auth credential: pick one' },
  { node: '', kind: 'dropped', text: 'a second trigger was left out' },
];
const SUMMARY = { steps: ['1. Start (Manual)', '2. Big order? (If)', '3. Get status (HTTP Request)'], assumptions: ['a manual start'], cannot: ['post to Teams: no Teams node'], left: LEFT };

let container: HTMLDivElement;
let root: Root;
const openNode = vi.fn();
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listed = [{ id: 'c1', name: 'Echo token', type: 'core.httpHeaderAuth' }];
  useEditor.getState().load(flow(), registry.nodeTypes().filter((t) => t.pluginId === 'core'));
  useEditor.setState({ openNode, workflowId: 'wf_s' });
  openNode.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (summary = SUMMARY) => act(() => root.render(createElement(BuildSummaryCard, { summary, workflowName: 'Orders', onOpen: openNodeNamed })));
const button = (text: RegExp) => [...container.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
const step = (name: string) => useEditor.getState().toWorkflow().nodes.find((n) => n.name === name)!;

describe('the card', () => {
  it('shows the four parts', () => {
    render();
    expect(container.textContent).toContain('Steps');
    expect(container.querySelectorAll('[data-testid="summary-steps"] li')).toHaveLength(3);
    expect(container.querySelector('[data-testid="summary-assumed"]')?.textContent).toContain('a manual start');
    expect(container.querySelector('[data-testid="summary-left-list"]')?.textContent).toContain('the condition is empty');
    expect(container.querySelector('[data-testid="summary-cannot"]')?.textContent).toContain('no Teams node');
  });

  it('folds the steps after five, with Show all N', () => {
    const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. Step ${i + 1} (X)`);
    render({ ...SUMMARY, steps });
    expect(container.querySelectorAll('[data-testid="summary-steps"] li')).toHaveLength(5);
    act(() => button(/Show all 8/)!.click());
    expect(container.querySelectorAll('[data-testid="summary-steps"] li')).toHaveLength(8);
  });

  it('an empty item’s Open “If” opens that node', () => {
    render();
    act(() => button(/Open “Big order\?”/)!.click());
    expect(openNode).toHaveBeenCalledWith('n2');
  });

  it('a credential item’s button shows the picker with nothing chosen and sets nothing until Use it', () => {
    render();
    const before = step('Get status').credentials;
    act(() => button(/Pick a Header Auth credential/)!.click());
    expect(container.querySelector('[data-testid="credential-picker"]')?.textContent).toContain('Echo token');
    expect(container.querySelector<HTMLInputElement>('input[type="radio"]:checked')).toBeNull();
    expect(openNode).not.toHaveBeenCalled();
    expect(step('Get status').credentials).toEqual(before);
    const use = button(/Use it/)!;
    expect(use.disabled).toBe(true);
    // Choosing is not using: the radio itself is clicked, the step still has nothing.
    act(() => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    expect(container.querySelector<HTMLInputElement>('input[type="radio"]')!.checked).toBe(true);
    expect(step('Get status').credentials).toEqual(before);
    act(() => button(/Use it/)!.click());
    expect(step('Get status').credentials?.httpHeaderAuth).toEqual({ id: 'c1', name: 'Echo token' });
    expect(container.textContent).toContain('Using “Echo token”.');
    expect(button(/Pick a Header Auth/)).toBeUndefined();
  });

  it('after a pick through setStepCredential elsewhere the row reads done, read from the canvas', () => {
    render();
    expect(container.querySelector('[data-state="open"]')).not.toBeNull();
    act(() => void setStepCredential('n3', 'Get status', 'httpHeaderAuth', { id: 'c1', name: 'Echo token' }));
    expect(container.textContent).toContain('Using “Echo token”.');
  });

  it('a field filled on the canvas reads done on the next render, and a field cleared again reads open', () => {
    render();
    const withCondition = (conditions: unknown) => act(() => useEditor.getState().load({ ...flow(), nodes: flow().nodes.map((n) => (n.id === 'n2' ? { ...n, parameters: { conditions } } : n)) } as Workflow, registry.nodeTypes().filter((t) => t.pluginId === 'core')));
    withCondition({ condition: [{ left: '{{ $json.total }}', operator: 'gt', right: '1000' }] });
    expect(button(/Open “Big order\?”/)).toBeUndefined();
    withCondition({});
    expect(button(/Open “Big order\?”/)).toBeDefined();
  });

  it('with no credential to pick from, the picker opens the create dialog for the step’s types', () => {
    listed = [];
    render();
    act(() => button(/Pick a Header Auth credential/)!.click());
    expect(container.querySelector('[data-testid="dialog"]')?.getAttribute('data-types')?.split(',')).toContain('core.httpHeaderAuth');
  });

  it('a dropped item is its text only', () => {
    render({ ...SUMMARY, left: [LEFT[2]] });
    expect(container.textContent).toContain('a second trigger was left out');
    expect(container.querySelector('[data-testid="summary-left"] button')).toBeNull();
  });
});

describe('the reply', () => {
  const built = { name: 'Bug triage', nodes: 3, left: LEFT, pinned: false, model: 'm', durationMs: 1, summary: SUMMARY };
  const parts = () => {
    const reply = useAssistant.getState().items.at(-1)!;
    return reply.role === 'assistant' ? reply.parts : [];
  };
  beforeEach(() => {
    useAssistant.getState().reset();
    useEditor.setState({ workflowId: 'wf_auto', nodes: [], edges: [] });
    noteOpened('wf_auto', 0);
    vi.mocked(testUntilItRuns).mockClear();
  });

  it('is one sentence, then the summary, then the test action', async () => {
    useAutonomous.setState({ on: false });
    await draftWholeFlow('Post big orders', async () => built as never);
    expect(parts().map((p) => p.kind)).toEqual(['text', 'summary', 'action']);
    expect(parts()[0]).toMatchObject({ text: 'Built “Bug triage” in 3 steps.' });
    expect(parts()[1]).toMatchObject({ summary: SUMMARY, workflowName: 'Bug triage' });
  });

  it('autonomous still says “Testing it now.” and starts the test', async () => {
    useAutonomous.setState({ on: true });
    await draftWholeFlow('Post big orders', async () => built as never);
    expect(parts()[0]).toMatchObject({ text: 'Built “Bug triage” in 3 steps. Testing it now.' });
    await Promise.resolve();
    expect(testUntilItRuns).toHaveBeenCalledWith('Post big orders', { publishAgents: true });
  });
});
