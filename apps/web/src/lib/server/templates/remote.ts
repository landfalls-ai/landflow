/**
 * Remote templates from an n8n-compatible templates API, when LANDFLOW_TEMPLATES_URL points at one (off by default).
 * The URL is the API base, as n8n's N8N_TEMPLATES_HOST: `https://api.n8n.io/api` serves `/templates/search` and
 * `/templates/workflows/<id>`. Workflows come back in n8n's format and go through the n8n importer, whose report the
 * template page shows. Answers are cached for ten minutes; requests time out after ten seconds and are capped in size.
 */
import type { NodeDescriptor } from '@landflow/protocol';
import { isTemplateCategory, type TemplateCategory, type TemplateDetail, type TemplateSummary } from '../../shared/templates';
import type { Workflow } from '../../shared/types';
import { importWorkflowJson, mappingFor } from '../n8n-import';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MS = 10 * 60_000;
export const REMOTE_PREFIX = 'n8n-';

/** The configured templates API base, without a trailing slash (undefined: remote templates are off). */
export function remoteBase(): string | undefined {
  const raw = process.env.LANDFLOW_TEMPLATES_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** The host the templates come from, for the "From …" label. */
export function remoteLabel(): string | undefined {
  const base = remoteBase();
  return base ? new URL(base).host : undefined;
}

const cache = new Map<string, { at: number; value: unknown }>();

async function getJson(path: string): Promise<unknown> {
  const base = remoteBase();
  if (!base) throw new Error('Remote templates are off (set LANDFLOW_TEMPLATES_URL)');
  const url = `${base}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The templates API answered ${response.status} for ${path}`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('The templates API sent too much data');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('The templates API sent too much data');
  const value = JSON.parse(text) as unknown;
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** Forget cached answers (tests, or after changing the URL). */
export function clearRemoteCache() {
  cache.clear();
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isObject) : []);
const text = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** n8n's template categories → Landflow's. */
const CATEGORY_NAMES: Record<string, TemplateCategory> = {
  ai: 'ai',
  'ai summarization': 'ai',
  'ai chatbot': 'ai',
  'ai rag': 'ai',
  sales: 'sales',
  'lead generation': 'sales',
  crm: 'sales',
  'it ops': 'it-ops',
  devops: 'it-ops',
  secops: 'it-ops',
  marketing: 'marketing',
  'social media': 'marketing',
  'document ops': 'data',
  'data & storage': 'data',
  'file management': 'data',
  'data analysis': 'data',
  support: 'support',
  'support chatbot': 'support',
  'ticket management': 'support',
  engineering: 'engineering',
  development: 'engineering',
  'personal productivity': 'productivity',
  productivity: 'productivity',
  'project management': 'productivity',
};

function categoriesOf(value: unknown): TemplateCategory[] {
  const found = list(value).map((c) => CATEGORY_NAMES[text(c.name).trim().toLowerCase()]).filter(isTemplateCategory);
  return [...new Set(found)];
}

/** Landflow node types for n8n node type names (for the card's icons); unknown ones are left out. */
function nodeTypesOf(names: string[]): string[] {
  const types = names.flatMap((name) => {
    const to = mappingFor(name)?.mapping.to;
    return to ? [Array.isArray(to) ? to[0] : to] : [];
  });
  return [...new Set(types)];
}

const remoteId = (value: unknown) => `${REMOTE_PREFIX}${text(value)}`;
const userOf = (value: unknown) => (isObject(value) ? text(value.name) || text(value.username) : '') || undefined;

/** Search the remote templates (the first 30 matches). */
export async function searchRemote(search = ''): Promise<TemplateSummary[]> {
  const query = new URLSearchParams({ page: '1', rows: '30', ...(search.trim() && { search: search.trim() }) });
  const data = await getJson(`/templates/search?${query}`);
  return list(isObject(data) ? data.workflows : undefined).flatMap((w): TemplateSummary[] => {
    if (!/^\d+$/.test(text(w.id))) return [];
    const nodes = list(w.nodes).map((n) => text(n.name));
    return [
      {
        id: remoteId(w.id),
        source: 'remote',
        name: text(w.name) || `Template ${text(w.id)}`,
        description: text(w.description),
        categories: categoriesOf(w.categories),
        nodeTypes: nodeTypesOf(nodes),
        nodeCount: nodes.length,
        credentials: [],
        ...(userOf(w.user) && { author: userOf(w.user) }),
        ...(text(w.createdAt) && { createdAt: text(w.createdAt) }),
        usable: true,
        problems: [],
      },
    ];
  });
}

/**
 * A remote template, converted: the n8n workflow through the importer (credential references are dropped there and
 * come back as slots in ./index.ts). Undefined when the id isn't a remote one.
 */
export async function getRemote(id: string, resolveType: (type: string) => NodeDescriptor | undefined): Promise<Omit<TemplateDetail, 'usable' | 'problems' | 'credentials'> | undefined> {
  if (!id.startsWith(REMOTE_PREFIX)) return undefined;
  const number = id.slice(REMOTE_PREFIX.length);
  if (!/^\d{1,12}$/.test(number)) return undefined;
  const data = await getJson(`/templates/workflows/${number}`);
  // api.n8n.io wraps it in { workflow: { …, workflow: { nodes, connections } } }; an n8n instance's proxy answers { id, name, workflow }.
  const outer = isObject(data) && isObject(data.workflow) ? data.workflow : data;
  if (!isObject(outer)) throw new Error('The templates API sent no workflow');
  const inner = isObject(outer.workflow) ? outer.workflow : outer;
  const name = text(outer.name) || `Template ${number}`;
  const result = importWorkflowJson({ ...inner, name }, { resolveType });
  const workflow: Workflow = { ...result.workflow, id: '', name, description: text(outer.description).slice(0, 2000) || undefined };
  return {
    id,
    source: 'remote',
    name,
    description: text(outer.description),
    categories: categoriesOf(outer.categories),
    nodeTypes: [...new Set(workflow.nodes.map((n) => n.type))],
    nodeCount: workflow.nodes.length,
    ...(userOf(outer.user) && { author: userOf(outer.user) }),
    ...(text(outer.createdAt) && { createdAt: text(outer.createdAt) }),
    workflow,
    setup: [
      `Imported from ${remoteLabel() ?? 'the templates API'}: check the import report for nodes that were converted or left as placeholders.`,
      'Pick or add a credential for every node that needs one (n8n credentials don’t come along).',
    ],
    dataTables: [],
    report: result.report,
  };
}
