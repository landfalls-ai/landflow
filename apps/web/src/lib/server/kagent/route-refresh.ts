/**
 * Secret routes follow their credentials (docs/a2a.md, "Secret routes"): the leader looks at every deployed agent's routes once
 * a minute and, when a routed credential's value in the vault differs from the one in the cluster Secret, rewrites that Secret
 * and nothing else (C26-D2: it changes only the value the person already chose). Unchanged agents cost no cluster call. At most
 * 50 agents a tick, a rotating window, so a larger instance still gets round within the five minutes the spec asks (up to 250).
 */
import { agentStore } from '../agents/store';
import { recordAudit } from '../audit';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { refreshRouteSecret } from './deploy';

export const REFRESH_EVERY_MS = 60_000;
export const AGENTS_PER_TICK = 50;

export const kagentRouteRefresh = singleton('kagent-route-refresh', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;
  let running = false;

  /** One pass over (a window of) the deployed agents with routes. Returns how many Secrets it rewrote. */
  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let rewritten = 0;
    try {
      const routed = agentStore
        .list()
        .filter((agent) => agent.kagent?.routes?.length)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!routed.length) return 0;
      cursor %= routed.length;
      const window = [...routed.slice(cursor), ...routed.slice(0, cursor)].slice(0, AGENTS_PER_TICK);
      cursor = (cursor + window.length) % routed.length;
      for (const listed of window) {
        // The list is a summary: the deployment is read whole.
        const agent = agentStore.get(listed.id);
        if (!agent?.kagent?.routes?.length) continue;
        try {
          const result = await refreshRouteSecret(agent);
          if (!result) continue;
          rewritten += 1;
          recordAudit({
            action: 'kagent.route.refreshed',
            actor: 'system',
            target: { type: 'agent', id: agent.id, name: agent.name },
            summary: `Rewrote the secret of ${agent.name}’s routes on kagent after a credential changed`,
            details: { agent: agent.name, credentialNames: result.changed, ...(result.broken.length && { broken: result.broken }) },
          });
          logger.info('kagent: route secret rewritten', { agentId: agent.id, name: agent.kagent.name, broken: result.broken.length });
        } catch (error) {
          // Reported by agent id; the next tick tries again.
          logger.warn('kagent: the route secret could not be refreshed', { agentId: agent.id, error: (error as Error).message });
        }
      }
    } finally {
      running = false;
    }
    return rewritten;
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((error: Error) => logger.warn('kagent: route refresh failed', { error: error.message })), REFRESH_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
});
