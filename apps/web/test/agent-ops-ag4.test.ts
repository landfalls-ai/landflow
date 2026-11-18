// @vitest-environment happy-dom
/**
 * AG17 (wave ag4): Spotlight changes the agent instead of wiring sub-nodes into a Run an Agent node. The op `changeAgent` (parse, apply,
 * describe), the refusal of new `ai_*` wiring into a bound node (Spotlight's ops and the editor's drag), the hand-off of an applied
 * change to the agent's change card, and the editor's open path (the move, the notice, the pill). Real stores and components in
 * happy-dom; the routes are a stubbed fetch with made-up data.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { moveNoticeLines, type AgentMove, type AgentMoveResult } from '@/lib/shared/agent-bubbles';
import { applyOps, describeOps, opsTitle, parseOps, type AssistantOp } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const changeCard = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { registryLookup } = await import('@/lib/server/assistant/ops');
const { useEditor } = await import('@/components/editor/store');
const { applyChanges, AGENT_CHANGE_ASKED } = await import('@/components/editor/assistant');
window.addEventListener(AGENT_CHANGE_ASKED, (e) => changeCard((e as CustomEvent).detail)); // Spotlight's card listens in the real editor
const { moveOnOpen } = await import('@/lib/client/agent-moves');
const { AgentMovesNotice } = await import('@/components/editor/agent-moves-notice');
const { useEditLock } = await import('@/components/editor/edit-lock');

let types: NodeTypeInfo[];
const lookup = () => registryLookup(types);
beforeAll(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); // feedback pings and the like
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.available);
});

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
/** Trigger → Alert triager (a Run an Agent node bound to `ag_triage`), an AI Agent, and a Run an Agent node whose agent is an expression. */
function flow(): Workflow {
  return {
    id: 'wf_ag17',
    name: 'Alerts',
    nodes: [
      node('t', 'Start', 'core.manualTrigger'),
      node('a', 'Alert triager', 'core.messageAgent', { agentId: 'ag_triage', message: 'hi' }),
      node('ai', 'AI Agent', 'core.aiAgent'),
      node('x', 'Dynamic', 'core.messageAgent', { agentId: '={{ $json.agent }}', message: 'hi' }),
      node('slug', 'Calculator', 'core.calculatorTool'),
    ],
    connections: [{ id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'a', targetIndex: 0 }],
  };
}
const edgeCount = (wf: Workflow) => wf.connections.length;

describe('the op (parse, apply, describe)', () => {
  it('parses changeAgent with a node or an agent id; one without a change is dropped', () => {
    expect(parseOps([{ op: 'changeAgent', node: 'Alert triager', change: 'also email on-call' }]).ops).toEqual([{ op: 'changeAgent', node: 'Alert triager', change: 'also email on-call' }]);
    expect(parseOps([{ op: 'changeAgent', agentId: 'ag_1', change: 'use Haiku' }]).ops).toEqual([{ op: 'changeAgent', agentId: 'ag_1', change: 'use Haiku' }]);
    expect(parseOps([{ op: 'changeAgent', node: 'Alert triager' }]).ops).toEqual([]);
    expect(parseOps([{ op: 'changeAgent', change: 'x'.repeat(2001), node: 'Alert triager' }]).ops).toEqual([]);
    expect(parseOps([{ op: 'changeAgent', change: 'no target' }]).ops).toEqual([]);
  });

  it('changes nothing in the graph, lists the op with the node’s agent id, and says "Change <agent>: <change>"', () => {
    const wf = flow();
    const result = applyOps(wf, [{ op: 'changeAgent', node: 'Alert triager', change: 'also email on-call' }], lookup());
    expect(result.workflow).toEqual(wf);
    expect(result.applied).toEqual([{ op: 'changeAgent', node: 'Alert triager', agentId: 'ag_triage', change: 'also email on-call' }]);
    expect(describeOps(result.applied, lookup())).toEqual([{ sign: '~', text: 'Change Alert triager: also email on-call' }]);
    expect(opsTitle(result.applied)).toBe('Change Alert triager: also email on-call');
    // Dropped with why: a missing node, a node whose agent is an expression.
    expect(applyOps(wf, [{ op: 'changeAgent', node: 'Nope', change: 'x' }], lookup()).dropped[0]).toMatch(/no such node/);
    expect(applyOps(wf, [{ op: 'changeAgent', node: 'Dynamic', change: 'x' }], lookup()).dropped[0]).toMatch(/no agent chosen/);
  });

  it('a Run a Team node stands for its lead: the op carries the team id, and a parameter ask on a bound node is a change, not a new node', () => {
    const wf = { ...flow(), nodes: [...flow().nodes, node('tm', 'Support team', 'core.runTeam', { teamId: 'tm_support', message: 'hi' })] };
    const result = applyOps(wf, [{ op: 'changeAgent', node: 'Support team', change: 'use Haiku for the lead' }], lookup());
    expect(result.dropped).toEqual([]);
    expect(result.applied).toEqual([{ op: 'changeAgent', node: 'Support team', teamId: 'tm_support', change: 'use Haiku for the lead' }]);
    expect(result.workflow).toEqual(wf);
    // "set Send Email's From Email to …" on a bound node's tool: the op path is changeAgent, the graph gains no node.
    const ask = applyOps(wf, [{ op: 'changeAgent', node: 'Alert triager', change: 'set Send Email’s From Email to ops@example.com' }], lookup());
    expect(ask.workflow.nodes.length).toBe(wf.nodes.length);
    expect(ask.applied[0]).toMatchObject({ op: 'changeAgent', agentId: 'ag_triage' });
  });
});

