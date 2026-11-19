/**
 * How the Notion brain's sync changes a link's status and says so (docs/features/notion-brain.md#how-it-is-built): a failure
 * that stops the whole link (a refused or deleted key, a page that is no longer shared, Notion blocking the key) sets the
 * status and its reason, and each change of status files one brain suggestion for the project's admins. Words and ids only:
 * never a key, never page text.
 */
import type { AudienceMember } from '../../../shared/brain';
import { MAX_AUDIENCE } from '../../../shared/brain';
import { LINK_STATUS_LABELS, type LinkStatus } from '../../../shared/notion-brain';
import { projectRoleCan } from '../../../shared/projects';
import { listUsers } from '../../auth/users';
import { isNotionError, notionClientFor, sameId, type NotionErrorInfo } from '../../notion/port';
import { projectRole } from '../../projects/access';
import { getProject } from '../../projects/store';
import { logger } from '../../telemetry/logger';
import { upsertProposal } from '../proposals';
import { linkById, setStatus, type LinkRow } from './links';

/** Thrown to end the work on a link whose status was just changed (the caller stops, the next tick sees the new status). */
export class LinkStopped extends Error {
  constructor(readonly status: LinkStatus) {
    super(`The Notion link stopped: ${status}`);
  }
}

const audienceOf = (projectId: string): AudienceMember[] =>
  listUsers()
    .filter((u) => !u.disabledAt && projectRoleCan.manage(projectRole(u, projectId)))
    .slice(0, MAX_AUDIENCE)
    .map((u) => ({ userId: u.id, email: u.email.toLowerCase(), name: u.name }));

const HEADLINES: Partial<Record<LinkStatus, string>> = {
  active: 'The brain is in Notion',
  paused: 'The Notion brain is paused',
  unauthorized: 'Notion refused the key',
  unshared: 'The Notion page is no longer shared',
  needs_repair: 'The Notion brain needs a repair',
};

/** One brain suggestion per link and status (the fingerprint refreshes it): the project's admins are told. Never throws. */
export function fileStatusNotice(link: Pick<LinkRow, 'id' | 'project_id' | 'root_title'>, status: LinkStatus, reason?: string): void {
  const headline = HEADLINES[status];
  if (!headline) return;
  try {
    const project = getProject(link.project_id);
    upsertProposal({
      source: 'analyst',
      label: 'Notion brain',
      fingerprint: `notion-brain:${link.id}:${status}`,
      projectId: link.project_id,
      target: { type: 'instance', name: 'Notion brain' },
      title: `${headline}${project ? `: ${project.name}` : ''}`,
      why: `${LINK_STATUS_LABELS[status]}.${reason ? ` ${reason}` : ''} Open the project's Brain settings to see what to do next.`,
      evidence: [{ label: 'Status', value: LINK_STATUS_LABELS[status] }],
      ops: [],
      audience: audienceOf(link.project_id),
      risk: 'low',
      confidence: 0.9,
      score: status === 'active' ? 3 : 6,
    });
  } catch (error) {
    logger.warn('[notion-brain] a status notice could not be filed', { linkId: link.id, status, error: (error as Error).message });
  }
}

/** Change a link's status and file the notice, once: a change to the status it already has does nothing. */
export function changeStatus(linkId: string, status: LinkStatus, reason?: string): LinkRow | undefined {
  const link = linkById(linkId);
  if (!link) return undefined;
  if (link.status === status && (link.reason ?? undefined) === reason) return link;
  const next = setStatus(linkId, status, reason);
  if (link.status !== status && next) fileStatusNotice(next, status, reason);
  return next;
}

/** The reason a person reads for a key Notion (or the vault) no longer accepts. */
export const keyReason = (error: NotionErrorInfo): string => (error.status === 0 ? 'The Notion key was deleted' : 'Notion refused the key');

/**
 * What a failure means for the whole link. A key that is gone or refused stops it as `unauthorized`; Notion blocking the key
 * pauses it with Notion's code. Throws `LinkStopped` for those, returns for any other failure (the object's own error).
 */
export function stopOnLinkFailure(linkId: string, error: unknown): void {
  if (!isNotionError(error)) return;
  if (error.kind === 'unauthorized') {
    changeStatus(linkId, 'unauthorized', keyReason(error));
    throw new LinkStopped('unauthorized');
  }
  if (error.kind === 'blocked') {
    changeStatus(linkId, 'paused', `Notion blocked this key${error.code ? ` (${error.code})` : ''}; it stays paused until an admin resumes it`);
    throw new LinkStopped('paused');
  }
}

/** After a 404: whether the root or the brain page is the missing one (then the link is `unshared`). Reads only. */
export async function checkStillShared(link: LinkRow): Promise<void> {
  const client = notionClientFor({ credentialId: link.credential_id, rps: link.rps });
  for (const id of [link.root_page_id, link.brain_page_id]) {
    if (!id) continue;
    try {
      const page = await client.page(id);
      if (page.in_trash) throw new LinkStopped(markUnshared(link, id));
    } catch (error) {
      if (error instanceof LinkStopped) throw error;
      if (isNotionError(error) && error.kind === 'notFound') throw new LinkStopped(markUnshared(link, id));
      stopOnLinkFailure(link.id, error);
      throw error;
    }
  }
}

function markUnshared(link: LinkRow, id: string): LinkStatus {
  const which = sameId(id, link.root_page_id) ? (link.root_title ? `"${link.root_title}"` : 'the page') : 'the brain page';
  changeStatus(link.id, 'unshared', `Share ${which} with the Notion connection again`);
  return 'unshared';
}
