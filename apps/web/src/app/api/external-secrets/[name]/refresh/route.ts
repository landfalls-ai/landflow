/** POST /api/external-secrets/:name/refresh — reconnect, list the secret names again and forget cached values. */
import { handler, json } from '@/lib/server/http';
import { externalSecrets } from '@/lib/server/secrets';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ name: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  return json(await externalSecrets.refresh((await params).name));
});