describe('new wiring into a bound node is refused', () => {
  const sentence = '“Alert triager” runs the agent “ag_triage”: its model, memory and tools are the agent’s. Change the agent instead (changeAgent).';

  it('a connect of a tool into a bound Run an Agent node is dropped with the sentence; the AI Agent node and an expression id are unchanged', () => {
    const wf = flow();
    const bound = applyOps(wf, [{ op: 'connect', from: 'Calculator', to: 'Alert triager', type: 'ai_tool' }], lookup());
    expect(bound.applied).toEqual([]);
    expect(bound.dropped[0]).toContain(sentence);
    expect(edgeCount(bound.workflow)).toBe(edgeCount(wf));

    const ai = applyOps(wf, [{ op: 'connect', from: 'Calculator', to: 'AI Agent', type: 'ai_tool' }], lookup());
    expect(ai.dropped).toEqual([]);
    expect(ai.workflow.connections.some((c) => c.type === 'ai_tool' && c.target === 'ai')).toBe(true);

    const expr = applyOps(wf, [{ op: 'connect', from: 'Calculator', to: 'Dynamic', type: 'ai_tool' }], lookup());
    expect(expr.dropped).toEqual([]);
    expect(expr.workflow.connections.some((c) => c.type === 'ai_tool' && c.target === 'x')).toBe(true);
  });

  it('an addNode of a memory after a bound node goes through the same check', () => {
    const result = applyOps(flow(), [{ op: 'addNode', type: 'core.simpleMemory', after: 'Alert triager' }], lookup());
    expect(result.added).toEqual([]);
    expect(result.dropped[0]).toContain(sentence);
  });
});

describe('the editor’s drag and the hand-off', () => {
  beforeEach(() => {
    toasts.message.mockClear();
    changeCard.mockClear();
    useEditor.getState().load(flow(), types);
  });

  it('an ai_tool edge into a bound node changes nothing and raises the toast; into an AI Agent node it is added as before', () => {
    const before = useEditor.getState().edges.length;
    useEditor.getState().onConnect({ source: 'slug', target: 'a', sourceHandle: 'ai_tool:0', targetHandle: 'ai_tool:0' });
    expect(useEditor.getState().edges.length).toBe(before);
    expect(toasts.message).toHaveBeenCalledWith('Alert triager’s model, memory and tools are the agent’s: use + under the slot to change the agent');
    useEditor.getState().onConnect({ source: 'slug', target: 'ai', sourceHandle: 'ai_tool:0', targetHandle: 'ai_tool:0' });
    expect(useEditor.getState().edges.length).toBe(before + 1);
  });

  it('an applied changeAgent leaves the graph alone and hands the agent and the change to Spotlight’s card', async () => {
    const edges = useEditor.getState().edges.length;
    let handed: unknown;
    const ops: AssistantOp[] = [{ op: 'changeAgent', node: 'Alert triager', change: 'also email on-call' }];
    expect(applyChanges([{ ops, kind: 'proposal' }], 'Change', { quiet: true, onApplied: (a) => (handed = a.agentChanges) })).toBe(true);
    expect(useEditor.getState().edges.length).toBe(edges);
    expect(handed).toEqual([{ agentId: 'ag_triage', change: 'also email on-call', nodeId: 'a' }]);
    expect(changeCard).toHaveBeenCalledWith({ agentId: 'ag_triage', change: 'also email on-call', nodeId: 'a' });
  });
});

