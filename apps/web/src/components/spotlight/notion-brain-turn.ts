/**
 * What Spotlight shows for a Notion-brain ask (docs/spotlight.md#moving-a-brain-to-notion). No React and no model: it reads the
 * project's link, problems and keys through the browser's client contract (`lib/client/notion-brain.ts`, names only, never a
 * secret) and returns the words or the card's data. Nothing here writes: Connect and copy is the person's click on the card.
 */
import type { LinkStatusView } from '@/lib/shared/notion-brain';
import type { NotionBrainAsk } from '@/lib/shared/notion-brain-ask';
import { notionLink, notionProblems, preselectedKey, projectNotionKeys, statusAnswer, statusSentence, type NotionKey } from '@/lib/client/notion-brain';

/** What a key-shaped text is answered with. */
export const KEY_WARNING =
  'That looks like a Notion key. Keys don’t belong in a chat: add it in the credential dialog (New Notion key), where it is kept encrypted. It was not sent or saved.';

/** A project the viewer may name: id, name and the viewer's role in it. */
export interface TurnProject {
  id: string;
  name: string;
  role?: string;
}

/** The card's data for one project: its link, its keys by name, the key to preselect. */
export interface NotionBrainCardData {
  projectId: string;
  link: LinkStatusView;
  keys: NotionKey[];
  preselected?: NotionKey;
  canManage: boolean;
}

export type NotionBrainReply =
  | { kind: 'text'; text: string }
  /** `data` is there when the project is known; else the card lets the person pick one of `projects`. */
  | { kind: 'card'; page?: string; projectId?: string; projects: TurnProject[]; data?: NotionBrainCardData; text?: string }
  | { kind: 'key'; text: string; projectId?: string };

/** The link and the keys of one project, read through the client contract. */
export async function notionBrainCardData(projectId: string): Promise<NotionBrainCardData> {
  const [link, keys] = await Promise.all([notionLink(projectId), projectNotionKeys(projectId).catch((): NotionKey[] => [])]);
  const preselected = preselectedKey(keys);
  return { projectId, link, keys, ...(preselected && { preselected }), canManage: link.canManage };
}

const only = (projects: readonly TurnProject[], admin: boolean): TurnProject | undefined => {
  const list = admin ? projects.filter((p) => p.role === 'admin') : projects;
  return list.length === 1 ? list[0] : undefined;
};

/** The reply for `ask` on this page (`projectId` is the project whose page it is, when it is one). */
export async function notionBrainReply(ask: NotionBrainAsk, ctx: { projectId?: string; projects?: readonly TurnProject[] }): Promise<NotionBrainReply> {
  const projects = [...(ctx.projects ?? [])];
  if (ask.kind === 'key') return { kind: 'key', text: KEY_WARNING, ...(ctx.projectId && { projectId: ctx.projectId }) };
  try {
    if (ask.kind === 'status') {
      const id = ctx.projectId ?? only(projects, false)?.id;
      if (!id) return { kind: 'text', text: 'Ask from a project’s page, or name the project: I answer for one project at a time.' };
      const view = await notionLink(id);
      const problems = view.linked && view.problems > 0 ? await notionProblems(id).catch(() => []) : [];
      return { kind: 'text', text: statusAnswer(view, problems) };
    }
    const id = ctx.projectId ?? only(projects, true)?.id;
    const page = ask.page;
    if (!id) return { kind: 'card', projects: projects.filter((p) => p.role === 'admin'), ...(page && { page }) };
    const data = await notionBrainCardData(id);
    return { kind: 'card', projectId: id, projects, data, ...(page && { page }) };
  } catch (error) {
    return { kind: 'text', text: `I couldn’t read the Notion link: ${(error as Error).message}` };
  }
}

