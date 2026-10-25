/** Prometheus scrape endpoint (text exposition format). Off with LANDFLOW_METRICS_PROMETHEUS=false or OTEL_SDK_DISABLED=true. */
import { error, handler } from '@/lib/server/http';
import { prometheusText } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const text = await prometheusText();
  if (text === undefined) return error('Prometheus metrics are disabled (LANDFLOW_METRICS_PROMETHEUS=false or OTEL_SDK_DISABLED=true)', 404);
  return new Response(text, { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' } });
});
