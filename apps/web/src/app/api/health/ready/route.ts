/**
 * GET /api/health/ready: the readiness probe (Kubernetes readiness, Docker HEALTHCHECK, the queue load balancer).
 * Outside `handler()` on purpose: `handler()` waits for boot and answers draining requests itself, while this route
 * must answer 503 during boot and drain instead of waiting. The body names the checks and nothing else.
 */
import { readiness } from '@/lib/server/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { ready, checks } = await readiness();
  return Response.json({ status: ready ? 'ready' : 'not_ready', checks }, { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
