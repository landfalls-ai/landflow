/**
 * The project of an audit event: its target's. A workflow, credential, data table or agent belongs to its home project
 * (lib/server/projects); an execution to its workflow's; a project to itself. Instance-wide targets (users, API keys,
 * settings, plugins) have none. Project admins read their projects' events (./access).
 *
 * A change can remove the target before its event is recorded (a deleted data table loses its project row): the
 * generic layer (./http) looks up the project of the resource a request names before the handler runs, and events about
 * that same target use it.
 */
import type { AuditTarget } from '../../shared/audit';
import type { ResourceKind } from '../../shared/projects';
import { executionWorkflowId } from '../projects/access';
import { defaultProjectId, storedHomeProject } from '../projects/store';
import { logger } from '../telemetry/logger';

/** Audit target types (and the generic layer's route names) that are project resources. */
const KINDS: Record<string, ResourceKind> = { workflow: 'workflow', credential: 'credential', data_table: 'dataTable', dataTable: 'dataTable', agent: 'agent' };

/** A target that belongs to projects (or is one). */
export const projectTarget = (target: Pick<AuditTarget, 'type'> | undefined) => Boolean(target && (target.type in KINDS || target.type === 'project' || target.type === 'execution'));

const home = (kind: ResourceKind, id: string) => storedHomeProject(kind, id) ?? defaultProjectId();

/** The project an event about `target` belongs to, if any. `details.workflowId` names an execution's workflow when given. */
export function targetProject(target: Pick<AuditTarget, 'type' | 'id'> | undefined, details?: Record<string, unknown>): string | undefined {
  if (!target?.id || !projectTarget(target)) return undefined;
  try {
    if (target.type === 'project') return target.id;
    if (target.type === 'execution') {
      const workflowId = typeof details?.workflowId === 'string' && details.workflowId ? details.workflowId : executionWorkflowId(target.id);
      return workflowId ? home('workflow', workflowId) : undefined;
    }
    return home(KINDS[target.type], target.id);
  } catch (error) {
    logger.debug('could not find the project of an audit target', { error: (error as Error).message });
    return undefined;
  }
}
