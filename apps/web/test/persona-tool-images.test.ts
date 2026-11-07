/**
 * Images tools return, in the persona runtime (agents/runtime.ts): a node tool's screenshot (item.binary) and a flow tool's
 * { text, images } reach a model that sees (the newest N, by reference), a text-only model gets a note, and the transcript,
 * the timeline and the journal hold references and labels, never base64. Images over the limits are scaled down (sharp)
 * or skipped. Scripted models, no network.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const seen: Array<{ messages: AgentMessage[] }> = [];
let modelName = 'qwen3.8';

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (): LanguageModel => ({
    provider: 'ollama',
    model: modelName,
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
const { fitImage } = await import('@/lib/server/nodes/tool-images');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let shots = 0;
const nextShot = () => Buffer.concat([PNG, Buffer.from([++shots])]);
const shotBase64 = (n: number) => Buffer.concat([PNG, Buffer.from([n])]).toString('base64');

const shotNode = defineNode({
  description: { name: 'personaShot', displayName: 'Persona shot', description: 'Test', version: 1, kind: 'action', usableAsTool: true, toolDescription: 'Take a screenshot', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    const ref = await ctx.helpers.prepareBinaryData(nextShot(), 'page.png', 'image/png');
    return [[{ json: { title: 'Example' }, binary: { data: ref } }]];
  },
});

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(definePlugin({ info: { id: 'personatest', name: 'Persona test', version: '0.0.1', description: 'test', icon: 'lucide:image', color: '#000', author: 'test' }, nodes: [shotNode] }));
});
beforeEach(() => {
  script.length = 0;
  seen.length = 0;
  shots = 0;
  modelName = 'qwen3.8';
});

const makeAgent = (config: Partial<AgentConfig> = {}): Agent =>
  agentStore.create({ name: 'Looker', instructions: 'Look.', model: { provider: 'ollama', model: 'x' }, tools: [{ id: 't1', type: 'node', name: 'Shot', description: 'Take a screenshot', nodeType: 'personatest.personaShot', parameters: {} }], ...config });
const callShot = (id: string): Step => () => ({ toolCalls: [{ id, name: 'Shot', input: {} }] });
const imagesOf = (messages: AgentMessage[]) => messages.flatMap((m) => (m.role === 'tool' ? m.results.flatMap((r) => (r.images ?? []).map((i) => i.data)) : []));
const start = (agent: Agent) => newSession(agent, { source: 'test', userId: 'u', version: 'draft' });

describe('tool images in the persona runtime', () => {
  it('shows the newest images only, by reference, and keeps base64 out of the session', async () => {
    const agent = makeAgent();
    script.push(callShot('c1'), callShot('c2'), callShot('c3'), () => ({ text: 'done' }));
    const result = await runAgent({ agent, session: start(agent), message: 'look' });
    expect(result.reason).toBe('completed');
    // Last turn: the newest two (default 2) shots, the oldest dropped with a note.
    const last = seen.at(-1)!.messages;
    expect(imagesOf(last)).toEqual([shotBase64(2), shotBase64(3)]);
    expect(JSON.stringify(last.find((m) => m.role === 'tool'))).toContain('earlier image(s) omitted');
    // The saved session, its timeline and its transcript hold references and labels, not bytes.
    const saved = JSON.stringify(agentStore.getSession(result.session.id));
    for (let n = 1; n <= 3; n++) expect(saved).not.toContain(shotBase64(n));
    const tool = result.session.timeline.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ status: 'success', output: { result: { title: 'Example' }, images: [expect.stringContaining('image/png')] } });
  });

  it('keeps as many as the run asks for', async () => {
    const agent = makeAgent();
    script.push(callShot('c1'), callShot('c2'), () => ({ text: 'done' }));
    await runAgent({ agent, session: start(agent), message: 'look', toolImages: { keep: 1 } });
    expect(imagesOf(seen.at(-1)!.messages)).toEqual([shotBase64(2)]);
  });

  it('tells a text-only model instead of sending the image', async () => {
    modelName = 'deepseek-coder';
    const agent = makeAgent();
    script.push(callShot('c1'), () => ({ text: 'done' }));
    await runAgent({ agent, session: start(agent), message: 'look' });
    expect(imagesOf(seen.at(-1)!.messages)).toEqual([]);
    expect(JSON.stringify(seen.at(-1)!.messages)).toContain('can’t see images');
  });

  it('runs a flow tool that returns { text, images }', async () => {
    const agent = makeAgent({ tools: [] });
    script.push(() => ({ toolCalls: [{ id: 'f1', name: 'Chart', input: {} }] }), () => ({ text: 'done' }));
    const tool = { name: 'Chart', description: 'A chart', inputSchema: { type: 'object' as const, properties: {} }, invoke: async () => ({ text: 'a chart', images: [{ mimeType: 'image/png', data: PNG.toString('base64') }] }) };
    const result = await runAgent({ agent, session: start(agent), message: 'chart', flow: { tools: [tool] } });
    expect(imagesOf(seen.at(-1)!.messages)).toEqual([PNG.toString('base64')]);
    expect(JSON.stringify(agentStore.getSession(result.session.id))).not.toContain(PNG.toString('base64'));
  });
});

describe('image limits', () => {
  it('scales a big PNG down to the longest side', async () => {
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#336699' } }).png().toBuffer();
    const fitted = await fitImage(big.toString('base64'), 'image/png');
    if ('skipped' in fitted) throw new Error(fitted.skipped);
    const meta = await sharp(Buffer.from(fitted.data, 'base64')).metadata();
    expect(meta.width).toBe(1568);
    expect(meta.height).toBe(523);
  });

  it('leaves a small image alone, and skips one over the byte limit it cannot shrink', async () => {
    expect(await fitImage(PNG.toString('base64'), 'image/png')).toMatchObject({ data: PNG.toString('base64') });
    const raw = Buffer.alloc(300 * 300 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919 + (i >> 3) * 31) & 255;
    const noise = await sharp(raw, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer();
    expect(await fitImage(noise.toString('base64'), 'image/png', { maxBytes: 1000 })).toHaveProperty('skipped');
  });
});