// ---------------------------------------------------------------------------
// The open path
// ---------------------------------------------------------------------------

const legacy = (): Workflow => ({
  ...flow(),
  updatedAt: '2026-11-18T08:00:00.000Z',
  nodes: [...flow().nodes, node('mem', 'Window Memory', 'core.simpleMemory')],
  connections: [
    { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'a', targetIndex: 0 },
    { id: 'c-slug', type: 'ai_tool', source: 'slug', sourceIndex: 0, target: 'a', targetIndex: 0 },
    { id: 'c-mem', type: 'ai_memory', source: 'mem', sourceIndex: 0, target: 'a', targetIndex: 0 },
  ],
});
const movedRow: AgentMove = { workflowId: 'wf_ag17', nodeId: 'a', subNodeId: 'slug', name: 'Slugify', slot: 'tool', agentId: 'ag_triage', agentName: 'Alert triager', outcome: 'moved', as: 'tool', agentToolId: 't1', by: 'usr', at: '2026-11-18T09:00:00.000Z', state: 'pending' };
const keptRow: AgentMove = { workflowId: 'wf_ag17', nodeId: 'a', subNodeId: 'mem', name: 'Window Memory', slot: 'memory', agentId: 'ag_triage', agentName: 'Alert triager', outcome: 'kept', why: 'An agent remembers this conversation or across sessions: a memory node can’t move into it', by: 'usr', at: '2026-11-18T09:00:00.000Z' };

