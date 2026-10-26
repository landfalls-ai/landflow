/**
 * GET /api/transports: the transport kinds this host knows (installed providers with their capabilities, and the
 * broker kinds whose driver hasn't landed yet) and the broker connections (Settings → Transports), each with the
 * plugins that have an endpoint on it. Reading is for everyone who reads workflows; changes go through
 * /api/transports/connections (owners and admins).
 */
import type { TransportsResponse } from '@/lib/shared/transports';
import { handler, json } from '@/lib/server/http';
import { transportsView } from '@/lib/server/transports/view';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(transportsView() satisfies TransportsResponse));
