/**
 * The AI page's month-end forecast (docs/llm-gateway.md, "The AI page"): the month's total of what the caller can see
 * and each cap and budget they may see, with where it is heading. Money for cost caps, tokens for token caps.
 *
 * GET
 */
import { aiForecast } from '@/lib/server/ai-usage/forecast';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(aiForecast(routeActor())));
