/**
 * Tool images, the leftovers: an agent's own "Tool images to keep" setting, a plain chat's images living as long as its
 * session, and the Run Trace tool span carrying image references (never bytes) for the AI Agent's tools, node tools and
 * the persona runtime. Scripted models, no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { AgentMessage, ExecutionEvent, LanguageModel, ModelTurn, ToolSpec, Workflow, WorkflowNode } from '@landflow/engine';
import { DEFAULT_AGENT_SETTINGS, type Agent, type AgentConfig } from '@/lib/shared/agents';
import type { JournalDraft } from '@/lib/shared/run-trace';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-finish-images-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const seen: Array<{ messages: AgentMessage[] }> = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (): LanguageModel => ({
    provider: 'ollama',
    model: 'qwen3.8',
    async generate(input) {
      seen.push({ messages: structuredClone(input.messages) });
      const step = script.shift();
      if (!step) throw new Error('The script ran out of turns');
      return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, ...step(input) };
    },
  }),
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { sessionScope } = await import('@/lib/server/agents/session-images');
const { binaryStore, sweepBinaryData } = await import('@/lib/server/binary/access');
const { createTranslator, journalOf, journalStore, releaseJournal, resetJournals } = await import('@/lib/server/journal');
const { imagesOf, imageLabel, withoutImages } = await import('@/components/run-trace/tool-images');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let shots = 0;
const shotNode = defineNode({
  description: { name: 'finishShot', displayName: 'Finish shot', description: 'Test', version: 1, kind: 'action', usableAsTool: true, toolDescription: 'Take a screenshot', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    const ref = await ctx.helpers.prepareBinaryData(Buffer.concat([PNG, Buffer.from([++shots])]), 'page.png', 'image/png');
    return [[{ json: { title: 'Example' }, binary: { data: ref } }]];
  },
});

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(definePlugin({ info: { id: 'finishtest', name: 'Finish test', version: '0.0.1', description: 'test', icon: 'lucide:image', color: '#000', author: 'test' }, nodes: [shotNode] }));
});
beforeEach(() => {
  script.length = 0;
  seen.length = 0;
  shots = 0;
});
afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const makeAgent = (config: Partial<AgentConfig> = {}): Agent =>
  agentStore.create({ name: 'Looker', instructions: 'Look.', model: { provider: 'ollama', model: 'x' }, tools: [{ id: 't1', type: 'node', name: 'Shot', description: 'Take a screenshot', nodeType: 'finishtest.finishShot', parameters: {} }], ...config });
const callShot = (id: string): Step => () => ({ toolCalls: [{ id, name: 'Shot', input: {} }] });
const imageCount = (messages: AgentMessage[]) => messages.flatMap((m) => (m.role === 'tool' ? m.results.flatMap((r) => r.images ?? []) : [])).length;
const start = (agent: Agent) => newSession(agent, { source: 'test', userId: 'u', version: 'draft' });

describe('an agent’s Tool images to keep setting', () => {
  it('is used when the run does not set one, and the run wins when it does', async () => {
    const agent = makeAgent({ settings: { ...DEFAULT_AGENT_SETTINGS, toolImagesKept: 1 } });
    script.push(callShot('c1'), callShot('c2'), callShot('c3'), () => ({ text: 'done' }));
    await runAgent({ agent, session: start(agent), message: 'look' });
    expect(imageCount(seen.at(-1)!.messages)).toBe(1);

    seen.length = 0;
    script.push(callShot('c1'), callShot('c2'), callShot('c3'), () => ({ text: 'done' }));
    await runAgent({ agent, session: start(agent), message: 'look', toolImages: { keep: 3 } });
    expect(imageCount(seen.at(-1)!.messages)).toBe(3);
  });

  it('falls back to LANDFLOW_TOOL_IMAGES_KEPT, then 2', async () => {
    const agent = makeAgent();
    script.push(callShot('c1'), callShot('c2'), callShot('c3'), () => ({ text: 'done' }));
    await runAgent({ agent, session: start(agent), message: 'look' });
    expect(imageCount(seen.at(-1)!.messages)).toBe(2);
    seen.length = 0;
    process.env.LANDFLOW_TOOL_IMAGES_KEPT = '1';
    try {
      script.push(callShot('c1'), callShot('c2'), () => ({ text: 'done' }));
      await runAgent({ agent, session: start(agent), message: 'look' });
      expect(imageCount(seen.at(-1)!.messages)).toBe(1);
    } finally {
      delete process.env.LANDFLOW_TOOL_IMAGES_KEPT;
    }
  });

  it('is accepted by the agent API schema and defaults to unset', () => {
    expect(DEFAULT_AGENT_SETTINGS.toolImagesKept).toBeUndefined();
  });
});

describe('a plain chat’s images', () => {
  it('live under the session, which the sweep keeps for hours, until the session is deleted', async () => {
    const agent = makeAgent();
    const session = start(agent);
    script.push(callShot('c1'), () => ({ text: 'done' }));
    const result = await runAgent({ agent, session, message: 'look' });
    const scope = sessionScope(result.session.id);
    const store = await binaryStore();
    expect((await store.scopes()).map((s) => s.scope)).toContain(scope);
    const tool = result.session.timeline.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ images: [{ mimeType: 'image/png', ref: expect.any(String) }] });

    // Two hours on, with no execution owning the scope: it is still there.
    expect(await sweepBinaryData(() => false, 3_600_000, Date.now() + 2 * 3_600_000)).toBe(0);
    expect((await store.scopes()).map((s) => s.scope)).toContain(scope);

    // The session goes: so do its images.
    agentStore.saveSession(result.session);
    expect(agentStore.deleteSession(agent.id, result.session.id)).toBe(true);
    await vi.waitFor(async () => expect((await store.scopes()).map((s) => s.scope)).not.toContain(scope));
  });

  it('a run in a workflow execution still keeps its images with the execution', async () => {
    const agent = makeAgent();
    const session = { ...start(agent), execution: { workflowId: 'wf_x', executionId: 'ex_images_1', nodeId: 'n1' } };
    script.push(callShot('c1'), () => ({ text: 'done' }));
    await runAgent({ agent, session, message: 'look' });
    const store = await binaryStore();
    expect((await store.scopes()).map((s) => s.scope)).toContain('ex_images_1');
    expect((await store.scopes()).map((s) => s.scope)).not.toContain(sessionScope(session.id));
  });
});

describe('Run Trace tool span images', () => {
  it('a persona tool call carries its image references in the span output, not bytes', async () => {
    const { agentSessionJournal } = await import('@/lib/server/journal/agent-session');
    const journal = journalOf('ex_img_agent', { workflowId: 'wf_a' });
    journal.bindSpans((nodeId) => (nodeId === 'agentnode' ? 'node:agentnode:0' : undefined));
    const entry = agentSessionJournal({ execution: { workflowId: 'wf_a', executionId: 'ex_img_agent', nodeId: 'agentnode' } }, { id: 'ag_1', name: 'Analyst' });
    entry({ id: 't1', type: 'tool', callId: 'c1', tool: 'Shot', label: 'Shot', kind: 'node', input: {}, status: 'success', output: 'ok\n[image: image/png, 74 KB]', images: [{ mimeType: 'image/png', size: 75_776, ref: 'abc123' }], at: '2026-11-07T10:00:00.000Z' } as never);
    releaseJournal('ex_img_agent');
    const ended = journalStore.read('ex_img_agent').find((e) => e.type === 'span.ended' && e.spanId.endsWith('c1'));
    expect(ended).toMatchObject({ output: { text: 'ok\n[image: image/png, 74 KB]', images: [{ mimeType: 'image/png', size: 75_776, ref: 'abc123' }] } });
    expect(imagesOf((ended as { output: unknown }).output)).toHaveLength(1);
  });

  const flow: Workflow = {
    id: 'wf_img',
    name: 'img',
    nodes: [{ id: 'agent', name: 'AI Agent', type: 'core.aiAgent', typeVersion: 1, position: [0, 0], parameters: {} } as WorkflowNode, { id: 'shot', name: 'Browser Screenshot', type: 'browser.browser', typeVersion: 1, position: [0, 0], parameters: {} } as WorkflowNode],
    connections: [],
  };
  const feed = (outputs: unknown) => {
    const drafts: JournalDraft[] = [];
    const translator = createTranslator({ workflow: flow, executionId: 'ex_img', emit: (d) => drafts.push(d) });
    const base = { executionId: 'ex_img', at: '2026-11-07T10:00:01.000Z' };
    translator.feed({ type: 'execution.started', executionId: 'ex_img', workflowId: flow.id, mode: 'manual', at: base.at } as ExecutionEvent);
    translator.feed({ type: 'node.started', ...base, nodeId: 'agent', nodeName: 'AI Agent', source: 'main' } as ExecutionEvent);
    translator.feed({ type: 'node.started', ...base, nodeId: 'shot', nodeName: 'Browser Screenshot', source: 'tool', parentNodeId: 'agent' } as ExecutionEvent);
    translator.feed({ type: 'node.finished', ...base, nodeId: 'shot', nodeName: 'Browser Screenshot', source: 'tool', parentNodeId: 'agent', status: 'success', durationMs: 5, itemCounts: [1], run: { startedAt: base.at, durationMs: 5, status: 'success', source: 'tool', inputs: [[]], outputs } } as unknown as ExecutionEvent);
    return drafts.find((d) => d.type === 'span.ended' && d.spanId.includes('shot'));
  };

  it('a node tool’s screenshot (item.binary) becomes an image reference on the span', () => {
    const ended = feed([[{ json: { title: 'Example' }, binary: { data: { id: 'bin_1', mimeType: 'image/png', fileSize: 4096, fileName: 'page.png' } } }]]);
    expect(ended).toMatchObject({ output: { title: 'Example', images: [{ mimeType: 'image/png', size: 4096, ref: 'bin_1' }] } });
    expect(JSON.stringify(ended)).not.toContain('base64');
  });

  it('a tool without images, and a flow tool that already lists them, are left as they were', () => {
    expect(feed([[{ json: { title: 'Plain' } }]])).toMatchObject({ output: { title: 'Plain' } });
    expect((feed([[{ json: { title: 'Plain' } }]]) as { output: Record<string, unknown> }).output).not.toHaveProperty('images');
    const flowOutput = feed([[{ json: { text: 'chart', images: [{ mimeType: 'image/png', size: 10, ref: 'f1' }] } }]]);
    expect(flowOutput).toMatchObject({ output: { text: 'chart', images: [{ ref: 'f1' }] } });
  });

  it('the panel reads the references, labels them and shows the rest of the output', () => {
    const output = { text: 'ok', images: [{ mimeType: 'image/png', size: 75_776, ref: 'abc' }, { mimeType: 'text/plain', size: 1 }] };
    expect(imagesOf(output)).toEqual([{ mimeType: 'image/png', size: 75_776, ref: 'abc' }]);
    expect(imageLabel(imagesOf(output)[0])).toBe('[image: image/png, 74 KB]');
    expect(withoutImages(output)).toBe('ok');
    expect(withoutImages({ title: 'x', images: [{ mimeType: 'image/png', size: 1, ref: 'a' }] })).toEqual({ title: 'x' });
    expect(withoutImages({ title: 'x' })).toEqual({ title: 'x' });
    expect(imagesOf('text')).toEqual([]);
  });
});
