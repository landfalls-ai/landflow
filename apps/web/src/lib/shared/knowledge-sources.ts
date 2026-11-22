/**
 * C22: an agent's knowledge base can have sources (a files-directory folder, an S3 prefix, one site, a Google Drive folder),
 * each with a schedule and a history of sync runs. The shapes the routes send and the dialog shows, and the limits a sync keeps.
 * Pure data and words: client components import this file.
 */

export type SourceKind = 'folder' | 'googleDrive' | 's3' | 'crawl';
export type SourceSchedule = 'manual' | 'hourly' | 'daily';

export const SOURCE_KINDS: readonly SourceKind[] = ['folder', 's3', 'crawl', 'googleDrive'];
export const SOURCE_SCHEDULES: readonly SourceSchedule[] = ['manual', 'hourly', 'daily'];

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = { folder: 'Folder', googleDrive: 'Google Drive', s3: 'S3 bucket', crawl: 'Website' };
export const SCHEDULE_LABEL: Record<SourceSchedule, string> = { manual: 'Only when I press Sync now', hourly: 'Every hour', daily: 'Every day' };

/** The credential type each kind that needs one takes (the type's name as the registry holds it). */
export const SOURCE_CREDENTIAL_TYPE: Partial<Record<SourceKind, string>> = { googleDrive: 'google.googleOAuth2Api', s3: 'core.s3Api' };

export interface FolderSettings {
  folder: string;
}
export interface DriveSettings {
  folderId: string;
  includeSubfolders: boolean;
}
/** The endpoint and region are the credential's. */
export interface S3Settings {
  bucket: string;
  prefix: string;
}
export interface CrawlSettings {
  startUrl: string;
  maxDepth: number;
  maxPages: number;
}
export type SourceSettings = FolderSettings | DriveSettings | S3Settings | CrawlSettings;

export interface SyncCounts {
  seen: number;
  added: number;
  changed: number;
  removed: number;
  failed: number;
  /** Chunks sent to the embeddings model, and chunks that kept their stored vector. */
  embedded: number;
  reused: number;
}
export const EMPTY_COUNTS: SyncCounts = { seen: 0, added: 0, changed: 0, removed: 0, failed: 0, embedded: 0, reused: 0 };

export type SyncStatus = 'running' | 'ok' | 'partial' | 'failed';

export interface SyncRunView {
  id: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string;
  status: SyncStatus;
  counts: SyncCounts;
  /** At most `SOURCE_LIMITS.errorsKept`: the item and why. */
  errors: Array<{ item: string; reason: string }>;
  /** One line of why a run stopped short (a cap, the deadline, a listing that was not whole). */
  note?: string;
}

export interface SourceView {
  id: string;
  kind: SourceKind;
  name: string;
  settings: SourceSettings;
  credential?: { id: string; name: string };
  schedule: SourceSchedule;
  paused: boolean;
  pausedReason?: string;
  running: boolean;
  lastRun?: SyncRunView;
  nextAt?: string;
  createdAt: string;
}

/** POST …/sources */
export interface SourceInput {
  kind: SourceKind;
  name?: string;
  settings: Record<string, unknown>;
  credentialId?: string;
  schedule: SourceSchedule;
}
/** PATCH …/sources/:id */
export interface SourcePatch {
  name?: string;
  schedule?: SourceSchedule;
  paused?: boolean;
  settings?: Record<string, unknown>;
}

export const SOURCE_LIMITS = {
  itemsPerSync: 2000,
  listingEntries: 10_000,
  fileBytes: 25 * 1024 * 1024,
  deadlineMs: 30 * 60_000,
  runsKept: 100,
  errorsKept: 50,
  sourcesPerBase: 20,
  crawlDepth: 3,
  crawlPages: 500,
  /** A sync cut short by a cap is due again after this. */
  retryAfterCapMs: 60_000,
} as const;

/** "added 3, changed 1, removed 0 · 12 embedded, 240 reused": the counts of one run in a line. */
export function syncSummary(run: Pick<SyncRunView, 'counts'>): string {
  const { added, changed, removed, failed, embedded, reused } = run.counts;
  const head = `added ${added}, changed ${changed}, removed ${removed}${failed ? `, failed ${failed}` : ''}`;
  return embedded || reused ? `${head} · ${embedded} embedded, ${reused} reused` : head;
}

const STATUS_WORD: Record<SyncStatus, string> = { running: 'Syncing', ok: 'Succeeded', partial: 'Partly done', failed: 'Failed' };
export const syncStatusLabel = (status: SyncStatus): string => STATUS_WORD[status];

/** The where of a source in one line (a folder, `s3://bucket/prefix`, a site, a Drive folder). */
export function sourceLocation(kind: SourceKind, settings: SourceSettings): string {
  if (kind === 'folder') return (settings as FolderSettings).folder;
  if (kind === 's3') {
    const s3 = settings as S3Settings;
    return `s3://${s3.bucket}/${s3.prefix}`;
  }
  if (kind === 'crawl') return (settings as CrawlSettings).startUrl;
  return `folder ${(settings as DriveSettings).folderId}`;
}
