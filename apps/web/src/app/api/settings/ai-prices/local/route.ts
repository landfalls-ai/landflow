/**
 * Settings → AI prices → Local models: the models seen in the last 30 days on a local provider (Ollama, called by
 * Landflow or through the gateway) with their calls and tokens, and the price that covers each, if any. The price
 * itself is saved through PUT /api/settings/ai-prices.
 *
 * GET → AiLocalModel[]
 */
import { localModels } from '@/lib/server/ai-usage/local-models';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(localModels()));
