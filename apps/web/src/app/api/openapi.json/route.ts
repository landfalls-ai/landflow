/**
 * GET /api/openapi.json: the public API as an OpenAPI 3.1 document (lib/server/openapi.ts), for Settings → API, code
 * generators and coding agents. Its server URL is this instance's public origin. Any API key or session can read it.
 */
import { publicOrigin } from '@/lib/server/auth/cookies';
import { handler, json } from '@/lib/server/http';
import { openApiDocument } from '@/lib/server/openapi';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => json(openApiDocument(publicOrigin(request))));
