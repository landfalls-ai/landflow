/** GET /api/environment/variables — every variable's per-environment values: `{ environment?, values: { KEY: { env: value } } }`. */
import { currentEnvironment, environmentValues } from '@/lib/server/environments';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const environment = currentEnvironment();
  return json({ ...(environment && { environment }), values: environmentValues.all() });
});
