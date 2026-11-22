/**
 * C22: one sync of one source. Claim the source (one run at a time across processes), list it, compare each item's version
 * marker with the one stored at the last sync, fetch only new or changed items (at most 2,000 a sync) and write each through the
 * knowledge base's own path (`addKnowledgeDocument` with a `source`: C20's chunk diff, one replace per document, only new text
 * embedded, C21's access check as the base's home project). Items gone from a COMPLETE listing lose their chunks. The run record
 * keeps the counts and up to 50 errors; a failure of one item never stops the others and never removes its old chunks.
 *
 * Secrets: a run's errors and note hold the item's name and a short reason, never file bytes, tokens or credential values.
 */
import { randomUUID } from 'node:crypto';
import { SOURCE_LIMITS, type SourceKind, type SyncCounts, type SyncRunView } from '../../shared/knowledge-sources';
import { addKnowledgeDocument, deleteChunksWhere, knowledgeConfigOf, type KnowledgeDocumentSync } from '../agents/knowledge';
import { homeProjectId } from '../projects/store';
import { CollectionAccessError } from '../rag/collection-access';
import { logger } from '../telemetry/logger';
import { LEASE_MS, claimSource, releaseSource, renewLease } from './claim';
import { buildConnector } from './connectors';
import type { Connector, SourceItem } from './connectors/types';
import { deleteItem, finishRun, getSource, insertRun, itemsOf, pruneRuns, putItem, updateSourceRow, viewOfRun, getRun, type SourceRow } from './store';
import { nextDue } from './schedule';

export interface SyncOptions {
  signal?: AbortSignal;
  /** Tests: a connector in place of the kind's own. */
  connector?: Connector;
  /** Tests: the clock. */
  now?: () => number;
}

/** The `source` metadata a source's chunks carry: the unit C20's per-document match uses. */
export const sourceKeyOf = (sourceId: string, itemKey: string): string => `src:${sourceId}/${itemKey}`;

const reasonOf = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught)).replace(/\s+/g, ' ').slice(0, 300);

/** Begin a sync: `undefined` when one already runs (the claim was refused), else the run's id and the promise of its result (never rejects). */
export async function startSync(sourceId: string, trigger: 'schedule' | 'manual', options: SyncOptions = {}): Promise<{ runId: string; done: Promise<SyncRunView> } | undefined> {
  const row = getSource(sourceId);
  if (!row) return undefined;
  const clock = options.now ?? Date.now;
  const runId = randomUUID();
  if (!(await claimSource(sourceId, runId, clock()))) return undefined;
  const run = insertRun(sourceId, trigger, new Date(clock()), runId);
  const done = execute(row, run.id, options).catch((caught) => {
    logger.warn('a knowledge source sync stopped on an unexpected error', { 'landflow.source.id': sourceId, error: reasonOf(caught) });
    return viewOfRun(getRun(run.id)!);
  });
  return { runId, done };
}

/** Sync and wait for the result; `undefined` when another run holds the source. */
export async function runSync(sourceId: string, trigger: 'schedule' | 'manual', options: SyncOptions = {}): Promise<SyncRunView | undefined> {
  return (await startSync(sourceId, trigger, options))?.done;
}

