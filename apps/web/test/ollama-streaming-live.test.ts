/**
 * Streamed replies against a real Ollama (qwen3-coder:30b):
 *   LANDFLOW_INTEGRATION=ollama npx vitest run test/ollama-streaming-live.test.ts
 * OLLAMA_URL picks the server (default http://127.0.0.1:11434); LANDFLOW_OLLAMA_CHAT_MODEL the chat model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { readSse } from './fake-ai-services';

const enabled = process.env.LANDFLOW_INTEGRATION?.split(',').includes('ollama');
const baseUrl = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const chatModel = process.env.LANDFLOW_OLLAMA_CHAT_MODEL ?? 'qwen3-coder:30b';
const LIVE_TIMEOUT = 300_000;

describe.skipIf(!enabled)('live: streaming from Ollama', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ollama-stream-'));
  const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
  const previousEnv = { ...process.env };
  Object.assign(process.env, ENV);
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  const { store } = await import('@/lib/server/store');
  const { ollamaModel } = await import('@/lib/server/nodes/models');
  const runRoute = await import('@/app/api/workflows/[id]/run/route');
  registry.registerBuiltin(corePlugin);

  afterAll(() => {
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it(
    'the adapter hands out tokens as they arrive',
    async () => {
      const tokens: Array<{ at: number; text: string }> = [];
      const turn = await ollamaModel({ baseUrl, model: chatModel, temperature: 0 }).generate({
        messages: [{ role: 'user', content: 'Count from one to ten in words, separated by commas. Nothing else.' }],
        tools: [],
        onToken: (text) => tokens.push({ at: Date.now(), text }),
      });
      expect(tokens.length).toBeGreaterThan(5);
      expect(tokens.map((t) => t.text).join('').trim()).toBe(turn.text.trim());
      expect(turn.text.toLowerCase()).toContain('ten');
      // Spread over time, not one burst at the end.
      expect(tokens.at(-1)!.at - tokens[0].at).toBeGreaterThan(20);
      expect(turn.usage!.outputTokens).toBeGreaterThan(5);
    },
    LIVE_TIMEOUT,
  );

  it(
    'an AI Agent streams its tool call and answer through the Chat trigger (run route SSE)',
    async () => {
      const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
      const workflow: Workflow = {
        id: 'wf_live_stream',
        name: 'Live stream',
        nodes: [
          node('Chat', 'core.chatTrigger'),
          node('Agent', 'core.aiAgent', { prompt: '{{ $json.chatInput }}', systemMessage: 'Use the calculator tool for arithmetic, then answer in one short sentence.' }),
          node('Model', 'core.ollamaChatModel', { baseUrl, model: chatModel, temperature: 0 }),
          node('Calculator', 'core.calculatorTool'),
        ],
        connections: [
          { id: 'e1', type: 'main', source: 'Chat', target: 'Agent', sourceIndex: 0, targetIndex: 0 },
          { id: 'e2', type: 'ai_languageModel', source: 'Model', target: 'Agent', sourceIndex: 0, targetIndex: 0 },
          { id: 'e3', type: 'ai_tool', source: 'Calculator', target: 'Agent', sourceIndex: 0, targetIndex: 0 },
        ],
      };
      store.saveWorkflow(workflow);
      const response = await runRoute.POST(
        new Request('http://live.test/api/workflows/wf_live_stream/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message: 'What is 1234 * 5678?' } }) }),
        { params: Promise.resolve({ id: 'wf_live_stream' }) },
      );
      const events = await readSse(response);
      const result = events.find((e) => e.event === 'result')!.data;
      expect(result.status).toBe('success');
      const chunks = events.filter((e) => e.event === 'execution' && e.data.type === 'node.chunk').map((e) => e.data.chunk);
      expect(chunks.filter((c) => c.type === 'tool').map((c) => c.tool.status)).toEqual(expect.arrayContaining(['started', 'finished']));
      const items = chunks.filter((c) => c.type === 'item');
      expect(items.length).toBeGreaterThan(3);
      expect(items.map((c) => c.content).join('').replace(/[,\s]/g, '')).toContain('7006652');
      // Local models are tracked and cost nothing.
      const record = store.getExecution(result.executionId)!;
      expect(record.aiUsage).toMatchObject({ cost: 0, models: [{ provider: 'ollama', model: chatModel }] });
      expect(record.aiUsage!.calls).toBeGreaterThanOrEqual(2);
    },
    LIVE_TIMEOUT,
  );
});
