/**
 * Audio and video as model inputs, and files kept by memory: `input_audio` parts for OpenAI-compatible audio models,
 * transcription through an OpenAI-compatible /audio/transcriptions endpoint for the rest, video where a provider
 * accepts it (a clear error naming the model otherwise), and memory that re-attaches earlier turns' files up to a cap.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelAttachment, Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeItem } from '@landflow/protocol';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-model-media-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { newExecutionId, runWorkflow } = await import('@/lib/server/runner');
const { storeBinary } = await import('@/lib/server/binary/access');
const { openAiParts, toAnthropicMessages, toOllamaUser } = await import('@/lib/server/nodes/models');
const { withoutAttachmentData, attachmentKind } = await import('@/lib/server/nodes/attachments');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
const anthropic = credentials.create({ name: 'Fake Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });

/** A fake /audio/transcriptions server: replies with the file name as the "transcript". */
const transcriptions: Array<{ authorization?: string; body: string }> = [];
const transcriber: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('latin1');
  transcriptions.push({ authorization: req.headers.authorization, body });
  if (req.url !== '/v1/audio/transcriptions') {
    res.writeHead(404).end('no such route');
    return;
  }
  const name = /filename="([^"]+)"/.exec(body)?.[1] ?? '?';
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: `hello from ${name}` }));
});
await new Promise<void>((resolve) => transcriber.listen(0, '127.0.0.1', resolve));
const transcribeUrl = `http://127.0.0.1:${(transcriber.address() as AddressInfo).port}/v1`;

afterAll(async () => {
  await fake.close();
  await new Promise<void>((resolve) => transcriber.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40, 1)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 2)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 3)]);
const MP4 = Buffer.concat([Buffer.from('....ftypisom'), Buffer.alloc(40, 4)]);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_memory' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
const openAiModelNode = (model: string) => node('Model', 'core.openAiChatModel', { model }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } });
const withCredential = { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } };

async function runItem(id: string, nodes: WorkflowNode[], connections: Workflow['connections'], files: Array<{ name: string; mimeType: string; data: Buffer; property?: string }>, json: Record<string, unknown> = { question: 'What is this?' }) {
  const workflow: Workflow = { id, name: id, nodes: [node('Start', 'core.manualTrigger'), ...nodes], connections };
  store.saveWorkflow(workflow);
  const executionId = newExecutionId();
  const binary: NonNullable<NodeItem['binary']> = {};
  for (const [index, file] of files.entries()) binary[file.property ?? `data${index}`] = await storeBinary(executionId, file.data, { mimeType: file.mimeType, fileName: file.name });
  return runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start', executionId, triggerItems: [{ json, ...(files.length && { binary }) }] });
}

const lastUser = (path = '/v1/chat/completions') => fake.last(path)!.body.messages.findLast((m: { role: string }) => m.role === 'user');
const agent = (options: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}) =>
  node('Agent', 'core.aiAgent', { prompt: '{{ $json.question }}', options: { passthroughBinaryImages: true, ...options } }, { ...withCredential, ...extra });

