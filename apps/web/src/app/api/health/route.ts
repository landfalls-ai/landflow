import { registry } from '@/lib/server/plugins/registry';
import { handler, json } from '@/lib/server/http';
import { resolvePrincipal } from '@/lib/server/auth/guard';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

/** The route is public (the CLI and scripts probe it), so counts go only to a caller with a valid session or API key. */
export const GET = handler(async (request: Request) => {
  // Resolving a key writes last_used_at; with the store down that throws, and the probe must still answer.
  let resolved: ReturnType<typeof resolvePrincipal> | undefined;
  try {
    resolved = resolvePrincipal(request);
  } catch {
    return json({ status: 'ok' });
  }
  if (!resolved.ok || !resolved.principal) return json({ status: 'ok' });
  const plugins = registry.list();
  return json({
    status: 'ok',
    plugins: plugins.length,
    online: plugins.filter((p) => p.status === 'online').length,
    nodeTypes: registry.nodeTypes().length,
    ...store.stats(),
  });
});
