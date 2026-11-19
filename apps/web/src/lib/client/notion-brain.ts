'use client';
/**
 * The Notion brain as the browser reads it (wave nb3, docs/features/notion-brain.md#setting-it-up): the project's link, the
 * check, connect, sync, pause, key change and disconnect calls, the problems and their actions, the Notion keys a project may
 * use, and the words the project's Brain card, the Brain page's chip and Spotlight's card share, so every screen says the
 * same sentence. No zod and no secret: a key is only ever a credential's id and name.
 *
 * Wave nb3: NB07 owns it (backbone/contracts/nb/notion-brain-client.ts); NB08 adds it byte for byte. Change it in the
 * contract first, then both copies.
 */
import { api } from './api';
import {
  ADMIN_PROBLEM_ACTIONS,
  LINK_STATUS_LABELS,
  type CheckResult,
  type CopyProgress,
  type LinkCreateInput,
  type LinkPatchInput,
  type LinkProblemView,
  type LinkStatus,
  type LinkStatusView,
  type LinkView,
  type ProblemAction,
} from '../shared/notion-brain';

// ---------------------------------------------------------------------------------------------------- the keys

/** The credential types a Notion key can be (the check refuses any other). */
export const NOTION_KEY_TYPES: readonly string[] = ['productivity.notionApi', 'productivity.notionOAuth2Api'];
/** The type "New Notion key" creates: the internal connection's secret (decision D5). */
export const NOTION_KEY_TYPE = 'productivity.notionApi';

export interface NotionKey {
  id: string;
  name: string;
  type: string;
}

