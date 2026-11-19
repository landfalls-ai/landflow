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
  if (!isNotionError(err)) return new ProjectError('Landflow could not ask Notion', 502);
  if (err.kind === 'notFound') return new ProjectError(`Landflow can't see this page: open it in Notion → ••• → Add connections → ${botName ?? 'the Landflow connection'}`, 404);
  if (err.kind === 'unauthorized') return new ProjectError('Notion refused the key', 400);
  if (err.kind === 'forbidden') return new ProjectError('Notion says this key may not read that page: check the connection\'s access in Notion', 400);
  if (err.kind === 'blocked') return new ProjectError('Notion blocked this request; try again later', 429);
  return new ProjectError(`Notion did not answer (${err.kind}); try again in a moment`, 502);
}

/** Whether a "Landflow brain" page, or any child page holding a database with a `Landflow ID` property, is under the root. */
async function findBrain(client: NotionClient, rootId: string, projectName: string): Promise<{ found: boolean; pageId?: string }> {
  const title = brainPageTitle(projectName);
  const pages: Array<{ id: string; title: string }> = [];
  for await (const block of client.paginate((cursor) => client.children(rootId, cursor))) {
    if (block.type === 'child_page' && !block.in_trash) pages.push({ id: block.id, title: block.child_page?.title ?? '' });
  }
  const named = pages.find((p) => p.title === title);
  if (named) return { found: true, pageId: named.id };
  for (const candidate of pages.slice(0, 20)) {
    try {
      for await (const block of client.paginate((cursor) => client.children(candidate.id, cursor))) {
        if (block.type !== 'child_database') continue;
        const source = (await client.database(block.id)).data_sources?.[0];
        if (source && LANDFLOW_ID in (await client.dataSource(source.id)).properties) return { found: true, pageId: candidate.id };
      }
    } catch (err) {
      if (!isNotionError(err)) throw err;
      // A child Landflow can't read is not a brain.
    }
  }
  return { found: false };
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

  const client = notionClientFor({ credentialId: input.credentialId, rps: input.rps });
  let me;
  try {
    me = await client.me();
  } catch (err) {
    throw failure(err);
  }
  const botName = me.name ?? undefined;
  let root: NotionPage;
  let existingBrain: { found: boolean; pageId?: string };
  try {
    root = await client.page(rootPageId);
    existingBrain = await findBrain(client, rootPageId, project.name);
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
      existingBrain,
      counts,
      estimateMinutes: estimateMinutes(counts, input.rps ?? RPS_DEFAULT),
    },
  };
}
