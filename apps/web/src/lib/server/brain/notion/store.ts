/**
 * The Notion brain's outbox listener (docs/features/notion-brain.md#how-it-is-built). Every brain write is a `BrainChange`
 * (lib/server/brain/store); one with a project that has a Notion link queues that object in the link's outbox, whatever the
 * link's status, so the outbox keeps filling while the link is paused or the Notion brain is switched off and a later tick
 * pushes what changed. A change that came from Notion itself is not queued (the pull queues the re-pushes it needs). Any
 * change also marks Home due, at most every 10 minutes, and a change to a page or fact marks Log due, at most hourly.
 * Nothing here calls Notion.
 */
import type { BrainChange } from '../../../shared/brain-store';
import { database } from '../../db';
import { singleton } from '../../singleton';
import { onBrainChange } from '../store';
import { getLink } from './links';
import { enqueue, itemKindOf, itemOf, type ItemKind, type OutboxRow } from './sync';

export const HOME_EVERY_MS = 10 * 60_000;
export const LOG_EVERY_MS = 60 * 60_000;

/** Asks for Home or Log to be pushed, no sooner than `gapMs` after its last push; an earlier request already waiting stays. */
export function markDue(linkId: string, kind: 'home' | 'log', gapMs: number, now = Date.now()): void {
  const last = itemOf(linkId, kind as unknown as ItemKind, '')?.pushed_at;
  const at = new Date(Math.max(now, last ? Date.parse(last) + gapMs : now)).toISOString();
  const waiting = database().get<OutboxRow>('SELECT * FROM notion_brain_outbox WHERE link_id = ? AND kind = ? AND local_key = ?', linkId, kind, '');
  if (waiting?.next_at && waiting.next_at <= at) return;
  database().upsert('notion_brain_outbox', { link_id: linkId, kind, local_key: '', op: 'upsert', enqueued_at: new Date(now).toISOString(), attempts: 0, next_at: at, last_error: null } as unknown as Record<string, never>);
}

/** What one change does: queue the object (unless Notion made the change) and mark Home, and perhaps Log, due. */
export function onChange(change: BrainChange): void {
  if (!change.projectId) return;
  const link = getLink(change.projectId);
  if (!link) return;
  if (change.origin !== 'notion') {
    enqueue(link.id, itemKindOf(change.kind), change.key, change.op);
    // A fact about a page is a line on that page's body too.
    const about = change.kind === 'fact' && change.key.startsWith('entity:') ? change.key.split(':')[1] : undefined;
    if (about?.includes('/')) enqueue(link.id, 'entity', about);
  }
  markDue(link.id, 'home', HOME_EVERY_MS);
  if (change.kind === 'entity' || change.kind === 'summary' || change.kind === 'fact') markDue(link.id, 'log', LOG_EVERY_MS);
}

/** Registers the listener once per process. */
export const outboxListener = singleton('notion-brain-outbox-listener', () => ({ stop: onBrainChange(onChange) }));
