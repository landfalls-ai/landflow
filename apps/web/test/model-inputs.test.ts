/**
 * Files and images as model inputs ("Include Binary as Input"): what each provider receives. Anthropic gets image
 * and document blocks, OpenAI-compatible APIs `image_url` / `file` parts, Ollama `images` (PDFs and text files read
 * into the prompt). Checked on the mappers and on whole runs (AI Agent, Basic LLM Chain, OpenAI node) against the
 * fake model servers.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelAttachment, Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeItem } from '@landflow/protocol';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-model-inputs-'));
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
const { attachmentKind, withoutAttachmentData } = await import('@/lib/server/nodes/attachments');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
const anthropic = credentials.create({ name: 'Fake Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG64 = PNG.toString('base64');

/** A one-page PDF that says `text` (offsets computed, so any reader takes it). */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const image: ModelAttachment = { kind: 'image', mimeType: 'image/png', data: PNG64, fileName: 'pixel.png' };
const document: ModelAttachment = { kind: 'document', mimeType: 'application/pdf', data: pdf('Invoice total 99 EUR').toString('base64'), fileName: 'invoice.pdf' };
const notes: ModelAttachment = { kind: 'document', mimeType: 'text/plain', data: Buffer.from('remember the milk').toString('base64'), fileName: 'notes.txt' };

describe('request shapes per provider', () => {
  it('Anthropic: image and document blocks before the question', () => {
    const [message] = toAnthropicMessages([{ role: 'user', content: 'What is this?', attachments: [image, document, notes] }]);
    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG64 } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.data }, title: 'invoice.pdf' },
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'remember the milk' }, title: 'notes.txt' },
        { type: 'text', text: 'What is this?' },
      ],
    });
    // Without files the content stays a string.
    expect(toAnthropicMessages([{ role: 'user', content: 'plain' }])[0]).toEqual({ role: 'user', content: 'plain' });
  });

  it('OpenAI-compatible: image_url data URLs, file parts for PDFs, text files inlined', () => {
    expect(openAiParts('What is this?', [image, document, notes])).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG64}` } },
      { type: 'file', file: { filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${document.data}` } },
      { type: 'text', text: '<document name="notes.txt">\nremember the milk\n</document>' },
      { type: 'text', text: 'What is this?' },
    ]);
  });

  it('Ollama: base64 `images`, PDFs and text files read into the prompt', async () => {
    const message = await toOllamaUser({ role: 'user', content: 'What is this?', attachments: [image, document, notes] });
    expect(message.images).toEqual([PNG64]);
    expect(message.content).toContain('<document name="invoice.pdf">');
    expect(message.content).toContain('Invoice total 99 EUR');
    expect(message.content).toContain('<document name="notes.txt">\nremember the milk\n</document>');
    expect(message.content.endsWith('What is this?')).toBe(true);
  });

  it('knows which files models can read, and memory keeps names without bytes', () => {
    expect(attachmentKind('image/jpeg')).toBe('image');
    expect(attachmentKind('application/pdf')).toBe('document');
    expect(attachmentKind('text/csv; charset=utf-8')).toBe('document');
    expect(attachmentKind('image/tiff')).toBeUndefined();
    expect(attachmentKind('application/zip')).toBeUndefined();
    const stripped = withoutAttachmentData({ role: 'user', content: 'q', attachments: [image] });
    expect(JSON.stringify(stripped)).not.toContain(PNG64);
    expect(JSON.stringify(stripped)).toContain('pixel.png');
  });
});

// ---------------------------------------------------------------------------
// Whole runs: a manual trigger item with files → the node → the fake provider
// ---------------------------------------------------------------------------

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
const openAiModelNode = () => node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } });

async function runWithFiles(id: string, nodes: WorkflowNode[], connections: Workflow['connections'], files: Array<{ name: string; mimeType: string; data: Buffer; property?: string }>) {
  const workflow: Workflow = { id, name: id, nodes: [node('Start', 'core.manualTrigger'), ...nodes], connections };
  store.saveWorkflow(workflow);
  const executionId = newExecutionId();
  const binary: NonNullable<NodeItem['binary']> = {};
  for (const [index, file] of files.entries()) binary[file.property ?? `data${index}`] = await storeBinary(executionId, file.data, { mimeType: file.mimeType, fileName: file.name });
  return runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start', executionId, triggerItems: [{ json: { question: 'Describe the file' }, binary }] });
}

const lastUser = (path: string) => {
  const body = fake.last(path)!.body;
  return body.messages.findLast((m: { role: string }) => m.role === 'user');
};

