/**
 * C27: what the browser and the server share about content-keyed trust (docs/agents.md#changed-mcp-tools-are-held): the shape of a
 * tool as it is fingerprinted, the held-change view the agent page and Needs you render, and `toolChanges()`, the pure
 * comparison of a snapshot's tool with the live one that both the filter and the review sheet use.
 */

/** What of an MCP tool is fingerprinted: the text the model reads, the schema of its input and its annotations (read-only, destructive). */
export interface ToolContent {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** The fields a held change lists, in the order the review sheet shows them. */
export const TOOL_FIELDS = ['description', 'inputSchema', 'annotations', 'title'] as const;
export type ToolField = (typeof TOOL_FIELDS)[number];

export interface ToolChange {
  name: string;
  /** `changed`: the tool is in the snapshot with other content; `added`: the server lists a tool the snapshot does not hold. */
  change: 'changed' | 'added';
  before?: ToolContent;
  after: ToolContent;
  /** Which fields differ (every field of an added tool that has a value). */
  fields: ToolField[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

/** The fields of `after` that differ from `before` (a missing `before` lists every field `after` has). */
export function changedFields(before: ToolContent | undefined, after: ToolContent): ToolField[] {
  return TOOL_FIELDS.filter((field) => (before ? !same(before[field], after[field]) : after[field] !== undefined));
}

/**
 * What changed between a snapshot's tools and the live ones: a tool whose content differs, and (with `addedToo`) a tool the
 * snapshot does not hold. A tool the server no longer lists is not a change. The order of either list never matters.
 */
export function toolChanges(before: ToolContent[], after: ToolContent[], addedToo = true): ToolChange[] {
  const known = new Map(before.map((tool) => [tool.name, tool]));
  const out: ToolChange[] = [];
  for (const tool of after) {
    const old = known.get(tool.name);
    if (!old) {
      if (addedToo) out.push({ name: tool.name, change: 'added', after: tool, fields: changedFields(undefined, tool) });
      continue;
    }
    const fields = changedFields(old, tool);
    if (fields.length) out.push({ name: tool.name, change: 'changed', before: old, after: tool, fields });
  }
  return out;
}

/** One pending hold as the agent page shows it (`GET /api/agents/:id/trust`). */
export interface HeldToolsView {
  subjectId: string;
  /** The MCP server's label in the agent's tool list. */
  toolConfigName: string;
  hash: string;
  firstSeenAt: string;
  changes: Array<{ name: string; change: 'changed' | 'added'; before?: ToolContent; after: ToolContent; fields: ToolField[] }>;
}

export interface AgentTrustView {
  holdChangedTools: boolean;
  held: HeldToolsView[];
}

/** The fields of a `trust` item in Needs you (lib/server/trust/needs-you.ts). */
export interface TrustNeedsYouFields {
  agentId: string;
  heldCount: number;
}
