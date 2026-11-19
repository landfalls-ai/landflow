/**
 * Looking at a Notion page before it is linked (docs/features/notion-brain.md#setting-it-up): who the key is, what the page
 * is, whether a Landflow brain is already under it, and what a copy of this project would do. It reads Notion and writes
 * nothing, to Notion or here. The Notion client comes through lib/server/notion/port.ts only.
 */
import { brainPageTitle, estimateMinutes, LANDFLOW_ID, RPS_DEFAULT, type BrainCounts, type CheckResult } from '../../../shared/notion-brain';
import { credentials } from '../../credentials/vault';
import { database } from '../../db';
import { credentialUsableBy } from '../../projects/access';
import { ProjectError, type ProjectRecord } from '../../projects/store';
import { isNotionError, notionClientFor, notionId, type NotionClient, type NotionPage } from '../../notion/port';
import { linkOfRoot, notionBrainEnabled, SWITCHED_OFF } from './links';

export const NOTION_CREDENTIAL_TYPES = ['productivity.notionApi', 'productivity.notionOAuth2Api'];

/** What the project holds that a copy would send (private and team-only work never goes: only project-scope notes). */
export function projectCounts(projectId: string): BrainCounts {
  const count = (sql: string) => database().get<{ n: number }>(sql, projectId)?.n ?? 0;
  return {
    pages: count('SELECT COUNT(*) AS n FROM brain_entities WHERE project_id = ?'),
    facts: count("SELECT COUNT(*) AS n FROM brain_facts WHERE project_id = ? AND status = 'active'"),
    practices: count("SELECT COUNT(*) AS n FROM practices WHERE project_id = ? AND status <> 'retired'"),
    notes: count("SELECT COUNT(*) AS n FROM team_notes WHERE project_id = ? AND scope = 'project'"),
  };
}

const titleOf = (page: NotionPage): string => {
  const property = Object.values(page.properties ?? {}).find((value) => value.type === 'title');
  return (property?.title ?? []).map((part) => part.plain_text ?? part.text?.content ?? '').join('').trim() || 'Untitled';
};

export interface CheckedPage {
  result: CheckResult;
  rootPageId: string;
  botId?: string;
  botName?: string;
  workspaceName?: string;
}

/** The words a failing Notion call is answered with (never the key, never page text). */
function failure(err: unknown, botName?: string): ProjectError {
  if (err instanceof ProjectError) return err; // NB07: the deadline's 504
  if (!isNotionError(err)) return new ProjectError('Landflow could not ask Notion', 502);
  if (err.kind === 'notFound') return new ProjectError(`Landflow can't see this page: open it in Notion → ••• → Add connections → ${botName ?? 'the Landflow connection'}`, 404);
  if (err.kind === 'unauthorized') return new ProjectError('Notion refused the key', 400);
  if (err.kind === 'forbidden') return new ProjectError('Notion says this key may not read that page: check the connection\'s access in Notion', 400);
  if (err.kind === 'blocked') return new ProjectError('Notion blocked this request; try again later', 429);
  return new ProjectError(`Notion did not answer (${err.kind}); try again in a moment`, 502);
}

/**
 * Whether a "Landflow brain" page, or any child page holding a database with a `Landflow ID` property, is under the root.
 * NB07: it stops starting new reads once `expired()` and answers what it has; `partial` holds the answer so far, so the caller
 * can answer at the deadline even while a read is still waiting (the title pass finds the named page first).
 */
async function findBrain(client: NotionClient, rootId: string, projectName: string, expired: () => boolean, partial: { found: boolean; pageId?: string }): Promise<{ found: boolean; pageId?: string }> {
  const title = brainPageTitle(projectName);
  const pages: Array<{ id: string; title: string }> = [];
  for await (const block of client.paginate((cursor) => client.children(rootId, cursor))) {
    if (block.type === 'child_page' && !block.in_trash) pages.push({ id: block.id, title: block.child_page?.title ?? '' });
  }
  const named = pages.find((p) => p.title === title);
  if (named) return Object.assign(partial, { found: true, pageId: named.id });
  for (const candidate of pages.slice(0, 20)) {
    if (expired()) break; // NB07:
    try {
      for await (const block of client.paginate((cursor) => client.children(candidate.id, cursor))) {
        if (expired()) return partial; // NB07:
        if (block.type !== 'child_database') continue;
        const source = (await client.database(block.id)).data_sources?.[0];
        if (source && LANDFLOW_ID in (await client.dataSource(source.id)).properties) return Object.assign(partial, { found: true, pageId: candidate.id });
      }
    } catch (err) {
      if (!isNotionError(err)) throw err;
      // A child Landflow can't read is not a brain.
    }
  }
  return partial;
}

// NB07: the check's time cap and one check per project ---------------------------------------------------------------

/** How long one check may take before it answers 504 (or, once the page is read, what it has found). */
export let CHECK_DEADLINE_MS = 15_000;
/** Tests only: a shorter (or, with no argument, the default) deadline. */
export function setCheckDeadline(ms?: number): void {
  CHECK_DEADLINE_MS = ms ?? 15_000;
}