async function execute(row: SourceRow, runId: string, options: SyncOptions): Promise<SyncRunView> {
  const clock = options.now ?? Date.now;
  const counts: SyncCounts = { seen: 0, added: 0, changed: 0, removed: 0, failed: 0, embedded: 0, reused: 0 };
  const errors: SyncRunView['errors'] = [];
  let status: 'ok' | 'partial' | 'failed' = 'ok';
  let note: string | undefined;
  let capped = false;
  const fail = (message: string) => {
    status = 'failed';
    note = message;
  };
  const deadline = AbortSignal.timeout(SOURCE_LIMITS.deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    const config = knowledgeConfigOf(row.agent_id, row.tool_id);
    if (!config) {
      fail('The knowledge base was removed');
      updateSourceRow(row.id, { paused: 1, paused_reason: 'The knowledge base was removed' });
      return finish();
    }
    const internal = { asProject: homeProjectId('agent', row.agent_id), subject: 'agent' as const };
    const connector = options.connector ?? buildConnector(row);
    const previous = itemsOf(row.id);
    let listing;
    try {
      listing = await connector.list(signal, previous);
    } catch (caught) {
      fail(signal.aborted ? 'Stopped at the 30 minute limit' : `Could not list the source: ${reasonOf(caught)}`);
      return finish();
    }
    counts.seen = listing.items.length;
    const listed = new Set(listing.items.map((item) => item.key));
    const todo = listing.items.filter((item) => previous.get(item.key)?.version !== item.version);
    let renewed = clock();

    let stopped = false;
    for (const item of todo) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      if (counts.added + counts.changed + counts.failed >= SOURCE_LIMITS.itemsPerSync) {
        capped = true;
        break;
      }
      if (clock() - renewed > LEASE_MS / 4) {
        await renewLease(row.id, runId, clock());
        renewed = clock();
      }
      try {
        await writeItem(row, item, previous.has(item.key), connector, config, internal, counts, signal);
      } catch (caught) {
        if (caught instanceof CollectionAccessError) {
          fail(caught.message);
          updateSourceRow(row.id, { paused: 1, paused_reason: caught.message });
          return finish();
        }
        if (signal.aborted) {
          stopped = true;
          break;
        }
        counts.failed++;
        if (errors.length < SOURCE_LIMITS.errorsKept) errors.push({ item: item.name || item.key, reason: reasonOf(caught) });
      }
    }

    // Gone items lose their chunks, but only when the listing was the source's whole content.
    if (listing.complete && !stopped) {
      for (const [key] of previous) {
        if (listed.has(key)) continue;
        try {
          await deleteChunksWhere(config, { source: sourceKeyOf(row.id, key) }, internal);
          deleteItem(row.id, key);
          counts.removed++;
        } catch (caught) {
          counts.failed++;
          if (errors.length < SOURCE_LIMITS.errorsKept) errors.push({ item: key, reason: `Could not remove: ${reasonOf(caught)}` });
        }
      }
    }
    const notes: string[] = [];
    if (capped) notes.push(`Only ${SOURCE_LIMITS.itemsPerSync} items are synced at a time; the rest follows in the next sync`);
    if (stopped) notes.push('Stopped at the 30 minute limit; the rest follows in the next sync');
    if (!listing.complete) notes.push(`${listing.note ?? 'The listing was not whole'}; nothing was removed`);
    if (counts.failed) notes.push(`${counts.failed} item${counts.failed === 1 ? '' : 's'} could not be read`);
    if (notes.length) {
      status = 'partial';
      note = notes.join('. ');
    }
    return finish();
  } catch (caught) {
    fail(`The sync stopped: ${reasonOf(caught)}`);
    return finish();
  }

  async function finish(): Promise<SyncRunView> {
    finishRun(runId, { status, counts, errors, ...(note && { note }), at: new Date(clock()) });
    pruneRuns(row.id);
    const view = viewOfRun(getRun(runId)!);
    const current = getSource(row.id);
    const next = current && !current.paused ? nextDue(current.schedule, clock(), capped ? SOURCE_LIMITS.retryAfterCapMs : undefined) : null;
    await releaseSource(row.id, runId, next, { id: runId, status, counts, finishedAt: view.finishedAt, ...(note && { note }) });
    return view;
  }
}

async function writeItem(row: SourceRow, item: SourceItem, existed: boolean, connector: Connector, config: NonNullable<ReturnType<typeof knowledgeConfigOf>>, internal: { asProject: string; subject: 'agent' }, counts: SyncCounts, signal: AbortSignal): Promise<void> {
  const file = await connector.fetch(item, signal);
  if (file.bytes.length > SOURCE_LIMITS.fileBytes) throw new Error(`Too large (${Math.round(file.bytes.length / 1024 / 1024)} MB; the limit is ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB)`);
  const extra = { source: sourceKeyOf(row.id, item.key), sourceId: row.id, sourceKind: row.kind as SourceKind, fileName: item.name, ...(item.url && { url: item.url }) };
  const written = (await addKnowledgeDocument(config, { ...file, fileName: file.fileName ?? item.name }, extra, internal)) as KnowledgeDocumentSync;
  counts.embedded += written.embedded ?? 0;
  counts.reused += written.reused ?? 0;
  if (existed) counts.changed++;
  else counts.added++;
  putItem({ source_id: row.id, item_key: item.key, version: item.version, name: item.name, size: item.size ?? file.bytes.length, extra: item.extra ?? null, synced_at: new Date().toISOString() });
}