/** The Notion keys among `credentials`, by name. */
export function notionKeysOf(credentials: ReadonlyArray<{ id: string; name: string; type: string }>): NotionKey[] {
  return credentials
    .filter((c) => NOTION_KEY_TYPES.includes(c.type))
    .map(({ id, name, type }) => ({ id, name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The key to preselect: the only one when exactly one fits (the credential auto-pick rule), else none. */
export const preselectedKey = (keys: readonly NotionKey[]): NotionKey | undefined => (keys.length === 1 ? keys[0] : undefined);

/** The Notion keys the project may use (its own and those shared with it: `GET /api/credentials?projectId=`). */
export async function projectNotionKeys(projectId: string): Promise<NotionKey[]> {
  const { credentials } = await api<{ credentials: Array<{ id: string; name: string; type: string }> }>(`/api/credentials?projectId=${encodeURIComponent(projectId)}`);
  return notionKeysOf(credentials);
}

// ---------------------------------------------------------------------------------------------------- the routes

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/brain/notion`;

/** GET: the link (a member), or `{ linked: false, canManage }`. `background` for a poll. */
export const notionLink = (projectId: string, background = false) => api<LinkStatusView>(base(projectId), { background });

/** POST …/check: what the page is and what a copy would do; writes nothing (an admin). */
export const checkNotionPage = (projectId: string, input: { credentialId: string; page: string }) => api<CheckResult>(`${base(projectId)}/check`, { method: 'POST', json: input });

/** POST: link the page; the copy starts on the sync's next tick (an admin). */
export const connectNotion = (projectId: string, input: LinkCreateInput) => api<LinkView>(base(projectId), { method: 'POST', json: input });

/** PATCH: pause, resume or try again, the speed, the knowledge scope, another key (an admin). */
export const changeNotionLink = (projectId: string, input: LinkPatchInput) => api<LinkView>(base(projectId), { method: 'PATCH', json: input });

/** POST …/sync: the next sync is due now (an admin). */
export const syncNotionNow = (projectId: string) => api<LinkView>(`${base(projectId)}/sync`, { method: 'POST' });

/** DELETE: Landflow stops syncing; Notion keeps its pages and Landflow its brain (an admin). */
export const disconnectNotion = (projectId: string) => api<{ ok: true; linked: false; message: string }>(base(projectId), { method: 'DELETE' });

/** GET …/problems: the link's open problems (a member). */
export const notionProblems = (projectId: string, background = false) => api<LinkProblemView[]>(`${base(projectId)}/problems`, { background });

/** POST …/problems/:id: resolve one (editors; `repair` and `deleteLocal` an admin). */
export const actOnNotionProblem = (projectId: string, problemId: string, action: ProblemAction) =>
  api<{ id: string; resolved: true; action: ProblemAction; by?: string; at?: string }>(`${base(projectId)}/problems/${encodeURIComponent(problemId)}`, { method: 'POST', json: { action } });

// ---------------------------------------------------------------------------------------------------- the words

/** "just now", "1 minute ago", "2 hours ago", "3 days ago". */
export function syncedAgo(iso: string | undefined, now: number = Date.now()): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** When it last synced: the later of the last push and the last pull. */
export function lastSyncAt(view: Pick<LinkView, 'lastPushAt' | 'lastPullAt'>): string | undefined {
  const [push, pull] = [view.lastPushAt, view.lastPullAt];
  if (!push || !pull) return push ?? pull;
  return Date.parse(push) >= Date.parse(pull) ? push : pull;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What one copy step is called. */
const PHASES: Readonly<Record<CopyProgress['phase'], string>> = {
  pages: 'the brain page',
  databases: 'the databases',
  rows: 'the pages',
  bodies: 'the page bodies',
  facts: 'the facts',
  practices: 'the practices',
  notes: 'the notes',
  home: 'Home',
  done: 'done',
};

/** The copy as a fraction (0 to 1) and in words ("Copying the pages · 120 of 300"); undefined when no copy runs. */
export function copyLine(copy: CopyProgress | undefined): { fraction: number; words: string } | undefined {
  if (!copy || copy.phase === 'done') return undefined;
  const fraction = copy.total > 0 ? Math.min(1, Math.max(0, copy.done / copy.total)) : 0;
  return { fraction, words: `Copying ${PHASES[copy.phase]} · ${copy.done} of ${copy.total}` };
}

/**
 * The one status line: "Lives in Landflow" when unlinked; else the status label, then for a link that syncs "synced 2 minutes
 * ago · 0 waiting · 1 problem", for a copy its progress, and for a stopped link its reason.
 */
export function statusSentence(view: LinkStatusView, now: number = Date.now()): string {
  if (!view.linked) return 'Lives in Landflow';
  const parts: string[] = [LINK_STATUS_LABELS[view.status]];
  const copying = copyLine(view.copy);
  if (copying) parts.push(copying.words);
  if (view.status === 'active' || view.status === 'copying' || view.status === 'setting_up') {
    const ago = syncedAgo(lastSyncAt(view), now);
    if (ago && view.status === 'active') parts.push(`synced ${ago}`);
    parts.push(`${view.waiting} waiting`, count(view.problems, 'problem'));
  } else if (view.reason && view.reason !== parts[0]) {
    parts.push(view.reason);
  }
  return parts.join(' · ');
}

/** The chip's tone: red for a refused key or an unshared page, amber for problems, a pause or a repair, muted when unlinked. */
export function statusTone(view: LinkStatusView): 'ok' | 'warning' | 'danger' | 'muted' {
  if (!view.linked || view.status === 'unlinked') return 'muted';
  if (view.status === 'unauthorized' || view.status === 'unshared') return 'danger';
  if (view.status === 'paused' || view.status === 'needs_repair' || view.problems > 0) return 'warning';
  return 'ok';
}

/** What fixes a stopped link: one sentence and the one button that does it. */
export const STATUS_FIX: Readonly<Partial<Record<LinkStatus, { sentence: string; action: 'pickKey' | 'checkAgain' | 'resume' | 'repair'; button: string }>>> = {
  unauthorized: { sentence: 'Notion refused the key. Pick another Notion key, or update this one, then try again.', action: 'pickKey', button: 'Pick another key' },
  unshared: { sentence: 'Landflow can’t see the page any more. In Notion, share it with the connection again (••• → Add connections), then check again.', action: 'checkAgain', button: 'Check again' },
  paused: { sentence: 'Nothing syncs while it is paused; changes wait and go out when it resumes.', action: 'resume', button: 'Resume' },
  needs_repair: { sentence: 'A property Landflow needs was removed or renamed in Notion. Repair puts it back.', action: 'repair', button: 'Repair' },
};

/** What a problem action's button says. */
export const PROBLEM_ACTION_LABELS: Readonly<Record<ProblemAction, string>> = {
  dismiss: 'Dismiss',
  repair: 'Repair',
  putBack: 'Put back',
  deleteLocal: 'Delete in Landflow',
  keepAsFact: 'Keep as a fact',
};

/** The actions on a problem this viewer may press: editors act, `repair` and `deleteLocal` need an admin (the route checks again). */
export function actionsFor(problem: Pick<LinkProblemView, 'actions'>, viewer: { canEdit: boolean; canManage: boolean }): ProblemAction[] {
  if (!viewer.canEdit && !viewer.canManage) return [];
  return problem.actions.filter((action) => viewer.canManage || !ADMIN_PROBLEM_ACTIONS.includes(action));
}

/** Spotlight's answer to "is the brain in sync?": the status in words, and the first problem when there is one. */
export function statusAnswer(view: LinkStatusView, problems: readonly Pick<LinkProblemView, 'detail'>[], now: number = Date.now()): string {
  if (!view.linked) return 'This project’s brain lives in Landflow: it is not linked to Notion.';
  const where = view.rootTitle ? ` under “${view.rootTitle}”` : '';
  const first = problems[0] ? `: ${problems[0].detail}` : '';
  if (view.status === 'active') {
    const ago = syncedAgo(lastSyncAt(view), now);
    return `The brain is in Notion${where}. ${ago ? `Synced ${ago}` : 'Not synced yet'}, ${view.waiting} waiting, ${count(view.problems, 'problem')}${first}.`;
  }
  const fix = STATUS_FIX[view.status];
  return `The brain is linked to Notion${where}: ${statusSentence(view, now)}.${fix ? ` ${fix.sentence}` : ''}`;
}
