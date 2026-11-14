/**
 * `GET /api/mentions`: what a person may tag with @, per kind (docs/assistant.md#tagging-with-). Each kind lists at most
 * `MENTION_LIMITS.perGroup` hits, a prefix match first and then the newest, among what the caller may open: access is
 * checked once per kind (`visibleIds`, `entityKeysFor`), never per item. Credentials and people give a name and a type
 * or a role, nothing else.
 */
import { MENTION_LIMITS, MENTION_TYPES, rankHits, type MentionGroup, type MentionHit, type MentionType } from '../../shared/mentions';
import { agentStore } from '../agents/store';
import { agentTeamStore } from '../agent-teams/store';
import { listUsers } from '../auth/users';
import { entityKeysFor, entityKey, listEntities } from '../brain/entities';
import { credentials } from '../credentials/vault';
import { dataTables } from '../datatables';
import { listExecutionsPage } from '../executions-query';
import { folders } from '../folders';
import { registry } from '../plugins/registry';
import { canResource, visibleIds, type Actor } from '../projects/access';
import { store } from '../store';
import { listTemplates } from '../templates';

export interface MentionSearch {
  q?: string;
  types?: readonly MentionType[];
  /** The workflow being edited: its nodes can be tagged, and its runs come first. */
  workflowId?: string;
}

/** A hit with the time that orders equal matches. */
type Found = MentionHit & { at?: string };

const strip = ({ at: _at, ...hit }: Found): MentionHit => hit;
const when = (iso: string | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

/** The ids of `kind` `actor` may open, as a set (undefined: all of them). */
const seen = (actor: Actor, kind: Parameters<typeof visibleIds>[1], ids: string[]) => visibleIds(actor, kind, ids);
const keep = <T extends { id: string }>(items: T[], visible: Set<string> | undefined) => (visible ? items.filter((i) => visible.has(i.id)) : items);

function workflows(actor: Actor): Found[] {
  const all = store.listWorkflows();
  const visible = seen(actor, 'workflow', all.map((w) => w.id));
  const folderName = new Map(folders.list().map((f) => [f.id, f.name]));
  return keep(all, visible).map((w) => ({ type: 'workflow', id: w.id, name: w.name, ...(w.folderId && folderName.get(w.folderId) && { hint: folderName.get(w.folderId) }), ...(w.updatedAt && { at: w.updatedAt }) }));
}

function nodes(actor: Actor, workflowId: string | undefined): Found[] {
  if (!workflowId || !canResource(actor, 'workflow', workflowId, 'read')) return [];
  const workflow = store.getWorkflow(workflowId);
  return (workflow?.nodes ?? []).map((n) => ({ type: 'node', id: n.id, workflowId, name: n.name, hint: n.type }));
}

function runs(actor: Actor, workflowId: string | undefined): Found[] {
  const all = store.listWorkflows().map((w) => w.id);
  const visible = seen(actor, 'workflow', all);
  if (workflowId && visible && !visible.has(workflowId)) return [];
  // The newest runs of what the caller sees (one query, filtered in SQL by workflow); the picker narrows them by name.
  const page = listExecutionsPage({ limit: 100, ...(workflowId && { workflowId }), visibleWorkflowIds: visible ? [...visible] : null });
  return page.executions.map((e) => ({ type: 'run', id: e.id, workflowId: e.workflowId, name: `${e.workflowName} run`, hint: `${e.status} · ${when(e.startedAt)}`, at: e.startedAt }));
}

function agents(actor: Actor): Found[] {
  const all = agentStore.list();
  return keep(all, seen(actor, 'agent', all.map((a) => a.id))).map((a) => ({ type: 'agent', id: a.id, name: a.name, ...((a.persona?.role ?? a.team) && { hint: a.persona?.role ?? a.team }), at: a.updatedAt }));
}

function teams(actor: Actor): Found[] {
  const all = agentTeamStore.list();
  return keep(all, seen(actor, 'agentTeam', all.map((t) => t.id))).map((t) => ({ type: 'team', id: t.id, name: t.draft.name, ...(t.draft.goal && { hint: t.draft.goal.slice(0, 80) }), at: t.updatedAt }));
}

function tables(actor: Actor): Found[] {
  const all = dataTables().listTables();
  return keep(all, seen(actor, 'dataTable', all.map((t) => t.id))).map((t) => ({ type: 'dataTable', id: t.id, name: t.name, hint: `${t.rowCount} row${t.rowCount === 1 ? '' : 's'}`, at: t.updatedAt }));
}

async function templates(actor: Actor): Promise<Found[]> {
  // Saved and built-in ones only: a remote search would leave the machine on every keystroke.
  const [local, builtin] = await Promise.all([listTemplates({ source: 'local', viewer: actor }), listTemplates({ source: 'builtin', viewer: actor })]);
  return [...local.templates, ...builtin.templates].map((t) => ({ type: 'template', id: t.id, name: t.name, hint: t.source === 'local' ? 'saved template' : 'built-in template', ...((t.updatedAt ?? t.createdAt) && { at: t.updatedAt ?? t.createdAt }) }));
}

function nodeTypes(): Found[] {
  return registry.nodeTypes().map((t) => ({ type: 'nodeType', id: t.type, name: t.descriptor.displayName, hint: t.pluginName }));
}

function plugins(): Found[] {
  return registry.list().map((p) => ({ type: 'plugin', id: p.id, name: p.info.name, hint: p.status, at: p.updatedAt }));
}

function pages(actor: Actor): Found[] {
  const visible = entityKeysFor(actor);
  return listEntities({ limit: 2_000 })
    .filter((e) => !visible || visible.has(entityKey(e)))
    .map((e) => ({ type: 'brainPage', id: entityKey(e), name: e.name, hint: e.type, at: e.updatedAt }));
}

function people(): Found[] {
  return listUsers()
    .filter((u) => !u.disabledAt)
    .map((u) => ({ type: 'person', id: u.id, name: u.name || u.email.split('@')[0], hint: u.role }));
}

function credentialHits(actor: Actor): Found[] {
  const all = credentials.list();
  // Name and type only: no value, no data, no list of where it is used.
  return keep(all, seen(actor, 'credential', all.map((c) => c.id))).map((c) => ({ type: 'credential', id: c.id, name: c.name, hint: c.type, at: c.updatedAt }));
}

async function foundFor(actor: Actor, type: MentionType, search: MentionSearch): Promise<Found[]> {
  switch (type) {
    case 'workflow': return workflows(actor);
    case 'node': return nodes(actor, search.workflowId);
    case 'run': return runs(actor, search.workflowId);
    case 'agent': return agents(actor);
    case 'team': return teams(actor);
    case 'dataTable': return tables(actor);
    case 'template': return templates(actor);
    case 'nodeType': return nodeTypes();
    case 'plugin': return plugins();
    case 'brainPage': return pages(actor);
    case 'person': return people();
    case 'credential': return credentialHits(actor);
  }
}

/** The groups for `q`, in `MENTION_TYPES` order; a kind with no hit is left out. */
export async function searchMentions(actor: Actor, search: MentionSearch): Promise<MentionGroup[]> {
  const q = (search.q ?? '').trim();
  const wanted = new Set<MentionType>(search.types?.length ? search.types : MENTION_TYPES);
  const groups: MentionGroup[] = [];
  for (const type of MENTION_TYPES) {
    if (!wanted.has(type)) continue;
    const found = await foundFor(actor, type, search);
    const items = rankHits(found.map((f) => ({ ...f })), q, MENTION_LIMITS.perGroup).map(strip);
    if (items.length) groups.push({ type, items });
  }
  return groups;
}
