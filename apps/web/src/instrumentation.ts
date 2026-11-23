import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Telemetry first: Next.js only emits its request spans once a tracer provider is registered,
    // and instruments created before the meter provider would stay no-ops.
    const { startTelemetry } = await import('./lib/server/telemetry/sdk');
    startTelemetry();
    // Error handlers always; signal handlers only where Next.js leaves signals to us (the `start` script and the Docker
    // image set NEXT_MANUAL_SIG_HANDLE; `next dev` keeps Next's own handling).
    const { installProcessHandlers, setBootstrapper, whenReady } = await import('./lib/server/lifecycle');
    installProcessHandlers({ role: 'main', signals: !!process.env.NEXT_MANUAL_SIG_HANDLE, exitOnUncaught: process.env.NODE_ENV === 'production' });
    // Routes no longer import the composition root: `whenReady()` (lifecycle.ts) boots through this.
    setBootstrapper(() => import('./lib/server/bootstrap').then((m) => m.ensureBootstrapped()));
    // `next build` calls register() in its page-generation workers: they serve no traffic, so they don't boot the host
    // (no schedulers, cluster or configuration refusal there). A route that runs at build time still boots lazily.
    if (process.env.NEXT_PHASE === 'phase-production-build') return;
    // A failed required boot rejects here, and a rejected register() stops `next dev`. Outside production keep the
    // server up (failBoot already logged `boot failed`): routes answer 500 and the next request boots it again. Under
    // `next start` and the image the rejection stands and failBoot exits so the orchestrator restarts the process.
    await whenReady().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'production') throw error;
    });
  }
}

/** Errors Next.js caught outside our route handlers (pages, server components), as structured log lines. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logger } = await import('./lib/server/telemetry/logger');
  logger.error('request error', { error, 'http.request.method': request.method, 'url.path': request.path.split('?')[0], 'http.route': context.routePath });
};
