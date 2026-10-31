/**
 * The ledger's first fill, once per database: the executions still on disk (the newest 2,000), the AI usage rows and the
 * audit events of the last USAGE_RETENTION_DAYS. Backfilled events have ids derived from their source, so running it again
 * adds nothing; `meta` remembers it ran.
 */
import type { AuditEvent } from '../../shared/audit';
import { fromRow as auditFromRow } from '../audit/store';
import { database, type Database } from '../db';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { brainEnabled, recordAuditUsage, recordExecutionUsage, recordUsage } from './ledger';
import { rawRetentionDays, rollupMissing } from './query';

const DONE_KEY = 'usage.backfilled';
const MAX_EXECUTIONS = 2_000;
const DAY_MS = 86_400_000;

export function usageBackfilled(db: Database = database()): boolean {
  return Boolean(db.get('SELECT value FROM meta WHERE key = ?', DONE_KEY));
}

/** Fill the ledger from what is on disk. Returns how many events were added (0 when it already ran). */
export function backfillUsage(db: Database = database(), force = false): number {
  if (!brainEnabled() || (!force && usageBackfilled(db))) return 0;
  const before = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_events')?.n ?? 0);
  const since = new Date(Date.now() - rawRetentionDays() * DAY_MS).toISOString();
  try {
    for (const summary of store.listExecutions({ limit: MAX_EXECUTIONS })) {
      if (summary.startedAt < since) continue;
      const record = store.getExecution(summary.id);
      if (record) recordExecutionUsage(record, record.workflow ?? store.getWorkflow(record.workflowId));
    }
    const calls = db.all<{ id: string; at: string; workflow_id: string | null; agent_id: string | null; execution_id: string | null; user_id: string | null; provider: string; model: string; operation: string; input_tokens: number; output_tokens: number; cost: number }>(
      'SELECT id, at, workflow_id, agent_id, execution_id, user_id, provider, model, operation, input_tokens, output_tokens, cost FROM ai_usage WHERE at >= ?',
      since,
    );
    for (const c of calls) {
      recordUsage(
        {
          id: `bf:${c.id}`,
          at: c.at,
          kind: 'ai.call',
          ...(c.workflow_id && { workflowId: c.workflow_id }),
          ...(c.agent_id && { agentId: c.agent_id }),
          ...(c.execution_id && { executionId: c.execution_id }),
          ...(c.user_id && { actorId: c.user_id }),
          tokens: Number(c.input_tokens) + Number(c.output_tokens),
          cost: Number(c.cost),
          attrs: { provider: c.provider, model: c.model, operation: c.operation, input: Number(c.input_tokens), output: Number(c.output_tokens) },
        },
        db,
      );
    }
    const actions = ['workflow.create', 'workflow.update', 'workflow.import', 'workflow.publish', 'workflow.rollback', 'credential.use', 'marketplace.install'];
    const audit = db.all<Parameters<typeof auditFromRow>[0]>(`SELECT * FROM audit_events WHERE at >= ? AND action IN (${actions.map(() => '?').join(', ')})`, since, ...actions);
    for (const row of audit) recordAuditUsage(auditFromRow(row) as AuditEvent);
    rollupMissing(db);
    db.upsert('meta', { key: DONE_KEY, value: new Date().toISOString() });
  } catch (error) {
    logger.warn('the usage backfill stopped early', { error });
  }
  const added = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_events')?.n ?? 0) - before;
  if (added) logger.info('filled the usage ledger from the data on disk', { 'landflow.usage.backfilled': added });
  return added;
}
