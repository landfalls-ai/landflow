/** Fires Schedule triggers of active workflows and starts the poller. Single-process; leader election is out of scope. */
import { registry } from './plugins/registry';
import { poller } from './poller';
import { runWorkflow } from './runner';
import { singleton } from './singleton';
import { store } from './store';
import { fireTrigger, logger, recordScheduleLag } from './telemetry';

const UNIT_MS = { seconds: 1_000, minutes: 60_000, hours: 3_600_000 } as const;

export const scheduler = singleton('scheduler', () => {
  const lastRun = new Map<string, number>();
  const inFlight = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const tick = () => {
    const now = Date.now();
    for (const workflow of store.listWorkflows()) {
      if (!workflow.active) continue;
      for (const node of workflow.nodes) {
        if (node.disabled || node.type !== 'core.schedule') continue;
        const key = `${workflow.id}:${node.id}`;
        const every = Math.max(1, Number(node.parameters.every ?? 5));
        const unit = UNIT_MS[(node.parameters.unit as keyof typeof UNIT_MS) ?? 'minutes'] ?? UNIT_MS.minutes;
        const interval = Math.max(5_000, every * unit);
        const last = lastRun.get(key);
        if (last === undefined) {
          lastRun.set(key, now); // first sighting: wait one full interval
          continue;
        }
        if (now - last < interval || inFlight.has(key)) continue;
        lastRun.set(key, now);
        inFlight.add(key);
        recordScheduleLag(workflow.id, now - (last + interval));
        // Each scheduled run is its own trace: trigger.fire → workflow.execute → …
        void fireTrigger({ source: 'schedule', workflowId: workflow.id, nodeName: node.name }, () =>
          runWorkflow({ workflow, mode: 'trigger', startNodeId: node.id, triggerItems: [{ json: { scheduledAt: new Date(now).toISOString() } }] }),
        )
          .catch((error) => logger.warn('scheduled run failed', { 'landflow.workflow.id': workflow.id, 'landflow.workflow.name': workflow.name, error: (error as Error).message }))
          .finally(() => inFlight.delete(key));
      }
    }
  };

  return {
    start() {
      if (timer) return;
      void registry; // ensure the registry singleton exists before the first tick
      timer = setInterval(tick, 1_000);
      timer.unref?.();
      poller.start();
    },
  };
});
