/**
 * Composite types (docs/composites.md): those plugins declare (core's `core.aiStep` among them, through the registry)
 * and the library saved on this instance (`local.<name>`, migration 1883 `composite_types`, one row per version), and
 * the lookup the server's checks read: the publish gate, template problems, the assistant and the runner's scopes.
 */
import { compositeTypeSchema, type CompositeTypeDescriptor } from '@landflow/protocol';
import { compositeIssues, compositeLookup, compositeReports, compositeScopes, describeMatcher, type CompositeIssue, type CompositeLookup, type CompositeScope, type CompositeTypeInfo } from '../shared/composites';
import { normalizeGroups } from '../shared/groups';
import type { Workflow } from '../shared/types';
import { database } from './db';
import { registry } from './plugins/registry';

/** Types saved on this instance are `local.<name>`. */
export const LOCAL_PREFIX = 'local.';

export class CompositeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface Row {
  name: string;
  version: number;
  created_by: string | null;
  created_at: string;
  data: string;
}

function localTypes(): CompositeTypeInfo[] {
  const rows = database().all<Row>('SELECT name, version, created_by, created_at, data FROM composite_types ORDER BY name, version DESC');
  const byName = new Map<string, Row[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  return [...byName.entries()].map(([name, list]) => {
    const all = list.map((row) => JSON.parse(row.data) as CompositeTypeDescriptor);
    const newest = list[0];
    return {
      type: `${LOCAL_PREFIX}${name}`,
      source: { kind: 'local' as const, ...(newest.created_by && { createdBy: newest.created_by }), updatedAt: newest.created_at },
      descriptor: all[0],
      versions: list.map((row) => Number(row.version)),
      ...(all.length > 1 && { all }),
      available: true,
    };
  });
}

/** Every composite type this instance knows: the plugins' (online or not), then the saved ones, by name. */
export function listCompositeTypes(): CompositeTypeInfo[] {
  const byName = (a: CompositeTypeInfo, b: CompositeTypeInfo) => a.descriptor.displayName.localeCompare(b.descriptor.displayName);
  return [...registry.compositeTypes().sort(byName), ...localTypes().sort(byName)];
}

/**
 * Save a type to the library (`local.<name>`). A name already saved gets a new version (frames built for the older
 * one keep it), numbered from the newest saved or the one given, whichever is higher.
 */
export function saveLocalComposite(input: unknown, createdBy?: string): CompositeTypeInfo {
  const parsed = compositeTypeSchema.safeParse(input);
  if (!parsed.success) throw new CompositeError('Invalid composite type', 400, parsed.error.issues.map((i) => `${i.path.join('.') || '(type)'}: ${i.message}`));
  const db = database();
  const latest = db.get<{ version: number | null }>('SELECT MAX(version) AS version FROM composite_types WHERE name = ?', parsed.data.name)?.version;
  const version = Math.max(parsed.data.version, latest ? Number(latest) + 1 : 1);
  const descriptor: CompositeTypeDescriptor = { ...parsed.data, version };
  db.upsert('composite_types', { name: descriptor.name, version, created_by: createdBy ?? null, created_at: new Date().toISOString(), data: JSON.stringify(descriptor) });
  return localTypes().find((info) => info.type === `${LOCAL_PREFIX}${descriptor.name}`)!;
}

/** Who saved a library type (its newest version), or undefined when it isn't saved. */
export function localCompositeOwner(type: string): { createdBy?: string } | undefined {
  if (!type.startsWith(LOCAL_PREFIX)) return undefined;
  const row = database().get<{ created_by: string | null }>('SELECT created_by FROM composite_types WHERE name = ? ORDER BY version DESC LIMIT 1', type.slice(LOCAL_PREFIX.length));
  return row ? { ...(row.created_by && { createdBy: row.created_by }) } : undefined;
}

/** Delete a library type, every version. Frames typed by it keep their nodes and show it as unknown. */
export function deleteLocalComposite(type: string): boolean {
  if (!type.startsWith(LOCAL_PREFIX)) return false;
  return database().delete('composite_types', { name: type.slice(LOCAL_PREFIX.length) }) > 0;
}

/** The lookup over the registry's node types and every composite type. */
export function serverCompositeLookup(): CompositeLookup {
  return compositeLookup(new Map(registry.nodeTypes().map((info) => [info.type, info.descriptor])), listCompositeTypes());
}

/** A workflow's composite issues against this instance's types; `[]` when it has no composite frames. */
export function workflowCompositeIssues(workflow: Pick<Workflow, 'nodes' | 'connections' | 'groups'>): CompositeIssue[] {
  if (!workflow.groups?.some((g) => g.composite)) return [];
  return compositeIssues(workflow, serverCompositeLookup());
}

/** The composite frames a run of the workflow treats as one step (fallback, timeout, `$composite.params`); undefined when none. */
export function workflowScopes(workflow: Pick<Workflow, 'nodes' | 'connections' | 'groups'>): CompositeScope[] | undefined {
  if (!workflow.groups?.some((g) => g.composite)) return undefined;
  const scopes = compositeScopes({ ...workflow, groups: normalizeGroups(workflow.groups, workflow.nodes.map((n) => n.id)) }, serverCompositeLookup());
  return scopes.length ? scopes : undefined;
}

type Graph = Pick<Workflow, 'nodes' | 'connections' | 'groups'>;

/** The graph with its groups normalised (an edit that removed nodes leaves their ids in the groups until then). */
const tidy = (workflow: Graph): Graph => ({ ...workflow, groups: normalizeGroups(workflow.groups, workflow.nodes.map((n) => n.id)) });
const issueKey = (i: CompositeIssue) => [i.groupId, i.code, i.slot ?? '', i.nodeId ?? ''].join('\u0000');

/** The contract errors an edit (the assistant's ops) introduces: what `after` breaks that `before` didn't. */
export function newCompositeErrors(before: Graph, after: Graph, lookup: CompositeLookup = serverCompositeLookup()): CompositeIssue[] {
  if (!after.groups?.some((g) => g.composite)) return [];
  const had = new Set(compositeIssues(tidy(before), lookup).map(issueKey));
  return compositeIssues(tidy(after), lookup).filter((i) => i.severity === 'error' && !had.has(issueKey(i)));
}

/** The workflow's composites for the assistant's context: each frame's slots, what fills them, its rules and issues. */
export function compositeOutline(workflow: Graph, lookup: CompositeLookup = serverCompositeLookup()): string {
  const names = new Map(workflow.nodes.map((n) => [n.id, n.name]));
  const groups = new Map((workflow.groups ?? []).map((g) => [g.id, g.name]));
  return compositeReports(tidy(workflow), lookup)
    .map((r) => {
      if (!r.descriptor) return `- “${r.name}” is typed by the composite ${r.type} (its contract isn’t available here)`;
      const slots = r.slots.map((s) => {
        const filled = s.filled.map((id) => `“${names.get(id) ?? groups.get(id) ?? id}”`).join(', ') || 'empty';
        const bounds = s.max === 1 ? (s.min ? 'one' : 'optional, one') : s.min ? (s.max ? `${s.min}–${s.max}` : `at least ${s.min}`) : 'optional';
        return `${s.displayName} (${bounds}; takes ${describeMatcher(s.accepts, lookup)}): ${filled}`;
      });
      const lines = [`- “${r.name}” is typed by the composite ${r.descriptor.displayName} (${r.type} v${r.version})${r.descriptor.closed ? ', closed: only its slots' : ''}. Keep its contract: an edit that breaks it blocks publishing.`, `  Slots: ${slots.join('; ')}`];
      if (r.rules.length) lines.push(`  Rules: ${r.rules.map((rule) => rule.label).join('; ')}`);
      if (r.free.length) lines.push(`  Not in a slot: ${r.free.map((id) => `“${names.get(id) ?? id}”`).join(', ')}`);
      if (r.issues.length) lines.push(`  Now: ${r.issues.map((i) => `${i.severity}: ${i.message}`).join('; ')}`);
      return lines.join('\n');
    })
    .join('\n');
}