describe('the open path', () => {
  const posts: Array<{ updatedAt?: string }> = [];
  let conflicts = 0;
  let rows: AgentMove[];
  let updates: Array<{ agentId: string; pinned: number; latest: number }> = [];
  beforeEach(() => {
    updates = [];
    posts.length = 0;
    conflicts = 0;
    rows = [];
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (String(url).endsWith('/agent-moves') && init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          if (conflicts > 0) {
            conflicts--;
            return ok({ error: 'This workflow changed since you opened it', code: 'workflow_conflict' }, 412);
          }
          rows = [movedRow, keptRow];
          const result: AgentMoveResult = { workflowId: 'wf_ag17', moved: [movedRow], kept: [keptRow], agents: [{ id: 'ag_triage', name: 'Alert triager', draftDiffers: true }], updatedAt: '2026-11-18T09:00:01.000Z' };
          return ok(result);
        }
        if (String(url).endsWith('/agent-updates')) return ok({ updates });
        if (String(url).endsWith('/agent-moves')) return ok({ moves: rows });
        if (/\/api\/workflows\/wf_ag17$/.test(String(url))) return ok({ workflow: { ...legacy(), updatedAt: '2026-11-18T08:00:05.000Z' } });
        return ok({});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the move once with the loaded updatedAt; a tab without the lock, or a flow with nothing wired, posts nothing; a 412 reloads and posts once more', async () => {
    const result = await moveOnOpen(legacy());
    expect(posts).toEqual([{ updatedAt: '2026-11-18T08:00:00.000Z' }]);
    expect(result?.moved.map((m) => m.name)).toEqual(['Slugify']);
    expect(moveNoticeLines([...result!.moved, ...result!.kept], result!.agents)).toEqual([
      'Moved into Alert triager, not published yet: Slugify (tool).',
      `Kept in this flow: Window Memory. ${keptRow.why}`,
      'Alert triager has changes not published: the editor’s tests use them; publish Alert triager, then this workflow, to put them live.',
    ]);

    posts.length = 0;
    expect(await moveOnOpen(legacy(), () => Promise.resolve(false))).toBeUndefined();
    expect(await moveOnOpen(flow())).toBeUndefined();
    expect(posts).toEqual([]);

    conflicts = 1;
    const retried = await moveOnOpen(legacy());
    expect(posts).toEqual([{ updatedAt: '2026-11-18T08:00:00.000Z' }, { updatedAt: '2026-11-18T08:00:05.000Z' }]);
    expect(retried?.moved).toHaveLength(1);
  });

  describe('the notice and the pill', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      useEditLock.setState({ known: true, readOnly: false });
    });
    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });
    const mount = async () => {
      await act(async () => {
        root.render(createElement(AgentMovesNotice, { workflowId: 'wf_ag17' }));
        await new Promise((r) => setTimeout(r, 20));
      });
    };

    it('a live move whose production pin is older than the published version still says to publish this workflow', async () => {
      rows = [{ ...movedRow, state: 'live' } as AgentMove];
      updates = [{ agentId: 'ag_triage', pinned: 2, latest: 3 }];
      await mount();
      const text = container.querySelector('[data-testid="agent-moves-notice"]')!.textContent!;
      expect(text).toContain('Moved into Alert triager, published');
      expect(text).toContain('Publish this workflow to put it in production');
      // Production already runs the published version: nothing more to publish.
      act(() => root.unmount());
      root = createRoot(container);
      window.localStorage.clear();
      updates = [];
      await mount();
      expect(container.querySelector('[data-testid="agent-moves-notice"]')!.textContent).not.toContain('put it in production');
    });

    it('the publish line goes once the workflow is published, and another flow’s move event does not ask again', async () => {
      const { usePublication } = await import('@/components/editor/publish-control');
      rows = [{ ...movedRow, state: 'live' } as AgentMove];
      updates = [{ agentId: 'ag_triage', pinned: 2, latest: 3 }];
      usePublication.setState({ workflowId: 'wf_ag17', status: { published: { versionId: 'v1' } } } as never);
      await mount();
      expect(container.textContent).toContain('put it in production');
      const asked = () => (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).endsWith('/agent-updates')).length;
      const before = asked();
      await act(async () => {
        window.dispatchEvent(new CustomEvent('landflow:agent-moves-changed', { detail: { workflowId: 'wf_other' } }));
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(asked()).toBe(before);
      // Published: production now pins the latest, so the updates route no longer lists the agent.
      updates = [];
      await act(async () => {
        usePublication.setState({ workflowId: 'wf_ag17', status: { published: { versionId: 'v2' } } } as never);
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(container.textContent).not.toContain('put it in production');
      usePublication.setState({ workflowId: undefined, status: undefined } as never);
    });

    it('shows the lines the first time, folds to a pill when closed (the pill reopens the record), and a second open shows the pill only', async () => {
      rows = [movedRow, keptRow];
      await mount();
      const card = container.querySelector('[data-testid="agent-moves-notice"]')!;
      expect(card).toBeTruthy();
      expect(card.textContent).toContain('Moved into Alert triager, not published yet: Slugify (tool).');
      expect(card.textContent).toContain('Kept in this flow: Window Memory.');
      expect(card.textContent).toContain('Publish Alert triager');
      expect(card.textContent).toContain('Open Alert triager');
      expect(card.textContent).toMatch(/runs? in this flow only|stays here and runs in this flow only/);

      await act(async () => {
        (container.querySelector('[aria-label="Close"]') as HTMLButtonElement).click();
      });
      expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeNull();
      const pill = container.querySelector('[data-testid="agent-moves-pill"]') as HTMLButtonElement;
      expect(pill.textContent).toContain('Moved into agents · 1');
      await act(async () => pill.click());
      const record = container.querySelector('[data-testid="agent-moves-notice"]')!;
      expect(record.textContent).toContain('kept in this flow');
      expect(record.textContent).toContain('moved into Alert triager');

      // Closed and remembered: a later open (a new mount) shows the pill only.
      await act(async () => (container.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
      act(() => root.unmount());
      root = createRoot(container);
      await mount();
      expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-moves-pill"]')).toBeTruthy();
      // The pill sits left of the canvas toolbar's column (right-3, 36px wide), so Add node stays clickable.
      expect((container.querySelector('[data-testid="agent-moves-pill"]')!.parentElement as HTMLElement).className).toMatch(/\bright-14\b/);
      // On a phone it is an icon and a count at the top, left of the toolbar column: not over the toolbar's Add sticky
      // note (right-3, 44px buttons) nor the brain card (left-3 top-16), and the label stays for screen readers.
      const wrap = (container.querySelector('[data-testid="agent-moves-pill"]')!.parentElement as HTMLElement).className;
      expect(wrap).toMatch(/max-md:right-16\b/);
      expect(wrap).toMatch(/max-md:top-3\b/);
      expect(wrap).not.toMatch(/max-md:top-16|max-md:right-3\b/);
      expect(container.querySelector('[data-testid="agent-moves-pill"] .max-md\\:sr-only')).toBeTruthy();
    });

    it('on a phone it starts as the pill, opens on tap, and X goes back to the pill', async () => {
      const real = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: /max-width: 767px/.test(q), media: q, addEventListener() {}, removeEventListener() {} })) as never;
      try {
        rows = [movedRow, keptRow];
        await mount();
        expect(container.querySelector('[data-testid="agent-moves-notice"]'), 'no sheet over the canvas').toBeNull();
        await act(async () => (container.querySelector('[data-testid="agent-moves-pill"]') as HTMLButtonElement).click());
        expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeTruthy();
        await act(async () => (container.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
        expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeNull();
        expect(container.querySelector('[data-testid="agent-moves-pill"]')).toBeTruthy();
      } finally {
        window.matchMedia = real;
      }
    });

    it('on the desktop it opens expanded once per flow, is at most 300px wide, and a pointerdown on the canvas folds it to the pill', async () => {
      rows = [movedRow, keptRow];
      await mount();
      const card = container.querySelector('[data-testid="agent-moves-notice"]') as HTMLElement;
      expect(card).toBeTruthy();
      expect(card.className).toMatch(/w-\[300px\]/);
      // A pointerdown inside the card does nothing; one on the canvas folds it.
      const canvas = document.createElement('div');
      canvas.className = 'react-flow';
      const pane = document.createElement('div');
      canvas.append(pane);
      document.body.append(canvas);
      await act(async () => card.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeTruthy();
      await act(async () => pane.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeNull();
      expect(container.querySelector('[data-testid="agent-moves-pill"]')).toBeTruthy();
      canvas.remove();
      // Remembered for the flow: a new mount shows the pill only.
      act(() => root.unmount());
      root = createRoot(container);
      await mount();
      expect(container.querySelector('[data-testid="agent-moves-notice"]')).toBeNull();
    });
  });

  it('the lines follow the agent’s live state: published once the agent holds the item, not “not published yet”', () => {
    const base = { workflowId: 'w', nodeId: 'n', subNodeId: 's', name: 'Slugify', slot: 'tool', agentId: 'a', agentName: 'Crypto Toolkit', outcome: 'moved', as: 'tool', by: 'migration', at: 'x' } as never;
    expect(moveNoticeLines([{ ...(base as object), state: 'pending' } as never])).toEqual(['Moved into Crypto Toolkit, not published yet: Slugify (tool).']);
    expect(moveNoticeLines([{ ...(base as object), state: 'live' } as never])).toEqual(['Moved into Crypto Toolkit, published: Slugify (tool).']);
    expect(moveNoticeLines([{ ...(base as object), state: 'live' } as never], [], new Set(['a']))).toEqual(['Moved into Crypto Toolkit, published: Slugify (tool). Publish this workflow to put it in production.']);
    expect(moveNoticeLines([{ ...(base as object), state: 'pending' } as never], [], new Set(['a']))).toEqual(['Moved into Crypto Toolkit, not published yet: Slugify (tool).']);
    expect(moveNoticeLines([{ ...(base as object), state: 'withdrawn' } as never])).toEqual(['Moved into Crypto Toolkit, then taken out of its draft: Slugify (tool).']);
  });
});
