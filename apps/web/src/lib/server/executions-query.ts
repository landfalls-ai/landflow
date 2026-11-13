/**
 * One page of saved executions, newest first, read with keyset paging: the filters (finished runs only, a workflow,
 * the workflows a member may see) are SQL on columns, and the position is `(started_at, id)` of the last row of the
 * previous page, so a page is never short because rows were filtered afterwards and never repeats or skips a row
 * when runs start in between. (store.listExecutions stays for callers that want the newest N without a cursor.)
 */
import type { ExecutionSummary } from '../shared/types';
import { database, type SqlValue } from './db';
import { parse } from './db/rows';
import { decodeCursor, encodeCursor } from './pagination';

export interface ExecutionsPageQuery {
  workflowId?: string;
  limit: number;
  cursor?: string;
  /** The workflows the caller may see; null or undefined = all of them. */
  visibleWorkflowIds?: string[] | null;
}

export interface ExecutionsPage {
  executions: ExecutionSummary[];
  nextCursor?: string;
}

/** Ids per `workflow_id IN (…)`: below SQLite's host-parameter limit, with room for the other parameters. */
const CHUNK = 500;

interface Row {
  id: string;
  started_at: string;
  summary: string;
}

export function listExecutionsPage(query: ExecutionsPageQuery): ExecutionsPage {
  const limit = Math.max(1, Math.floor(query.limit));
  const position = query.cursor ? decodeCursor(query.cursor) : undefined;
  const chunks: Array<string[] | undefined> = query.visibleWorkflowIds ? chunked(query.visibleWorkflowIds) : [undefined];
  const db = database();
  const rows: Row[] = [];
  for (const ids of chunks) {
    const where = ["status <> 'running'"];
    const params: SqlValue[] = [];
    if (query.workflowId) {
      where.push('workflow_id = ?');
      params.push(query.workflowId);
    }
    if (ids) {
      where.push(`workflow_id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    if (position) {
      where.push('(started_at < ? OR (started_at = ? AND id < ?))');
      params.push(position.s, position.s, position.i);
    }
    rows.push(...db.all<Row>(`SELECT id, started_at, summary FROM executions WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`, ...params, limit + 1));
  }
  // One row more than asked says whether another page follows; with several chunks each returned its own newest rows.
  if (chunks.length > 1) rows.sort((a, b) => (a.started_at === b.started_at ? (a.id < b.id ? 1 : -1) : a.started_at < b.started_at ? 1 : -1));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    executions: page.flatMap((row) => parse<ExecutionSummary>(row.summary) ?? []),
    ...(rows.length > limit && last && { nextCursor: encodeCursor({ s: last.started_at, i: last.id }) }),
  };
}

function chunked(ids: string[]): Array<string[] | undefined> {
  if (!ids.length) return [[]];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}
