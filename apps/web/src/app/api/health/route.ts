import { registry } from '@/lib/server/plugins/registry';
import { handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const plugins = registry.list();
  return json({
    status: 'ok',
    plugins: plugins.length,
    online: plugins.filter((p) => p.status === 'online').length,
    nodeTypes: registry.nodeTypes().length,
    ...store.stats(),
  });
});
