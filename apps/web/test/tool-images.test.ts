/**
 * Images in tool results (docs/specs/18, phase 1): a tool returns `{ text, images }` (or a node item with an image in
 * its binary data), the model sees the newest N images (Anthropic: inside the tool_result; Ollama and OpenAI-compatible:
 * a synthetic user message), non-vision models get the text and a note, and memory, the run record and the stream keep
 * references and size labels, never base64. Fake model servers only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { defineNode, definePlugin } from '@landflow/sdk';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-tool-images-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { singleton } = await import('@/lib/server/singleton');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { hydrateToolImages, modelSeesImages } = await import('@/lib/server/nodes/tool-images');
const { toAnthropicMessages, toOpenAiMessages } = await import('@/lib/server/nodes/models');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** Every call makes a different image, so the test can tell which ones reached the model. */
let shots = 0;
const nextShot = () => Buffer.concat([PNG, Buffer.from([++shots])]);
const shotBase64 = (n: number) => Buffer.concat([PNG, Buffer.from([n])]).toString('base64');

// A tool that returns { text, images } with inline bytes (what the Desktop node will do).
const shotTool = defineNode({
  description: { name: 'shotTool', displayName: 'Shot tool', description: 'Test', version: 1, kind: 'subnode', supplies: 'ai_tool', inputs: [], outputs: [{ type: 'ai_tool' }], properties: [] },
  supplyData: (ctx) => ({
    name: ctx.getNode().name,
    description: 'Take a screenshot',
    inputSchema: { type: 'object', properties: {} },
    invoke: async () => ({ text: 'a screenshot', images: [{ mimeType: 'image/png', data: nextShot().toString('base64') }] }),
  }),
});
// A node usable as a tool that attaches a PNG to item.binary (what the Browser node's Screenshot does).
const shotNode = defineNode({
  description: { name: 'shotNode', displayName: 'Shot node', description: 'Test', version: 1, kind: 'action', usableAsTool: true, toolDescription: 'Take a screenshot', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    const ref = await ctx.helpers.prepareBinaryData(nextShot(), 'page.png', 'image/png');
    return [[{ json: { url: 'https://example.test', title: 'Example' }, binary: { data: ref } }]];
  },
});
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(definePlugin({ info: { id: 'imgtest', name: 'Image test', version: '0.0.1', description: 'test', icon: 'lucide:image', color: '#000', author: 'test' }, nodes: [shotTool, shotNode] }));

/** The model calls `shot` this many times, then answers. */
let toolTurns = 3;
let calls = 0;
const fake = await startFakeModels({
  reply: () => (calls++ < toolTurns ? { toolCalls: [{ id: `call_${calls}`, name: 'shot', arguments: {} }] } : { text: 'all done' }),
});
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
const anthropic = credentials.create({ name: 'Fake Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });

beforeEach(() => {
  shots = 0;
  calls = 0;
  toolTurns = 3;
  fake.requests.length = 0;
});

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_memory' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

const models = {
  anthropic: () => node('Model', 'core.anthropicChatModel', { model: 'claude-test', effort: 'low', maxTokens: 1024, fallback: false }, { credentials: { anthropicApi: { id: anthropic.id, name: anthropic.name } } }),
  ollama: (model = 'qwen3.8') => node('Model', 'core.ollamaChatModel', { baseUrl: fake.origin, model, temperature: 0 }),
  openai: (model = 'gpt-4o-mini') => node('Model', 'core.openAiChatModel', { model }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } }),
};
const PATH = { anthropic: '/v1/messages', ollama: '/api/chat', openai: '/v1/chat/completions' };

let counter = 0;
async function runAgent(model: WorkflowNode, options: Record<string, unknown> = {}, extra: { tool?: 'tool' | 'node'; memory?: boolean } = {}) {
  const id = `wf_tool_images_${++counter}`;
  const toolNode = extra.tool === 'node' ? node('shot', 'imgtest.shotNode') : node('shot', 'imgtest.shotTool');
  const wf: Workflow = {
    id,
    name: id,
    nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.aiAgent', { prompt: 'Look at the screen', options: { sessionId: 's1', ...options } }, model.credentials ? { credentials: model.credentials } : {}), model, toolNode, ...(extra.memory ? [node('Memory', 'core.simpleMemory', { turns: 10 })] : [])],
    connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('shot', 'Agent', 'ai_tool'), ...(extra.memory ? [edge('Memory', 'Agent', 'ai_memory')] : [])],
  };
  store.saveWorkflow(wf);
  const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
  expect(record.status, JSON.stringify(record.error)).toBe('success');
  return record;
}

const lastBody = (provider: keyof typeof PATH) => fake.last(PATH[provider])!.body;

