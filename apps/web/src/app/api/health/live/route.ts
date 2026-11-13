/**
 * GET /api/health/live: the liveness probe. It does no I/O and does not wait for boot, so it answers while the host
 * starts and while a dependency is down (a slow database must not restart a healthy process). That is why it does not
 * go through `handler()`, which waits for boot and answers 503 while draining.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }, { headers: { 'cache-control': 'no-store' } });
}