const TOO_SLOW = 'Notion took too long to answer. Try Check again in a moment.';

/** The checks running now, one per project: what they check, and the answer the second identical check shares. */
const running = new Map<string, { credentialId: string; rootPageId: string; promise: Promise<CheckedPage> }>();

/** Races `work` against the deadline: a 504 when it is not done in time. The late answer is dropped (its failure too). */
function within<T>(work: Promise<T>, deadline: { at: number }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProjectError(TOO_SLOW, 504)), Math.max(0, deadline.at - Date.now()));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Checks `page` with a credential for `project`. Throws ProjectError: 409 (switched off, or the page is linked to another
 * project), 400 (credential of another type, a page that does not parse, a refused key), 403 (credential the project may not
 * use), 404 (the page is not shared with the key).
 */
export async function checkPage(project: Pick<ProjectRecord, 'id' | 'name'>, input: { credentialId: string; page: string; rps?: number }): Promise<CheckedPage> {
  if (!notionBrainEnabled()) throw new ProjectError(SWITCHED_OFF, 409);
  const credential = credentials.get(input.credentialId);
  if (!credential) throw new ProjectError('That credential does not exist', 400);
  if (!NOTION_CREDENTIAL_TYPES.includes(credential.type)) throw new ProjectError('Pick a Notion API credential (productivity.notionApi)', 400);
  if (!credentialUsableBy(input.credentialId, project.id)) throw new ProjectError('This project may not use that credential: share it with the project first', 403);
  const rootPageId = notionId(input.page);
  if (!rootPageId) throw new ProjectError('That is not a Notion page link or id', 400);
  const other = linkOfRoot(rootPageId);
  if (other && other.project_id !== project.id) throw new ProjectError('That Notion page is linked to another project already', 409);

  // NB07: a second check of the same page with the same key shares the running one; any other waits its turn.
  const current = running.get(project.id);
  if (current) {
    if (current.credentialId === input.credentialId && current.rootPageId === rootPageId) return current.promise;
    throw new ProjectError('A check of this project is running; try again when it ends', 409);
  }
  const promise = runCheck(project, input, rootPageId);
  const entry = { credentialId: input.credentialId, rootPageId, promise };
  running.set(project.id, entry);
  try {
    return await promise;
  } finally {
    if (running.get(project.id) === entry) running.delete(project.id);
  }
}

/** The reads of one check, inside the deadline (NB07). */
async function runCheck(project: Pick<ProjectRecord, 'id' | 'name'>, input: { credentialId: string; page: string; rps?: number }, rootPageId: string): Promise<CheckedPage> {
  const deadline = { at: Date.now() + CHECK_DEADLINE_MS };
  const client = notionClientFor({ credentialId: input.credentialId, rps: input.rps });
  let me;
  try {
    me = await within(client.me(), deadline);
  } catch (err) {
    throw failure(err);
  }
  const botName = me.name ?? undefined;
  let root: NotionPage;
  const partial: { found: boolean; pageId?: string } = { found: false };
  let existingBrain: { found: boolean; pageId?: string };
  try {
    root = await within(client.page(rootPageId), deadline);
    const search = findBrain(client, rootPageId, project.name, () => Date.now() >= deadline.at, partial);
    search.catch(() => undefined); // a late failure after the deadline is dropped
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<typeof partial>((resolve) => {
      timer = setTimeout(() => resolve(partial), Math.max(0, deadline.at - Date.now()));
    });
    try {
      existingBrain = await Promise.race([search, cap]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    throw failure(err, botName);
  }
  const counts = projectCounts(project.id);
  return {
    rootPageId,
    botId: me.id,
    botName,
    workspaceName: me.bot?.workspace_name ?? undefined,
    result: {
      title: titleOf(root),
      url: root.url,
      ...(me.bot?.workspace_name && { workspaceName: me.bot.workspace_name }),
      ...(botName && { botName }),
      existingBrain: { ...existingBrain },
      counts,
      estimateMinutes: estimateMinutes(counts, input.rps ?? RPS_DEFAULT),
    },
  };
}

/**
 * NB07: checks a link's own page again (and its brain page, when it has one) with `credentialId`: the way back from a refused
 * key or an unshared page. Writes nothing. Throws what `checkPage` throws; a brain page the key cannot read is a 404.
 */
export async function recheckLink(
  project: Pick<ProjectRecord, 'id' | 'name'>,
  link: { root_page_id: string; brain_page_id: string | null },
  credentialId: string,
): Promise<CheckedPage> {
  const checked = await checkPage(project, { credentialId, page: link.root_page_id });
  if (link.brain_page_id) {
    const deadline = { at: Date.now() + CHECK_DEADLINE_MS };
    try {
      const page = await within(notionClientFor({ credentialId }).page(link.brain_page_id), deadline);
      if (page.in_trash) throw new ProjectError(`Landflow can't see the Landflow brain page: share it with ${checked.botName ?? 'the Landflow connection'} again (••• → Add connections)`, 404);
    } catch (err) {
      throw failure(err, checked.botName);
    }
  }
  return checked;
}
