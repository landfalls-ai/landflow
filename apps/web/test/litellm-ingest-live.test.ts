/**
 * The spend import against a real LiteLLM (opt-in: LANDFLOW_INTEGRATION=litellm, the compose profile up with Ollama serving
 * qwen3-coder:30b). Run by the integrator:
 *   LANDFLOW_INTEGRATION=litellm LANDFLOW_LLM_GATEWAY_URL=http://127.0.0.1:54100 LANDFLOW_LLM_GATEWAY_ADMIN_KEY=<master key from deploy/.env.example> \
 *     npx vitest run test/litellm-ingest-live.test.ts
 * It mints a key for a made-up agent, makes one call with it directly (as kagent would), waits for LiteLLM's spend row, imports
 * twice and expects exactly one ai_usage row. The key is blocked at the end (never deleted).
 */
import { describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('litellm'));
const MODEL = process.env.LANDFLOW_LITELLM_MODEL ?? 'qwen3-coder:30b';

describe.skipIf(!enabled)('the spend import against LiteLLM', () => {
  it('counts a call made with an agent’s runtime key once', async () => {
    const { database } = await import('@/lib/server/db');
    const { gatewayConnection, adminClient } = await import('@/lib/server/llm-gateway/settings');
    const { ensureRuntimeKey, blockRuntimeKeys } = await import('@/lib/server/llm-gateway/runtime-keys');
    const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
    const connection = await gatewayConnection();
    expect(connection?.adminKey, 'set LANDFLOW_LLM_GATEWAY_URL and LANDFLOW_LLM_GATEWAY_ADMIN_KEY').toBeTruthy();
    const admin = adminClient(connection)!;

    const agentId = `ag_live_${Date.now().toString(36)}`;
    const { key, alias } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: MODEL });
    try {
      const reply = await fetch(`${connection!.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 16 }),
      });
      expect(reply.status).toBe(200);
      const callId = reply.headers.get('x-litellm-call-id');
      expect(callId).toBeTruthy();

      // LiteLLM writes spend in batches: wait for the row.
      let found = false;
      for (let i = 0; i < 30 && !found; i++) {
        found = Boolean(await admin.spendLog(callId!));
        if (!found) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(found, `LiteLLM wrote no spend row for ${alias} within 30 s`).toBe(true);

      // The import stops a minute before `now`: look from a minute ahead.
      const now = Date.now() + 90_000;
      await importSpend({ now });
      await importSpend({ now: now + 1000 });
      const rows = database().all<{ agent_id: string; source: string; runtime: string; call_id: string }>('SELECT agent_id, source, runtime, call_id FROM ai_usage WHERE call_id = ?', callId!);
      expect(rows).toEqual([{ agent_id: agentId, source: 'litellm', runtime: 'kagent', call_id: callId! }]);
    } finally {
      await blockRuntimeKeys(agentId);
    }
  }, 90_000);
});
