import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Telemetry first: Next.js only emits its request spans once a tracer provider is registered,
    // and instruments created before the meter provider would stay no-ops.
    const { startTelemetry } = await import('./lib/server/telemetry/sdk');
    startTelemetry();
    const { ensureBootstrapped } = await import('./lib/server/bootstrap');
    await ensureBootstrapped();
  }
}

/** Errors Next.js caught outside our route handlers (pages, server components), as structured log lines. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logger } = await import('./lib/server/telemetry/logger');
  logger.error('request error', { error, 'http.request.method': request.method, 'url.path': request.path.split('?')[0], 'http.route': context.routePath });
};
