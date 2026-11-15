/**
 * The LLM gateway's health and models (docs/llm-gateway.md). Everyone signed in gets the health and the models; owners
 * and admins also get where the gateway is and what the spend import and the budgets sync last did. Never a key.
 */
import { handler, json } from '@/lib/server/http';
import { gatewayStatus } from '@/lib/server/llm-gateway/status';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(await gatewayStatus(routeActor())));
