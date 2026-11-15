/**
 * The LiteLLM budgets sync (docs/llm-gateway.md, "Budgets in LiteLLM").
 *
 * GET → { report? } the last sync; POST → runs one now and answers its report. Admins only (lib/server/auth/policy.ts).
 */
import { handler, json } from '@/lib/server/http';
import { lastSyncReport } from '@/lib/server/llm-gateway/settings';
import { syncBudgets } from '@/lib/server/llm-gateway/sync';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ report: lastSyncReport() }));

export const POST = handler(async () => json({ report: await syncBudgets({ trigger: 'manual' }) }));
