/**
 * What `landflow work` keeps on this machine: the held entries (`work/held.json`, next to the CLI's config file) and
 * the allow-list of repositories (`work/repos.json`). Both are written atomically, readable by their owner only (0600
 * in a 0700 directory). A held entry is metadata only (a work event, see @landflow/protocol), never code.
 *
 * Caps: 500 entries and 14 days. Older entries are dropped when the file is next written; a full file drops sent and
 * dropped entries first, oldest first, and never a held one unless nothing else is left.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkEventInput } from './contract';
import { CliError } from '../errors';

export const HELD_MAX_ENTRIES = 500;
export const HELD_MAX_DAYS = 14;
export const WORK_SOURCE = 'landflow-cli';

export type HeldStatus = 'held' | 'sent' | 'dropped';

export interface HeldEntry {
  /** A short id for the command line: the first 8 hex digits of the hash of `sourceId`. */
  id: string;
  /** `<repo>@<day>`: collecting the same day again updates this entry and, once sent, the server's row. */
  sourceId: string;
  day: string;
  status: HeldStatus;
  event: WorkEventInput;
  heldAt: string;
  sentAt?: string;
  /** The brain's id for the event once it is sent. */
  serverId?: string;
  /** Why the host refused it the last time. */
  error?: string;
}

export interface AllowedRepo {
  /** Absolute path of the working copy. */
  path: string;
  /** `owner/name` of its `origin` when it was added. */
  repo: string;
}

export const workDir = (configFile: string) => join(dirname(configFile), 'work');
export const heldPath = (configFile: string) => join(workDir(configFile), 'held.json');
export const reposPath = (configFile: string) => join(workDir(configFile), 'repos.json');

export const entryId = (sourceId: string) => createHash('sha256').update(sourceId).digest('hex').slice(0, 8);

function readJson<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError('config', `${path} isn't valid JSON: fix it or delete it`);
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readHeld(configFile: string): HeldEntry[] {
  const parsed = readJson<{ entries?: HeldEntry[] }>(heldPath(configFile), {});
  return Array.isArray(parsed.entries) ? parsed.entries.filter((e) => e && typeof e.sourceId === 'string' && e.event) : [];
}

/** Drop entries older than 14 days, then the oldest beyond 500 (settled ones before held ones). Pure. */
export function prune(entries: HeldEntry[], now: Date): HeldEntry[] {
  const cutoff = new Date(now.getTime() - HELD_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
  let kept = entries.filter((e) => e.day >= cutoff);
  if (kept.length > HELD_MAX_ENTRIES) {
    const rank = (e: HeldEntry) => (e.status === 'held' ? 1 : 0);
    const doomed = new Set(
      [...kept]
        .sort((a, b) => rank(a) - rank(b) || a.day.localeCompare(b.day) || a.heldAt.localeCompare(b.heldAt))
        .slice(0, kept.length - HELD_MAX_ENTRIES)
        .map((e) => e.sourceId),
    );
    kept = kept.filter((e) => !doomed.has(e.sourceId));
  }
  return kept;
}

export function writeHeld(configFile: string, entries: HeldEntry[], now = new Date()): HeldEntry[] {
  const kept = prune(entries, now);
  writeJson(heldPath(configFile), { version: 1, entries: kept });
  return kept;
}

const sameEvent = (a: WorkEventInput, b: WorkEventInput) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Add or update an entry by `sourceId`. A re-collected day that changed goes back to held (the person reviews the
 * update); one that did not change keeps its status. A title the person edited survives a re-collect only if the
 * collected event is otherwise the same.
 */
export function upsert(entries: HeldEntry[], event: WorkEventInput, day: string, now: Date): { entries: HeldEntry[]; entry: HeldEntry; changed: boolean } {
  const existing = entries.find((e) => e.sourceId === event.sourceId);
  if (existing && sameEvent(existing.event, event)) return { entries, entry: existing, changed: false };
  const entry: HeldEntry = {
    id: entryId(event.sourceId),
    sourceId: event.sourceId,
    day,
    status: 'held',
    event,
    heldAt: now.toISOString(),
    ...(existing?.serverId && { serverId: existing.serverId }),
  };
  return { entries: [...entries.filter((e) => e.sourceId !== event.sourceId), entry], entry, changed: true };
}

export function findEntry(entries: HeldEntry[], ref: string): HeldEntry | undefined {
  return entries.find((e) => e.id === ref || e.sourceId === ref);
}

export function readRepos(configFile: string): AllowedRepo[] {
  const parsed = readJson<{ repos?: AllowedRepo[] }>(reposPath(configFile), {});
  return Array.isArray(parsed.repos) ? parsed.repos.filter((r) => r && typeof r.path === 'string' && typeof r.repo === 'string') : [];
}

export function writeRepos(configFile: string, repos: AllowedRepo[]) {
  writeJson(reposPath(configFile), { version: 1, repos });
}
