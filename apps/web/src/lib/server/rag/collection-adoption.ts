/**
 * C21: the one-time adoption of the collections that existed before owners did. It only reads: it finds every collection a
 * saved configuration names (an agent's knowledge base, a project's knowledge setting, a workflow's Vector Store node with a
 * literal collection name) and says which project the collection goes to: the home project of the OLDEST resource that names
 * it (C21-D2, the person's choice: strict). Every other project that names it is listed as having lost access. The writes,
 * the audit rows and the once-only marker are collection-access.ts's.
 *
 * A name built by an expression (`{{ … }}`), or a pgvector collection whose credential can't be read, can't be resolved: it is
 * listed apart and stays unclaimed (open until a project writes it).
 */
import { pgIdentityOf, storeKeyOf, type PgIdentity, type StoreKind } from '../../shared/collections';
import { isNodeKnowledge, type VectorKnowledgeBaseConfig } from '../../shared/agents';
import type { ProjectSettings } from '../../shared/project-policy';
import { agentStore } from '../agents/store';
import { credentials } from '../credentials/vault';
import { getProjectSettings } from '../governance/scopes';
import { homeProjectId, listProjects } from '../projects/store';
import { publishedVersionId } from '../publications';
import { productionWorkflow } from '../publish';
import { store as workflowStore } from '../store';

/** One resource that names a collection. */
interface Naming {
  key: string;
  store: StoreKind;
  name: string;
  projectId: string;
  /** The naming resource's creation time (ISO), for "oldest wins". */
  at: string;
  /** What names it, for the report: `agent Support`, `project knowledge`, `workflow Ingest`. */
  by: string;
}

export interface AdoptedCollection {
  key: string;
  store: string;
  name: string;
  ownerProjectId: string;
  /** Projects that name it too and have no access from now on. */
  lost: string[];
}

export interface AdoptionPlan {
  owners: AdoptedCollection[];
  /** What was named but could not be resolved to a collection. */
  unresolved: string[];
}

const STORE_NODES: Record<string, StoreKind> = { 'core.vectorStoreInMemory': 'memory', 'core.vectorStoreSqlite': 'sqlite', 'core.vectorStorePGVector': 'pgvector' };
const POSTGRES_CREDENTIAL = 'core.postgres';
const FAR_PAST = '0000';

/** The connection a pgvector collection lives on, from the credential a config names; undefined when it can't be read. */
function pgIdentity(ref: { id: string; name?: string } | undefined, table: string | undefined): PgIdentity | undefined {
  if (!ref?.id) return undefined;
  try {
    return pgIdentityOf(credentials.dataFor({ id: ref.id, name: ref.name ?? ref.id }, POSTGRES_CREDENTIAL), table);
  } catch {
    return undefined;
  }
}

function namingOf(by: string, projectId: string | undefined, at: string | undefined, store: StoreKind, collection: unknown, ref: { id: string; name?: string } | undefined, table: unknown, unresolved: string[]): Naming | undefined {
  const name = typeof collection === 'string' ? collection.trim() : '';
  if (!name || !projectId) return undefined;
  if (name.includes('{{')) {
    unresolved.push(`${by}: “${name}” is built by an expression`);
    return undefined;
  }
  let pg: PgIdentity | undefined;
  if (store === 'pgvector') {
    pg = pgIdentity(ref, typeof table === 'string' ? table : undefined);
    if (!pg) {
      unresolved.push(`${by}: “${name}” (its Postgres credential can’t be read)`);
      return undefined;
    }
  }
  const key = storeKeyOf(store, name, pg);
  // The brain's closed names are never adopted (nobody owns them).
  if (key.startsWith('brain:')) return undefined;
  return { key, store, name, projectId, at: at ?? FAR_PAST, by };
}

function agentNamings(out: Naming[], unresolved: string[]) {
  for (const agent of agentStore.list()) {
    const projectId = homeProjectId('agent', agent.id);
    // The draft and the published version both count: a flow that is only published still reads it.
    const tools = [...(agent.tools ?? []), ...(agent.published?.config.tools ?? [])];
    for (const tool of tools) {
      if (tool.type !== 'knowledge' || isNodeKnowledge(tool)) continue;
      const config = tool as VectorKnowledgeBaseConfig;
      const named = namingOf(`agent ${agent.name}`, projectId, agent.createdAt, config.store, config.collection, config.credential, config.tableName, unresolved);
      if (named) out.push(named);
    }
  }
}

function projectNamings(out: Naming[], unresolved: string[]) {
  for (const project of listProjects()) {
    const tool = (getProjectSettings(project.id) as ProjectSettings).knowledge?.tool;
    if (!tool || 'source' in tool && tool.source !== 'vector') continue;
    const config = tool as VectorKnowledgeBaseConfig;
    const named = namingOf(`project knowledge of ${project.name}`, project.id, project.createdAt, config.store, config.collection, config.credential, config.tableName, unresolved);
    if (named) out.push(named);
  }
}

function workflowNamings(out: Naming[], unresolved: string[]) {
  for (const workflow of workflowStore.listWorkflows()) {
    const projectId = homeProjectId('workflow', workflow.id);
    // The draft and the published version both count: production runs the published nodes, whatever the draft says now.
    const published = publishedVersionId(workflow.id) ? productionWorkflow({ ...workflow, active: true }) : undefined;
    for (const node of [...workflow.nodes, ...(published?.nodes ?? [])]) {
      const kind = STORE_NODES[node.type];
      if (!kind) continue;
      const named = namingOf(`workflow ${workflow.name}`, projectId, workflow.createdAt, kind, node.parameters?.collection, node.credentials?.postgres, node.parameters?.tableName ?? 'landflow_vectors', unresolved);
      if (named) out.push(named);
    }
  }
}

/** Who owns what after the upgrade, worked out from the saved configurations. Reads only. */
export function planAdoption(): AdoptionPlan {
  const namings: Naming[] = [];
  const unresolved: string[] = [];
  agentNamings(namings, unresolved);
  projectNamings(namings, unresolved);
  workflowNamings(namings, unresolved);
  const byKey = new Map<string, Naming[]>();
  for (const naming of namings) byKey.set(naming.key, [...(byKey.get(naming.key) ?? []), naming]);
  const owners: AdoptedCollection[] = [];
  for (const [key, named] of byKey) {
    // The oldest naming resource's project owns it; equal times fall to the project id so every process agrees.
    const [first] = [...named].sort((a, b) => a.at.localeCompare(b.at) || a.projectId.localeCompare(b.projectId));
    if (!first) continue;
    owners.push({ key, store: first.store, name: first.name, ownerProjectId: first.projectId, lost: [...new Set(named.map((n) => n.projectId).filter((p) => p !== first.projectId))].sort() });
  }
  return { owners: owners.sort((a, b) => a.key.localeCompare(b.key)), unresolved: [...new Set(unresolved)].sort() };
}
