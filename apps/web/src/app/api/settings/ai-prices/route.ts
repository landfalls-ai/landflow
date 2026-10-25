/**
 * Settings → AI prices: the price table token costs are estimated with (lib/server/ai-usage/prices.ts). The
 * built-in defaults (Anthropic and OpenAI list prices) and the instance's overrides, which win per model.
 *
 * GET → { defaults, overrides }; PUT { overrides: [{ provider, model, input, output }] } (USD per million tokens).
 */
import { z } from 'zod';
import { aiUsageMeter, priceTable, savePriceOverrides } from '@/lib/server/ai-usage';
import { priceOverridesSchema } from '@/lib/server/ai-usage/prices';
import { handler, json, parseBody } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(priceTable()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ overrides: priceOverridesSchema }));
  if (!body.ok) return body.response;
  savePriceOverrides(body.data.overrides);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'ai-prices', name: 'AI prices' }, details: { overrides: Object.keys(body.data.overrides ?? {}).length } });
  // Costs of the next calls use the new prices at once.
  aiUsageMeter().invalidatePrices();
  return json(priceTable());
});
