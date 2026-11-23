/**
 * GET /api/health/live: the liveness probe. It does no I/O and does not wait for boot or a dependency, so a slow
 * database does not restart a healthy process. It does not go through `handler()`, which waits for boot and answers
 * 503 while draining. Next itself holds every request until instrumentation `register()` resolves, and that awaits
 * boot, so in a running host neither probe answers before boot ends; the Kubernetes startupProbe covers a slow boot.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }, { headers: { 'cache-control': 'no-store' } });
}
