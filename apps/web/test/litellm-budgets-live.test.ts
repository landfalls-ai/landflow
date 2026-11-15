/**
 * The cap stop at the gateway, against a real LiteLLM (opt-in: LANDFLOW_INTEGRATION=litellm; compose profile up, Ollama
 * with qwen3-coder:30b). A made-up user's cap of $0.000001 a day is mirrored by the budgets sync; the second call as that
 * end user is refused by LiteLLM with a budget error. Then the cap goes, the sync clears the budget and the throwaway key
 * is blocked (nothing is deleted).
 *
 *   LANDFLOW_INTEGRATION=litellm LANDFLOW_LLM_GATEWAY_URL=http://127.0.0.1:54100 LANDFLOW_LLM_GATEWAY_ADMIN_KEY=<master key> \
 *     npx vitest run test/litellm-budgets-live.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('litellm'));
const MODEL = 'qwen3-coder:30b';

vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!enabled)('LiteLLM budgets (live)', () => {
  it('refuses the second call of a user over the mirrored cap, then lifts the budget', async () => {
    const baseUrl = (process.env.LANDFLOW_LLM_GATEWAY_URL ?? 'http://127.0.0.1:54100').replace(/\/+$/, '');
    const master = process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY ?? '';
    expect(master, 'set LANDFLOW_LLM_GATEWAY_ADMIN_KEY to the master key').not.toBe('');
    Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ll-live-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_LLM_GATEWAY_URL: baseUrl, LANDFLOW_LLM_GATEWAY_ADMIN_KEY: master });

    const { syncBudgets } = await import('@/lib/server/llm-gateway/sync');
    const { adminClient, gatewayConnection } = await import('@/lib/server/llm-gateway/settings');
    const { saveAiCaps } = await import('@/lib/server/ai-usage');
    const { createUser } = await import('@/lib/server/auth/users');
    const { LITELLM_IDS } = await import('@/lib/shared/llm-gateway');

    const user = await createUser({ email: 'live-user@example.test', name: 'Live User', role: 'member', password: 'password-123' });
    const client = adminClient(await gatewayConnection())!;
    const customerId = LITELLM_IDS.customer(user.id);
    const throwaway = await client.generateKey({ key_alias: `landflow-live-${user.id}`, models: [MODEL] });

    const call = () =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${throwaway.key}`, 'x-litellm-end-user-id': customerId },
        body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'Say ok.' }] }),
      });

    try {
      saveAiCaps({ credentials: {}, users: { [user.id]: { dayCost: 0.000001 } } });
      const report = await syncBudgets({ trigger: 'manual', capIds: [`user:${user.id}:day:cost`] });
      expect(report.errors).toEqual([]);
      expect((await client.customerInfo(customerId))?.max_budget).toBeGreaterThan(0);

      expect((await call()).ok).toBe(true);
      // LiteLLM books the spend a moment later; the second call finds the budget spent.
      await vi.waitFor(async () => {
        const refused = await call();
        expect(refused.ok).toBe(false);
        expect(await refused.text()).toMatch(/budget/i);
      }, { timeout: 60_000, interval: 3_000 });

      saveAiCaps({ credentials: {}, users: {} });
      await syncBudgets({ trigger: 'manual', capIds: [`user:${user.id}:day:cost`] });
      expect((await client.customerInfo(customerId))?.max_budget ?? null).toBeNull();
    } finally {
      // Nothing is deleted: the throwaway key is blocked.
      await client.blockKey(throwaway.key);
    }
  });
});
