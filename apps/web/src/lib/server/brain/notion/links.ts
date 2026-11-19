/**
 * A project's link to a Notion page (docs/features/notion-brain.md#setting-it-up): the row, its status, the problems a person
 * resolves, and the resolver that tells the brain store which backend a project uses. This module never calls Notion: the check
 * and the routes do (through lib/server/notion/port.ts), and the sync that fills the link in is wave nb2 (NB04, NB05).
 *
 * A project's link is kept when it is disconnected (status `unlinked`, for the history) and when the project is deleted: a
 * link whose project is gone reads as unlinked everywhere here (`getLink`, `listActiveLinks` and the resolver skip it) and
 * nothing is sent to Notion, which keeps what is there.
 */
import { randomUUID } from 'node:crypto';
import { LINK_STATUS_LABELS, STOPPED_STATUSES, type CopyProgress, type KnowledgeScope, type LinkProblemView, type LinkStatus, type LinkView, type ProblemAction, type ProblemKind } from '../../../shared/notion-brain';
import { envString } from '../../config';
import { credentials } from '../../credentials/vault';
import { database, type Database } from '../../db';
import { getProject } from '../../projects/store';
import { logger } from '../../telemetry/logger';
import { setBackendResolver } from '../store/port';

export interface LinkRow {
  id: string;
  project_id: string;
  credential_id: string;
  root_page_id: string;
  root_title: string | null;
  root_url: string | null;
  brain_page_id: string | null;
  log_page_id: string | null;
  databases: string | null;
  bot_id: string | null;
  bot_name: string | null;
  workspace_name: string | null;
  status: LinkStatus;
  reason: string | null;
  rps: number;
  knowledge_scope: KnowledgeScope;
  cursors: string | null;
  copy: string | null;
  next_sync_at: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProblemRow {
  id: string;
  link_id: string;
  kind: ProblemKind;
  notion_id: string | null;
  local_key: string | null;
  detail: string;
  at: string;
  resolved_by: string | null;
  resolved_action: string | null;
  resolved_at: string | null;
}

const db = (): Database => database();
const now = () => new Date().toISOString();

export const SWITCHED_OFF = 'The Notion brain is switched off on this instance';

/** `LANDFLOW_NOTION_BRAIN=off` (or `false`, `0`): every link is treated as paused and nothing calls Notion. */
export function notionBrainEnabled(): boolean {
  return !['off', 'false', '0', 'no'].includes((envString('LANDFLOW_NOTION_BRAIN') ?? 'on').toLowerCase());
}

const parseJson = <T>(text: string | null | undefined): T | undefined => {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------------------------------- reading

/** The link by id, whatever its status. */
export const linkById = (id: string): LinkRow | undefined => db().get<LinkRow>('SELECT * FROM notion_brain_links WHERE id = ?', id);

/** The project's current link: not `unlinked`, and its project still exists (a deleted project's link reads as unlinked). */
export function getLink(projectId: string): LinkRow | undefined {
  const row = db().get<LinkRow>("SELECT * FROM notion_brain_links WHERE project_id = ? AND status <> 'unlinked'", projectId);
  return row && getProject(projectId) ? row : undefined;
}

/** Every link the sync works on: not `unlinked`, project still there. */
export function listActiveLinks(): LinkRow[] {
  return db()
    .all<LinkRow>("SELECT * FROM notion_brain_links WHERE status <> 'unlinked' ORDER BY created_at")
    .filter((row) => getProject(row.project_id));
}

/** The link that holds this root page, if one does. */
export const linkOfRoot = (rootPageId: string): LinkRow | undefined => db().get<LinkRow>("SELECT * FROM notion_brain_links WHERE root_page_id = ? AND status <> 'unlinked'", rootPageId);

// ---------------------------------------------------------------------------------------------------- writing

export interface NewLink {
  projectId: string;
  credentialId: string;
  rootPageId: string;
  rootTitle?: string;
  rootUrl?: string;
  brainPageId?: string;
  botId?: string;
  botName?: string;
  workspaceName?: string;
  knowledgeScope?: KnowledgeScope;
  rps?: number;
  createdBy?: string;
}

export class LinkConflictError extends Error {
  constructor(
    message: string,
    readonly reason: 'project' | 'root',
  ) {
    super(message);
  }
}

/** A new link in `setting_up` (NB04's service picks it up and copies). Throws LinkConflictError when the project or the page is linked already. */
export function createLink(input: NewLink): LinkRow {
  return db().transaction(() => {
    if (db().get('SELECT 1 AS x FROM notion_brain_links WHERE project_id = ? AND status <> ?', input.projectId, 'unlinked')) throw new LinkConflictError('Already linked', 'project');
    if (linkOfRoot(input.rootPageId)) throw new LinkConflictError('That Notion page is linked to another project already', 'root');
    const at = now();
    const row: LinkRow = {
      id: `nbl_${randomUUID()}`,
      project_id: input.projectId,
      credential_id: input.credentialId,
      root_page_id: input.rootPageId,
      root_title: input.rootTitle ?? null,
      root_url: input.rootUrl ?? null,
      brain_page_id: input.brainPageId ?? null,
      log_page_id: null,
      databases: null,
      bot_id: input.botId ?? null,
      bot_name: input.botName ?? null,
      workspace_name: input.workspaceName ?? null,
      status: 'setting_up',
      reason: null,
      rps: input.rps ?? 2,
      knowledge_scope: input.knowledgeScope ?? 'brain',
      cursors: null,
      copy: null,
      next_sync_at: at,
      last_push_at: null,
      last_pull_at: null,
      last_error: null,
      created_by: input.createdBy ?? null,
      created_at: at,
      updated_at: at,
    };
    db().upsert('notion_brain_links', row as unknown as Record<string, never>);
    return row;
  });
}

function update(id: string, fields: Partial<LinkRow>): LinkRow | undefined {
  const row = linkById(id);
  if (!row) return undefined;
  const next = { ...row, ...fields, updated_at: now() };
  db().upsert('notion_brain_links', next as unknown as Record<string, never>);
  return next;
}

export const updateLink = update;

/** A status change; `reason` is what a person reads (cleared when omitted). */
export const setStatus = (id: string, status: LinkStatus, reason?: string): LinkRow | undefined => update(id, { status, reason: reason ?? null });

/** The sync's cursors (JSON: the pull's per-database cursors, the knowledge walk's). */
export const setCursors = (id: string, cursors: unknown): LinkRow | undefined => update(id, { cursors: JSON.stringify(cursors) });

export const setCopyProgress = (id: string, copy: CopyProgress | null): LinkRow | undefined => update(id, { copy: copy ? JSON.stringify(copy) : null });

/** Sync now: the service looks at `next_sync_at`. */
export const requestSync = (id: string): LinkRow | undefined => update(id, { next_sync_at: now() });

/** Disconnect: status `unlinked`; the rows stay for the history. Never calls Notion, which keeps what is there. */
export const unlink = (id: string): LinkRow | undefined => update(id, { status: 'unlinked', reason: null, next_sync_at: null });

// ---------------------------------------------------------------------------------------------------- problems

export function problems(linkId: string, options: { resolved?: boolean } = {}): ProblemRow[] {
  return db().all<ProblemRow>(`SELECT * FROM notion_brain_problems WHERE link_id = ? AND resolved_at IS ${options.resolved ? 'NOT ' : ''}NULL ORDER BY at DESC, id`, linkId);
}

export const problemById = (id: string): ProblemRow | undefined => db().get<ProblemRow>('SELECT * FROM notion_brain_problems WHERE id = ?', id);

/** A problem for a person (Landflow's words and ids, never page text). An open problem of the same kind about the same object is not added twice. */
export function addProblem(input: { linkId: string; kind: ProblemKind; notionId?: string; localKey?: string; detail: string }): ProblemRow {
  const existing = db().get<ProblemRow>('SELECT * FROM notion_brain_problems WHERE link_id = ? AND kind = ? AND COALESCE(notion_id, ?) = ? AND COALESCE(local_key, ?) = ? AND resolved_at IS NULL', input.linkId, input.kind, '', input.notionId ?? '', '', input.localKey ?? '');
  if (existing) return existing;
  const row: ProblemRow = { id: `nbp_${randomUUID()}`, link_id: input.linkId, kind: input.kind, notion_id: input.notionId ?? null, local_key: input.localKey ?? null, detail: input.detail, at: now(), resolved_by: null, resolved_action: null, resolved_at: null };
  db().upsert('notion_brain_problems', row as unknown as Record<string, never>);
  return row;
}

export function resolveProblem(id: string, by: string | undefined, action: ProblemAction): ProblemRow | undefined {
  const row = problemById(id);
  if (!row) return undefined;
  const next = { ...row, resolved_by: by ?? 'system', resolved_action: action, resolved_at: now() };
  db().upsert('notion_brain_problems', next as unknown as Record<string, never>);
  return next;
}

export interface ProblemActionContext {
  link: LinkRow;
  problem: ProblemRow;
  action: Exclude<ProblemAction, 'dismiss'>;
  actorId?: string;
}

/** Performs `repair`, `putBack`, `deleteLocal` and `keepAsFact` (NB05 registers it); it resolves the problem when it succeeds. */
export type ProblemActionPort = (context: ProblemActionContext) => Promise<void> | void;
let performer: ProblemActionPort | undefined;
export function setProblemActions(fn: ProblemActionPort | undefined): void {
  performer = fn;
}
export const problemActionsReady = (): boolean => Boolean(performer);

/** Runs an action other than `dismiss`; throws when nothing performs it yet. */
export async function performProblemAction(context: ProblemActionContext): Promise<void> {
  if (!performer) throw new Error('Not available yet');
  await performer(context);
}

export function problemView(row: ProblemRow, options: { member?: boolean; offered: readonly ProblemAction[]; notionUrl?: string }): LinkProblemView {
  return {
    id: row.id,
    kind: row.kind,
    ...(options.member !== false && row.notion_id && { notionId: row.notion_id }),
    ...(options.member !== false && options.notionUrl && { notionUrl: options.notionUrl }),
    ...(row.local_key && { localKey: row.local_key }),
    detail: row.detail,
    at: row.at,
    actions: [...options.offered],
  };
}

// ---------------------------------------------------------------------------------------------------- the view

/** What a person sees of a link: no key, only the credential's id and name. A deleted credential keeps its id and reads "(deleted)". */
export function linkView(link: LinkRow, viewer: { member?: boolean; canManage: boolean }): LinkView {
  const member = viewer.member !== false;
  const off = !notionBrainEnabled() && link.status !== 'unlinked';
  const status: LinkStatus = off ? 'paused' : link.status;
  const reason = off ? SWITCHED_OFF : (link.reason ?? link.last_error ?? undefined);
  const copy = parseJson<CopyProgress>(link.copy);
  const waiting = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notion_brain_outbox WHERE link_id = ?', link.id)?.n ?? 0;
  const open = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notion_brain_problems WHERE link_id = ? AND resolved_at IS NULL', link.id)?.n ?? 0;
  let credentialName = '(deleted)';
  try {
    credentialName = credentials.get(link.credential_id)?.name ?? credentialName;
  } catch {
    // The vault not loaded: the id alone.
  }
  return {
    linked: true,
    id: link.id,
    projectId: link.project_id,
    status,
    ...(reason && { reason }),
    credential: { id: link.credential_id, name: credentialName },
    rootPageId: member ? link.root_page_id : '',
    ...(member && link.root_url && { rootUrl: link.root_url }),
    ...(link.root_title && { rootTitle: link.root_title }),
    ...(member && link.brain_page_id && { brainPageId: link.brain_page_id }),
    ...(member && link.brain_page_id && link.root_url && { brainUrl: `https://www.notion.so/${link.brain_page_id.replace(/-/g, '')}` }),
    ...(link.workspace_name && { workspaceName: link.workspace_name }),
    ...(link.bot_name && { botName: link.bot_name }),
    knowledgeScope: link.knowledge_scope,
    rps: link.rps,
    ...(copy && { copy }),
    ...(link.last_push_at && { lastPushAt: link.last_push_at }),
    ...(link.last_pull_at && { lastPullAt: link.last_pull_at }),
    waiting,
    problems: open,
    ...(link.created_by && { createdBy: link.created_by }),
    createdAt: link.created_at,
    updatedAt: link.updated_at,
    canManage: viewer.canManage,
  };
}

/** What a status means in words (the Brain card's headline). */
export const statusLabel = (status: LinkStatus): string => LINK_STATUS_LABELS[status];
export const isStopped = (status: LinkStatus): boolean => STOPPED_STATUSES.includes(status) || !notionBrainEnabled();

// ---------------------------------------------------------------------------------------------------- the resolver

/**
 * Which backend a project's brain uses: Notion for a project with a link that is not `unlinked` and whose project still
 * exists (no store yet: NB04 supplies it, and until then the local store reports `notion`), local for everything else, and
 * for every project when the instance switched the Notion brain off.
 */
setBackendResolver((projectId) => {
  if (!notionBrainEnabled()) return { backend: 'local' };
  try {
    return getLink(projectId) ? { backend: 'notion' } : { backend: 'local' };
  } catch (error) {
    logger.warn('[notion-brain] the link lookup failed; using the local store', { projectId, error });
    return { backend: 'local' };
  }
});
