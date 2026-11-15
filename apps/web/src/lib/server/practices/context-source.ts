/**
 * Sets the project-context seam's practices slot (docs/practices.md#following): the selector every Landflow run
 * goes through. A side-effect import in lib/server/runtime.ts. It reads the port and writes nothing (no `delivered` rows: a
 * preview calls it too); the project is the run's, resolved on the server, and nothing a caller sends adds one.
 */
import { PRACTICE_BUDGETS } from '../../shared/practices';
import type { PracticesQuery, PracticesSelection } from '../../shared/project-context';
import { setPracticesSource } from '../project-context/seam';
import { practicesBlock } from './block';
import { practicesPort } from './port';
import { selectPractices } from './select';

export function selectForRun(q: PracticesQuery): PracticesSelection {
  const port = practicesPort();
  if (!port?.enabled()) return { text: '', practices: [] };
  const list = port.approved({ projectIds: q.projectId ? [q.projectId] : [] });
  const selected = selectPractices(list, { ...(q.repo && { repo: q.repo }), ...(q.paths && { paths: q.paths }), ...(q.topics && { topics: q.topics }), ...(q.task && { task: q.task }) });
  const { text, included } = practicesBlock(selected, q.size === 'full' ? PRACTICE_BUDGETS.inProcess : PRACTICE_BUDGETS.remote);
  return { text, practices: included.map(({ handle, version }) => ({ handle, version })) };
}

setPracticesSource({ select: selectForRun });
