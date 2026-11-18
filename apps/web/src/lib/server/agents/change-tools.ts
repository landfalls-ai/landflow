/**
 * What a designed CHANGE to an agent may do with tools, after the architect answered and before the card shows it. Dedupe only:
 * a new tool is dropped as a duplicate when it has the same node type as a kept tool, brings NO credential, and has no non-empty
 * parameter that differs from that kept tool's. Nothing is ever moved onto a kept tool (no parameter, no credential, no
 * operation); every other new tool stands as its own tool with its own Pick it row. A change to a kept tool is made in place by the
 * architect's revise (same tool id), never as a tool added beside it. A credential slot with no id is a placeholder, not a credential.
 * Pure: the route calls it with the base config and the designed one.
 */
type Slot = Record<string, { id?: string } | undefined>;
type Tool = Record<string, unknown> & { id?: string; type?: string; nodeType?: string; name?: string; parameters?: Record<string, unknown>; credentials?: Slot };

const empty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function tidyChangedTools<C extends { tools?: unknown }>(base: C, designed: C): { config: C; removed: string[] } {
  const baseTools = (Array.isArray(base.tools) ? base.tools : []) as Tool[];
  const designedTools = (Array.isArray(designed.tools) ? designed.tools : []) as Tool[];
  const baseIds = new Set(baseTools.map((t) => t.id));
  const listed = new Set(designedTools.map((t) => t.id));
  const isNode = (t: Tool) => t.type === 'node' && Boolean(t.nodeType);
  // A tool the design kept: its base id, or a base tool's type and name under a new id (a design may give its own tools new ids).
  const keptBase = (t: Tool) => (t.id !== undefined && baseIds.has(t.id)) || (isNode(t) && baseTools.some((b) => !listed.has(b.id) && isNode(b) && b.nodeType === t.nodeType && b.name === t.name));
  const kept = designedTools.filter(keptBase);
  const brings = (t: Tool) => Object.values(t.credentials ?? {}).some((c) => Boolean(c?.id));
  const differs = (twin: Tool, added: Tool) => Object.entries(added.parameters ?? {}).some(([k, v]) => !empty(v) && !empty(twin.parameters?.[k]) && !same(v, twin.parameters![k]));
  const gone = new Set<Tool>();
  for (const tool of designedTools) {
    if (keptBase(tool) || !isNode(tool) || brings(tool)) continue;
    if (kept.some((t) => isNode(t) && t.nodeType === tool.nodeType && !differs(t, tool))) gone.add(tool);
  }
  const removed = [...gone].map((t) => String(t.name ?? t.nodeType ?? '')).filter(Boolean);
  return { config: { ...designed, tools: designedTools.filter((t) => !gone.has(t)) }, removed };
}
