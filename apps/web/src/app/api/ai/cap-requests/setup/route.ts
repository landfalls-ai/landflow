/**
 * The cap-raise flow (docs/llm-gateway.md#asking-for-a-higher-cap).
 *
 * GET  /api/ai/cap-requests/setup → `{ workflowId?, active }`.
 * POST /api/ai/cap-requests/setup (admins) installs the cap-raise template once into the admin's home project, publishes
 * and activates it, and answers the setup; a second POST answers the existing one. The admin's click is the person in
 * the loop for turning it on.
 */
import { capRaiseSetup, installCapRaise } from '@/lib/server/llm-gateway/cap-requests';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(capRaiseSetup()));

export const POST = handler(async () => json(await installCapRaise(routeActor())));