/** Every base64 image the last request carried, per provider. */
function imagesIn(provider: keyof typeof PATH): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (v.type === 'image' && v.source && typeof (v.source as { data?: unknown }).data === 'string') found.push((v.source as { data: string }).data);
      if (v.type === 'image_url') found.push(String((v.image_url as { url: string }).url).split(',')[1]);
      if (provider === 'ollama' && Array.isArray(v.images)) found.push(...(v.images as string[]));
      Object.values(v).forEach(walk);
    }
  };
  walk(lastBody(provider).messages);
  return found;
}

describe('what each provider receives', () => {
  it('Anthropic: a text block and an image block inside the tool_result, the newest two images only', async () => {
    await runAgent(models.anthropic());
    const messages = lastBody('anthropic').messages;
    const results = messages.filter((m: { role: string; content: unknown }) => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type: string }>)[0].type === 'tool_result').map((m: { content: unknown[] }) => m.content[0] as { content: unknown });
    expect(results).toHaveLength(3);
    // The newest result: text, then the image, inside the tool_result.
    expect(results[2].content).toEqual([
      { type: 'text', text: 'a screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shotBase64(3) } },
    ]);
    expect(results[1].content).toEqual([
      { type: 'text', text: 'a screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shotBase64(2) } },
    ]);
    // The oldest was dropped: text and a note, no image.
    expect(typeof results[0].content).toBe('string');
    expect(results[0].content).toContain('a screenshot');
    expect(results[0].content).toContain('only the last 2');
    expect(imagesIn('anthropic')).toEqual([shotBase64(2), shotBase64(3)]);
  });

  it('Ollama: the tool message is text, then a user message carries the images; the setting changes N', async () => {
    await runAgent(models.ollama(), { toolImagesKept: 1 });
    const messages = lastBody('ollama').messages;
    const tools = messages.filter((m: { role: string }) => m.role === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools.every((m: { content: string; images?: unknown }) => typeof m.content === 'string' && m.images === undefined)).toBe(true);
    const index = messages.findLastIndex((m: { role: string }) => m.role === 'tool');
    expect(messages[index + 1]).toMatchObject({ role: 'user', images: [shotBase64(3)] });
    expect(imagesIn('ollama')).toEqual([shotBase64(3)]);
  });

  it('OpenAI-compatible: image_url parts in a user message after the tool message, newest two by default', async () => {
    await runAgent(models.openai());
    const messages = lastBody('openai').messages;
    const index = messages.findLastIndex((m: { role: string }) => m.role === 'tool');
    expect(messages[index].content).toBe('a screenshot');
    expect(messages[index + 1].role).toBe('user');
    expect(messages[index + 1].content).toEqual([
      { type: 'text', text: expect.stringContaining('shot') },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${shotBase64(3)}` } },
    ]);
    expect(imagesIn('openai')).toEqual([shotBase64(2), shotBase64(3)]);
  });

  it('a node whose item has an image in binary (the Browser Screenshot) reaches the model as an image', async () => {
    toolTurns = 1;
    await runAgent(models.anthropic(), {}, { tool: 'node' });
    const result = lastBody('anthropic').messages.at(-1).content[0];
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ url: 'https://example.test', title: 'Example' }) });
    expect(result.content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shotBase64(1) } });
  });
});

describe('models that cannot see', () => {
  it('get the text and a clear note, not an error (Ollama, OpenAI-compatible, or by setting)', async () => {
    toolTurns = 1;
    await runAgent(models.ollama('qwen3-coder:30b'));
    expect(imagesIn('ollama')).toEqual([]);
    expect(lastBody('ollama').messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/a screenshot\n\[1 image\(s\).*qwen3-coder:30b can’t see images/) });

    calls = 0;
    await runAgent(models.openai('gpt-3.5-turbo'));
    expect(imagesIn('openai')).toEqual([]);
    expect(lastBody('openai').messages.at(-1).content).toContain('can’t see images');

    calls = 0;
    await runAgent(models.anthropic(), { toolImages: 'text' });
    expect(imagesIn('anthropic')).toEqual([]);
    expect(JSON.stringify(lastBody('anthropic').messages.at(-1))).toContain('can’t see images');
  });

  it('knows which models see', () => {
    expect(modelSeesImages({ provider: 'anthropic', model: 'claude-x' })).toBe(true);
    expect(modelSeesImages({ provider: 'ollama', model: 'qwen3.8:latest' })).toBe(true);
    expect(modelSeesImages({ provider: 'ollama', model: 'qwen3-coder:30b' })).toBe(false);
    expect(modelSeesImages({ provider: 'openai', model: 'gpt-4o' })).toBe(true);
  });
});

describe('references, never base64, in memory, the run record and the stream', () => {
  it('keeps references in memory and the journal, and the stream gets a size label', async () => {
    const memoryStore = singleton('agent-memory', () => new Map<string, unknown>());
    memoryStore.clear();
    const record = await runAgent(models.openai(), {}, { memory: true });
    const everything = JSON.stringify(record);
    const saved = JSON.stringify([...memoryStore.values()]);
    for (const n of [1, 2, 3]) {
      expect(saved).not.toContain(shotBase64(n));
      expect(everything).not.toContain(shotBase64(n));
      // The PNG's own bytes in base64 (the shared prefix) appear nowhere either.
      expect(saved).not.toContain(PNG.toString('base64').slice(0, 40));
    }
    // Memory holds the references: the images can be loaded again.
    expect(saved).toContain('"ref"');
    expect(saved).toContain('"images"');
    // The journal's steps say what was returned: type and size.
    const steps = (record.runData.Agent.at(-1)!.outputs[0][0].json as { steps: Array<{ images?: Array<{ mimeType: string; size: number; ref?: string }> }> }).steps;
    expect(steps[0].images?.[0]).toMatchObject({ mimeType: 'image/png', size: expect.any(Number), ref: expect.any(String) });
  });

  it('a later turn loads the remembered images again from their references, still newest N', async () => {
    const memoryStore = singleton('agent-memory', () => new Map<string, unknown>());
    memoryStore.clear();
    // Turn 1 takes one screenshot; turn 2 (same workflow and session) takes two more.
    const id = 'wf_tool_images_memory';
    const wf = (): Workflow => ({
      id,
      name: id,
      nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.aiAgent', { prompt: 'Look', options: { sessionId: 's' } }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } }), models.openai(), node('shot', 'imgtest.shotTool'), node('Memory', 'core.simpleMemory', { turns: 10 })],
      connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('shot', 'Agent', 'ai_tool'), edge('Memory', 'Agent', 'ai_memory')],
    });
    toolTurns = 1;
    store.saveWorkflow(wf());
    await runWorkflow({ workflow: wf(), mode: 'manual', startNodeId: 'Start' });
    calls = 0;
    toolTurns = 2;
    await runWorkflow({ workflow: wf(), mode: 'manual', startNodeId: 'Start' });
    // Three screenshots in the history now; only the newest two reach the model.
    expect(imagesIn('openai')).toEqual([shotBase64(2), shotBase64(3)]);
  });
});

describe('the converters and hydration', () => {
  const result = { id: 'c1', name: 'shot', content: 'text', images: [{ mimeType: 'image/png', data: 'AAAA' }] };

  it('text-only results are unchanged', () => {
    expect(toAnthropicMessages([{ role: 'tool', results: [{ id: 'c', name: 'n', content: 'plain' }] }])).toEqual([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'plain' }] }]);
    expect(toOpenAiMessages(undefined, [{ role: 'tool', results: [{ id: 'c', name: 'n', content: 'plain' }] }])).toEqual([{ role: 'tool', tool_call_id: 'c', content: 'plain' }]);
  });

  it('a reference without bytes sends no image block', () => {
    const bare = { ...result, images: [{ mimeType: 'image/png', ref: { id: 'x.y', mimeType: 'image/png', fileSize: 4 } }] };
    expect(toAnthropicMessages([{ role: 'tool', results: [bare] }])).toEqual([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'text' }] }]);
  });

  it('hydration reads references, does not change its input, and counts newest first across turns', async () => {
    const reads: string[] = [];
    const ctx = {
      logger: { warn: () => undefined },
      helpers: { binaryToBuffer: async (ref: { id?: string }) => (reads.push(ref.id!), Buffer.from(ref.id!)) },
    } as never;
    const image = (id: string) => ({ mimeType: 'image/png', ref: { id, mimeType: 'image/png', fileSize: 1 } });
    const input = [
      { role: 'tool' as const, results: [{ id: 'a', name: 't', content: 'one', images: [image('old')] }] },
      { role: 'tool' as const, results: [{ id: 'b', name: 't', content: 'two', images: [image('mid')] }, { id: 'c', name: 't', content: 'three', images: [image('new')] }] },
    ];
    const out = await hydrateToolImages(ctx, input, { model: { provider: 'openai', model: 'gpt-4o' }, keep: 2 });
    expect(reads.sort()).toEqual(['mid', 'new']);
    expect((out[0] as { results: Array<{ images?: unknown; content: string }> }).results[0].images).toBeUndefined();
    expect((out[1] as { results: Array<{ images?: Array<{ data: string }> }> }).results[1].images![0].data).toBe(Buffer.from('new').toString('base64'));
    expect(JSON.stringify(input)).not.toContain('"data"');
  });
});
