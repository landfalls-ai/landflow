import { registry } from '@/lib/server/plugins/registry';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  await registry.refresh((await params).id);
  return json({ plugins: registry.list() });
});
