/**
 * Audit log export (GET /api/audit/export): the events matching the filters, newest first, as CSV (one column per
 * field, details as JSON text) or JSON (an array of events). Streamed page by page so a large export doesn't sit in
 * memory; capped at `MAX_EXPORT` events. CSV cells that a spreadsheet would run as a formula are prefixed with `'`.
 */
import type { AuditEvent, AuditFilters } from '../../shared/audit';
import { queryEvents } from './store';

export const MAX_EXPORT = 100_000;
const PAGE = 1_000;

export const CSV_COLUMNS = [
  'id',
  'at',
  'action',
  'category',
  'outcome',
  'actor_type',
  'actor_id',
  'actor_name',
  'actor_email',
  'api_key_id',
  'ip',
  'user_agent',
  'request_id',
  'method',
  'route',
  'status',
  'target_type',
  'target_id',
  'target_name',
  'summary',
  'details',
] as const;

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(event: AuditEvent): string {
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    id: event.id,
    at: event.at,
    action: event.action,
    category: event.category,
    outcome: event.outcome,
    actor_type: event.actor.type,
    actor_id: event.actor.id,
    actor_name: event.actor.name,
    actor_email: event.actor.email,
    api_key_id: event.apiKeyId,
    ip: event.ip,
    user_agent: event.userAgent,
    request_id: event.requestId,
    method: event.method,
    route: event.route,
    status: event.status,
    target_type: event.target?.type,
    target_id: event.target?.id,
    target_name: event.target?.name,
    summary: event.summary,
    details: event.details,
  };
  return CSV_COLUMNS.map((column) => cell(values[column])).join(',');
}

/** The matching events, page by page (newest first), at most `max`. */
export function* exportEvents(filters: AuditFilters, max = MAX_EXPORT): Generator<AuditEvent> {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = queryEvents(filters, { limit: Math.min(PAGE, max - count), cursor });
    for (const event of page.events) {
      yield event;
      if (++count >= max) return;
    }
    cursor = page.nextCursor;
  } while (cursor);
}

/** A streamed CSV or JSON body. `onDone` gets how many events went out. */
export function exportStream(format: 'csv' | 'json', filters: AuditFilters, onDone?: (count: number) => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = exportEvents(filters);
  let count = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk: string[] = [];
      if (!started) {
        started = true;
        chunk.push(format === 'csv' ? `${CSV_COLUMNS.join(',')}\r\n` : '[');
      }
      for (let i = 0; i < 500; i++) {
        const next = events.next();
        if (next.done) {
          if (format === 'json') chunk.push(count ? '\n]\n' : ']\n');
          if (chunk.length) controller.enqueue(encoder.encode(chunk.join('')));
          controller.close();
          onDone?.(count);
          return;
        }
        chunk.push(format === 'csv' ? `${csvRow(next.value)}\r\n` : `${count ? ',' : ''}\n${JSON.stringify(next.value)}`);
        count++;
      }
      controller.enqueue(encoder.encode(chunk.join('')));
    },
  });
}
