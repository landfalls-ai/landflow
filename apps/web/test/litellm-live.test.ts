/**
 * Landflow's own calls through a real LiteLLM (the compose profile of docs/llm-gateway.md) and Ollama with
 * qwen3-coder:30b. Skipped unless LANDFLOW_INTEGRATION names litellm:
 *   LANDFLOW_INTEGRATION=litellm npx vitest run test/litellm-live.test.ts
 * LANDFLOW_TEST_LITELLM_URL (default http://127.0.0.1:54100) and LANDFLOW_TEST_LITELLM_MASTER_KEY (the development master
 * key). Mints a throwaway virtual key and blocks it at the end (never deletes).
 */
import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('litellm'));
const URL_ = process.env.LANDFLOW_TEST_LITELLM_URL ?? 'http://127.0.0.1:54100';
const MASTER = process.env.LANDFLOW_TEST_LITELLM_MASTER_KEY ?? 'sk-landflow-dev-master-only';
const MODEL = 'qwen3-coder:30b';

vi.setConfig({ testTimeout: 180_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-litellm-live-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
if (enabled) Object.assign(process.env, ENV);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe.skipIf(!enabled)('LiteLLM live: Landflow calls through the gateway', () => {
  it('answers, keeps the call id and the response id on the ai_usage row, shows the end user, and is not imported again', async () => {
    const { database } = await import('@/lib/server/db');
    const { executionScope, runInUsageScope } = await import('@/lib/server/ai-usage');
    const { LiteLlmClient } = await import('@/lib/server/llm-gateway/client');
    const { anthropicModel, openAiConnection, openAiModel } = await import('@/lib/server/nodes/models');
    const admin = new LiteLlmClient({ baseUrl: URL_, key: MASTER });
    const minted = await admin.generateKey({ key_alias: `landflow-test-${randomBytes(4).toString('hex')}` });
    const userId = `u_live_${randomBytes(3).toString('hex')}`;
    const turn = { messages: [{ role: 'user' as const, content: 'Say hello in one word.' }], tools: [] };
    try {
      const scope = () => executionScope({ executionId: `ex_live_${randomBytes(3).toString('hex')}`, workflowId: 'wf_live', userId });
      const anthropic = anthropicModel({ model: MODEL, effort: 'low', maxTokens: 64, fallback: true, apiKey: minted.key, baseUrl: URL_, gateway: 'litellm' });
      const openai = openAiModel(openAiConnection({ baseUrl: `${URL_}/v1`, apiKey: minted.key, gateway: 'litellm' }), { model: MODEL });
      // Plain and streamed: a stream's response id is message_start's (Anthropic) or the first chunk's (OpenAI).
      for (const model of [anthropic, openai]) {
        for (const streamed of [false, true]) {
          const reply = await runInUsageScope(scope(), () => model.generate({ ...turn, ...(streamed && { onToken: () => undefined }) }));
          expect(reply.text.length).toBeGreaterThan(0);
        }
      }
      const rows = database().all<{ call_id: string | null; gateway_request_id: string | null; source: string }>("SELECT call_id, gateway_request_id, source FROM ai_usage WHERE user_id = ? ORDER BY at", userId);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.call_id).toBeTruthy();
        expect(row.source).toBe('landflow');
        // LiteLLM writes spend in batches: wait for the row.
        let log;
        for (let attempt = 0; attempt < 15 && !log; attempt++) {
          log = await admin.spendLog(row.call_id!);
          if (!log) await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        expect(log?.end_user).toBe(`landflow-user-${userId}`);
        // The spend import pairs the two by this id.
        expect(row.gateway_request_id).toBe(log?.request_id);
        expect(log?.metadata?.spend_logs_metadata).toMatchObject({ landflow: 'in-process' });
      }
      if (process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY) {
        const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
        await importSpend({ now: Date.now() + 90_000 });
        const ids = rows.map((row) => row.gateway_request_id!);
        const imported = database().all<{ id: string }>(`SELECT id FROM ai_usage WHERE source = 'litellm' AND gateway_request_id IN (${ids.map(() => '?').join(',')})`, ...ids);
        expect(imported).toEqual([]);
      }
    } finally {
      await admin.blockKey(minted.key);
    }
  });
});
