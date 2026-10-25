/**
 * At boot: everything without a home project row (credentials and agents, which live in files and which the SQL
 * migration can't see, plus anything created by system code since) gets one in the default project, the instance
 * owner's personal project. Only inserts; idempotent; skipped before setup. A failure is logged and never stops the
 * host: a resource without a row belongs to the owner's personal project anyway.
 */
import { agentStore } from '../agents/store';
import { credentials } from '../credentials/vault';
import { dataTables } from '../datatables';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { adoptUnassigned } from './transfer';

export function adoptUnassignedResources(): number {
  try {
    const adopted = adoptUnassigned({
      workflow: store.listWorkflows().map((w) => w.id),
      credential: credentials.list().map((c) => c.id),
      dataTable: dataTables().listTables().map((t) => t.id),
      agent: agentStore.summaries().map((a) => a.id),
    });
    if (adopted) logger.info('gave resources without a project to the owner’s personal project', { 'landflow.projects.adopted': adopted });
    return adopted;
  } catch (error) {
    logger.warn('adopting resources into projects failed; they stay with the owner', { error });
    return 0;
  }
}