describe('request shapes', () => {
  const audio: ModelAttachment = { kind: 'audio', mimeType: 'audio/wav', data: WAV.toString('base64'), fileName: 'note.wav' };
  const video: ModelAttachment = { kind: 'video', mimeType: 'video/mp4', data: MP4.toString('base64'), fileName: 'clip.mp4' };

  it('OpenAI-compatible: input_audio for wav and mp3, video_url for video', () => {
    expect(openAiParts('Say', [audio, { ...audio, mimeType: 'audio/mpeg', data: MP3.toString('base64') }, video])).toEqual([
      { type: 'input_audio', input_audio: { data: audio.data, format: 'wav' } },
      { type: 'input_audio', input_audio: { data: MP3.toString('base64'), format: 'mp3' } },
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${video.data}` } },
      { type: 'text', text: 'Say' },
    ]);
    expect(() => openAiParts('x', [{ ...audio, mimeType: 'audio/ogg' }])).toThrow(/wav or mp3/);
  });

  it('Anthropic and Ollama refuse audio and video', async () => {
    expect(() => toAnthropicMessages([{ role: 'user', content: 'q', attachments: [audio] }])).toThrow(/Anthropic models can’t take audio input/);
    await expect(toOllamaUser({ role: 'user', content: 'q', attachments: [video] })).rejects.toThrow(/Ollama models can’t take video input/);
  });

  it('classifies audio and video MIME types', () => {
    expect(attachmentKind('audio/ogg')).toBe('audio');
    expect(attachmentKind('video/webm')).toBe('video');
  });
});

describe('audio on whole runs', () => {
  it('sends wav to an audio model as input_audio', async () => {
    const record = await runItem('wf_audio_send', [agent(), openAiModelNode('gpt-4o-audio-preview')], [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')], [{ name: 'note.wav', mimeType: 'audio/wav', data: WAV }]);
    expect(record.status).toBe('success');
    expect(lastUser().content).toEqual([
      { type: 'input_audio', input_audio: { data: WAV.toString('base64'), format: 'wav' } },
      { type: 'text', text: 'What is this?' },
    ]);
  });

  it('transcribes for a model without audio: the transcript replaces the file', async () => {
    transcriptions.length = 0;
    const record = await runItem(
      'wf_audio_transcribe',
      [agent({ transcriptionUrl: transcribeUrl, transcriptionModel: 'whisper-test' }), openAiModelNode('gpt-4o-mini')],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'voice.ogg', mimeType: 'audio/ogg', data: OGG }],
    );
    expect(record.status).toBe('success');
    expect(transcriptions).toHaveLength(1);
    expect(transcriptions[0].body).toContain('whisper-test');
    // The node's OpenAI credential supplies the key.
    expect(transcriptions[0].authorization).toBe('Bearer sk-test');
    expect(lastUser().content).toEqual([
      { type: 'text', text: '<document name="voice.ogg (transcript)">\nhello from voice.ogg\n</document>' },
      { type: 'text', text: 'What is this?' },
    ]);
  });

  it('can be told to transcribe even for an audio model, and works for Anthropic', async () => {
    transcriptions.length = 0;
    const record = await runItem(
      'wf_audio_anthropic',
      [
        agent({ audioHandling: 'transcribe', transcriptionUrl: transcribeUrl }),
        node('Model', 'core.anthropicChatModel', { model: 'claude-test', effort: 'low', maxTokens: 1024, fallback: false }, { credentials: { anthropicApi: { id: anthropic.id, name: anthropic.name } } }),
      ],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'note.wav', mimeType: 'audio/wav', data: WAV }],
    );
    expect(record.status).toBe('success');
    expect(transcriptions).toHaveLength(1);
    const content = fake.last('/v1/messages')!.body.messages.findLast((m: { role: string }) => m.role === 'user').content;
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'text', data: expect.stringContaining('hello from note.wav') } });
  });

  it('fails clearly without a transcription endpoint, naming the model', async () => {
    // No OpenAI credential on the agent node, no endpoint: nothing to transcribe with.
    const record = await runItem('wf_audio_none', [agent({}, { credentials: undefined }), openAiModelNode('gpt-4o-mini')], [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')], [{ name: 'note.wav', mimeType: 'audio/wav', data: WAV }]);
    expect(record.status).toBe('error');
    expect(record.error!.message).toContain('openai/gpt-4o-mini can’t take audio input (note.wav) and no transcription endpoint is set');
  });

  it('shows the transcription endpoint’s error', async () => {
    const record = await runItem('wf_audio_404', [agent({ transcriptionUrl: `${transcribeUrl}/missing` }), openAiModelNode('gpt-4o-mini')], [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')], [{ name: 'note.wav', mimeType: 'audio/wav', data: WAV }]);
    expect(record.status).toBe('error');
    expect(record.error!.message).toMatch(/Transcribing note\.wav failed \(404\)/);
  });
});

describe('video on whole runs', () => {
  it('sends video to a model that accepts it', async () => {
    const record = await runItem('wf_video_ok', [agent(), openAiModelNode('gemini-2.5-flash')], [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')], [{ name: 'clip.mp4', mimeType: 'video/mp4', data: MP4 }]);
    expect(record.status).toBe('success');
    expect(lastUser().content[0]).toEqual({ type: 'video_url', video_url: { url: `data:video/mp4;base64,${MP4.toString('base64')}` } });
  });

  it('names the model when it does not take video', async () => {
    const other = await runItem('wf_video_no', [agent(), openAiModelNode('gpt-4o-mini')], [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')], [{ name: 'clip.mp4', mimeType: 'video/mp4', data: MP4 }]);
    expect(other.status).toBe('error');
    expect(other.error!.message).toContain('openai/gpt-4o-mini isn’t known to take video input (clip.mp4)');
    // "Send to the Model" overrides the name check for servers that accept it.
    const forced = await runItem('wf_video_forced', [agent({ videoHandling: 'send' }), openAiModelNode('my-local-vlm')], [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')], [{ name: 'clip.mp4', mimeType: 'video/mp4', data: MP4 }]);
    expect(forced.status).toBe('success');
    const anthropicRun = await runItem(
      'wf_video_anthropic',
      [agent(), node('Model', 'core.anthropicChatModel', { model: 'claude-test', effort: 'low', maxTokens: 1024, fallback: false }, { credentials: { anthropicApi: { id: anthropic.id, name: anthropic.name } } })],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'clip.mp4', mimeType: 'video/mp4', data: MP4 }],
    );
    expect(anthropicRun.status).toBe('error');
    expect(anthropicRun.error!.message).toContain('anthropic/claude-test can’t take video input');
  });
});

describe('files in memory', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const memory = () => node('Memory', 'core.simpleMemory', { turns: 10 });
  const nodes = (options: Record<string, unknown>) => [agent({ sessionId: 'room-1', ...options }), openAiModelNode('gpt-4o-mini'), memory()];
  const wires = [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('Memory', 'Agent', 'ai_memory')];

  it('keeps references, and attaches the files again on the next turn when asked', async () => {
    const id = 'wf_memory_files';
    const first = await runItem(id, nodes({ rememberedAttachments: true }), wires, [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }], { question: 'Look at this' });
    expect(first.status).toBe('success');
    const second = await runItem(id, nodes({ rememberedAttachments: true }), wires, [], { question: 'What color was it?' });
    expect(second.status).toBe('success');
    const messages = fake.last('/v1/chat/completions')!.body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(messages).toHaveLength(2);
    // The earlier turn's image is back, without the "[attached: …]" note.
    expect(messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
      { type: 'text', text: 'Look at this' },
    ]);
    expect(messages[1].content).toBe('What color was it?');
    // A third turn still has it: the references survived the second save.
    await runItem(id, nodes({ rememberedAttachments: true }), wires, [], { question: 'And now?' });
    expect(fake.last('/v1/chat/completions')!.body.messages.find((m: { role: string }) => m.role === 'user').content[0].type).toBe('image_url');
  });

  it('keeps only the note with the option off', async () => {
    const id = 'wf_memory_files_off';
    await runItem(id, nodes({}), wires, [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }], { question: 'Look at this' });
    await runItem(id, nodes({}), wires, [], { question: 'What color was it?' });
    const first = fake.last('/v1/chat/completions')!.body.messages.find((m: { role: string }) => m.role === 'user');
    expect(first.content).toBe('Look at this\n[attached: pixel.png]');
  });

  it('respects the size cap: the newest files go first, the rest are skipped', async () => {
    const id = 'wf_memory_files_cap';
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024, 7)]);
    await runItem(id, nodes({ rememberedAttachments: true, rememberedAttachmentsMaxMb: 1 }), wires, [{ name: 'old.png', mimeType: 'image/png', data: big }], { question: 'first' });
    await runItem(id, nodes({ rememberedAttachments: true, rememberedAttachmentsMaxMb: 1 }), wires, [{ name: 'new.png', mimeType: 'image/png', data: big }], { question: 'second' });
    await runItem(id, nodes({ rememberedAttachments: true, rememberedAttachmentsMaxMb: 1 }), wires, [], { question: 'third' });
    const users = fake.last('/v1/chat/completions')!.body.messages.filter((m: { role: string }) => m.role === 'user');
    // 1 MB fits one 600 KB file: the newer one (second turn); the first turn keeps its note only.
    expect(Array.isArray(users[1].content)).toBe(true);
    expect(users[0].content).toBe('first\n[attached: old.png]');
  });

  it('skips files whose stored data is gone', async () => {
    const id = 'wf_memory_files_gone';
    await runItem(id, nodes({ rememberedAttachments: true }), wires, [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }], { question: 'Look at this' });
    const { deleteExecutionBinary } = await import('@/lib/server/binary/access');
    const first = store.listExecutions({ workflowId: id } as never) as Array<{ id: string }>;
    for (const execution of first) await deleteExecutionBinary(execution.id);
    const second = await runItem(id, nodes({ rememberedAttachments: true }), wires, [], { question: 'What color was it?' });
    expect(second.status).toBe('success');
    expect(lastUserOf()).toContain('[attached: pixel.png]');
  });

  it('withoutAttachmentData keeps references and merges with earlier ones', () => {
    const ref = { id: 'ex1.abc', mimeType: 'image/png', fileSize: 10, fileName: 'a.png' };
    const kept = withoutAttachmentData({ role: 'user' as const, content: 'q', attachments: [{ kind: 'image' as const, mimeType: 'image/png', data: 'x', fileName: 'a.png', ref }] });
    expect(kept).toEqual({ role: 'user', content: 'q\n[attached: a.png]', files: [{ ref, fileName: 'a.png' }] });
    // Re-saving a rehydrated turn where only some files came back keeps all references.
    const other = { id: 'ex1.def', mimeType: 'image/png', fileSize: 10 };
    const again = withoutAttachmentData({ ...kept, attachments: [{ kind: 'image' as const, mimeType: 'image/png', data: 'x', fileName: 'a.png', ref }], files: [...kept.files, { ref: other }] });
    expect(again.files).toHaveLength(2);
  });
});

function lastUserOf(path = '/v1/chat/completions'): string {
  const users = fake.last(path)!.body.messages.filter((m: { role: string }) => m.role === 'user');
  return JSON.stringify(users[0].content);
}
