/**
 * C22: scheduled syncs. A leader service: every 30 seconds it frees the claims whose lease ran out (their process stopped: the run
 * is closed as failed), looks after sources whose agent or knowledge base is gone, and starts the sources that are due (hourly, daily,
 * or a sync a cap cut short, due again a minute later), at most two at a time on this process. A source that is paused is never started.
 * The claim (./claim) decides who runs a source, so a second process that also ticks (a leader change) starts nothing twice.
 */
import { recordAudit } from '../audit';
import { agentStore } from '../agents/store';
import { knowledgeConfigOf } from '../agents/knowledge';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { allStates, freeExpired } from './claim';
import { allSourceRows, deleteSource, finishRun, getRun, updateSourceRow } from './store';
import { startSync, type SyncOptions } from './sync';

const TICK_MS = 30_000;
/** Syncs this process runs at once (each embeds and writes; more would only compete). */
export const MAX_CONCURRENT_SYNCS = 2;

export const knowledgeSourceScheduler = singleton('knowledge-source-scheduler', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  const running = new Set<Promise<unknown>>();
  /** Sources whose agent was not found on the last checks (a source is deleted only after two in a row). */
  const missing = new Map<string, number>();

  /** Run what is due at `now` (tests pass a clock and a connector). Returns how many syncs it started. */
  async function tick(now = Date.now(), options: SyncOptions = {}): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    try {
      // A lease that ran out: the process that held it stopped. Close its run so the history says so.
      for (const { sourceId, runId } of await freeExpired(now)) {
        const run = getRun(runId);
        if (run?.status === 'running') finishRun(runId, { status: 'failed', counts: JSON.parse(run.counts), errors: [], note: 'The process stopped', at: new Date(now) });
        logger.warn('a knowledge source sync stopped without finishing; the source is free again', { 'landflow.source.id': sourceId });
      }
      const states = new Map(allStates().map((state) => [state.source_id, state]));
      let started = 0;
      for (const row of allSourceRows()) {
        if (!agentStore.get(row.agent_id)) {
          // D15: an agent that was deleted takes its sources with it. A store that has not loaded yet (a leader that just took over
          // in Postgres mode) also answers "no such agent", so nothing is deleted unless the store holds agents and the agent was
          // missing on two checks in a row; until then the source is only skipped.
          const missed = (missing.get(row.id) ?? 0) + 1;
          missing.set(row.id, missed);
          if (missed < 2 || !agentStore.list().length) continue;
          missing.delete(row.id);
          deleteSource(row.id);
          recordAudit({ action: 'knowledge_source.removed', actor: 'system', target: { type: 'agent', id: row.agent_id }, project: null, summary: `Removed the ${row.kind} source “${row.name}”: its agent was deleted`, details: { sourceId: row.id, kind: row.kind, source: row.name, agentDeleted: true } });
          continue;
        }
        missing.delete(row.id);
        if (!knowledgeConfigOf(row.agent_id, row.tool_id)) {
          // D15: a knowledge base that was removed pauses its sources and says why.
          if (!row.paused) updateSourceRow(row.id, { paused: 1, paused_reason: 'The knowledge base was removed' });
          continue;
        }
        if (row.paused) continue;
        const state = states.get(row.id);
        if (state?.run_id) continue;
        const due = state?.next_at ? state.next_at <= new Date(now).toISOString() : row.schedule !== 'manual';
        if (!due) continue;
        if (running.size >= MAX_CONCURRENT_SYNCS) break;
        const sync = await startSync(row.id, 'schedule', options); // the real clock: `now` only decides what is due
        if (!sync) continue; // another process took it
        started++;
        const work = sync.done.finally(() => running.delete(work));
        running.add(work);
      }
      return started;
    } finally {
      ticking = false;
    }
  }

  const check = () => void tick().catch((error: Error) => logger.warn('the knowledge source check failed', { error: error.message }));
  return {
    tick,
    /** Syncs this process is running. */
    active: () => running.size,
    start() {
      if (timer) return;
      timer = setInterval(check, TICK_MS);
      timer.unref?.();
      check();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
});