describe('“Include Binary as Input” on whole runs', () => {
  it('AI Agent + OpenAI-compatible model: the image goes along as image_url', async () => {
    const record = await runWithFiles(
      'wf_inputs_agent_openai',
      [node('Agent', 'core.aiAgent', { prompt: '{{ $json.question }}', options: { passthroughBinaryImages: true } }), openAiModelNode()],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }],
    );
    expect(record.status).toBe('success');
    expect(lastUser('/v1/chat/completions').content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG64}` } },
      { type: 'text', text: 'Describe the file' },
    ]);
  });

  it('AI Agent + Anthropic: image and PDF blocks through the official SDK', async () => {
    const record = await runWithFiles(
      'wf_inputs_agent_anthropic',
      [
        node('Agent', 'core.aiAgent', { prompt: '{{ $json.question }}', options: { passthroughBinaryImages: true } }),
        node('Model', 'core.anthropicChatModel', { model: 'claude-test', effort: 'low', maxTokens: 1024, fallback: false }, { credentials: { anthropicApi: { id: anthropic.id, name: anthropic.name } } }),
      ],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [
        { name: 'pixel.png', mimeType: 'image/png', data: PNG },
        { name: 'invoice.pdf', mimeType: 'application/pdf', data: pdf('Invoice') },
      ],
    );
    expect(record.status).toBe('success');
    const content = lastUser('/v1/messages').content;
    expect(content.map((block: { type: string }) => block.type)).toEqual(['image', 'document', 'text']);
    expect(content[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG64 });
    expect(content[1]).toMatchObject({ source: { type: 'base64', media_type: 'application/pdf' }, title: 'invoice.pdf' });
  });

  it('AI Agent + Ollama: images in `images`', async () => {
    const record = await runWithFiles(
      'wf_inputs_agent_ollama',
      [node('Agent', 'core.aiAgent', { prompt: '{{ $json.question }}', options: { passthroughBinaryImages: true } }), node('Model', 'core.ollamaChatModel', { baseUrl: fake.origin, model: 'qwen3.8:latest' })],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }],
    );
    expect(record.status).toBe('success');
    expect(lastUser('/api/chat')).toEqual({ role: 'user', content: 'Describe the file', images: [PNG64] });
  });

  it('Basic LLM Chain: only the named binary field', async () => {
    const record = await runWithFiles(
      'wf_inputs_chain',
      [node('Chain', 'core.chainLlm', { prompt: '{{ $json.question }}', options: { passthroughBinaryImages: true, binaryPropertyNames: 'receipt' } }), openAiModelNode()],
      [edge('Start', 'Chain'), edge('Model', 'Chain', 'ai_languageModel')],
      [
        { name: 'other.png', mimeType: 'image/png', data: PNG, property: 'other' },
        { name: 'receipt.txt', mimeType: 'text/plain', data: Buffer.from('2 coffees'), property: 'receipt' },
      ],
    );
    expect(record.status).toBe('success');
    expect(lastUser('/v1/chat/completions').content).toEqual([
      { type: 'text', text: '<document name="receipt.txt">\n2 coffees\n</document>' },
      { type: 'text', text: 'Describe the file' },
    ]);
  });

  it('OpenAI node (Message a Model): files join the last user message', async () => {
    const record = await runWithFiles(
      'wf_inputs_openai_node',
      [
        node(
          'OpenAI',
          'core.openAi',
          { resource: 'text', operation: 'message', modelId: 'gpt-test', messages: { values: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: '{{ $json.question }}' }] }, options: { passthroughBinaryImages: true } },
          { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } },
        ),
      ],
      [edge('Start', 'OpenAI')],
      [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }],
    );
    expect(record.status).toBe('success');
    const body = fake.last('/v1/chat/completions')!.body;
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief' });
    expect(body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG64}` } });
  });

  it('sends nothing extra with the option off, and fails clearly on a missing named field', async () => {
    const off = await runWithFiles(
      'wf_inputs_off',
      [node('Agent', 'core.aiAgent', { prompt: '{{ $json.question }}' }), openAiModelNode()],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }],
    );
    expect(off.status).toBe('success');
    expect(lastUser('/v1/chat/completions').content).toBe('Describe the file');

    const missing = await runWithFiles(
      'wf_inputs_missing',
      [node('Agent', 'core.aiAgent', { prompt: '{{ $json.question }}', options: { passthroughBinaryImages: true, binaryPropertyNames: 'photo' } }), openAiModelNode()],
      [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
      [{ name: 'pixel.png', mimeType: 'image/png', data: PNG }],
    );
    expect(missing.status).toBe('error');
    expect(missing.error!.message).toContain('The item has no binary field “photo”');
  });
});
