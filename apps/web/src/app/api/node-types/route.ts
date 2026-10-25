import { registry } from '@/lib/server/plugins/registry';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ nodeTypes: registry.nodeTypes() }));
