/**
 * Re-check 3/4/5/6: what a designed CHANGE to an agent may do with tools, after the architect answered and before the card shows it.
 * One plain rule: a new tool is merged into a same-type tool the design kept ONLY when all three hold: (a) the kept tool has no
 * credential in any slot (a SQLite tool still waiting for its credential: "SQLite 2" after an earlier fix); (b) the new tool brings
 * no non-empty parameter that differs from the kept tool's; (c) the new tool brings no credential, or exactly one (it fills the
 * kept tool's empty slot). A kept tool takes one merge. Every other new tool stands as its own tool with its own Pick it row
 * ("add a SQLite tool for the archive DB" beside a complete one; "also let it call the weather API"). A tool the design dropped
 * never comes back, and the kept tool is filled only where it is empty. No node-type knowledge is used: what an agent fix may add
 * is the prompt's to say (the card lists every tool it adds and the person applies it).
 * Pure: the route calls it with the base config and the designed one.
 */
type Slot = Record<string, { id?: string } | undefined>;
type Tool = Record<string, unknown> & { id?: string; type?: string; nodeType?: string; name?: string; parameters?: Record<string, unknown>; credentials?: Slot };

const empty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function tidyChangedTools<C extends { tools?: unknown }>(base: C, designed: C): { config: C; removed: string[] } {
  const baseTools = (Array.isArray(base.tools) ? base.tools : []) as Tool[];
  const designedTools = (Array.isArray(designed.tools) ? designed.tools : []) as Tool[];
  const baseIds = new Set(baseTools.map((t) => t.id));
  const listed = new Set(designedTools.map((t) => t.id));
  const isNode = (t: Tool) => t.type === 'node' && Boolean(t.nodeType);
  // A tool the design kept: its base id, or a base tool's type and name under a new id (a design may give its own tools new ids).
  const keptBase = (t: Tool) => (t.id !== undefined && baseIds.has(t.id)) || (isNode(t) && baseTools.some((b) => !listed.has(b.id) && isNode(b) && b.nodeType === t.nodeType && b.name === t.name));
  const noCredential = (t: Tool) => Object.values(t.credentials ?? {}).every((c) => !c?.id);
  const differs = (twin: Tool, added: Tool) => Object.entries(added.parameters ?? {}).some(([k, v]) => !empty(v) && !empty(twin.parameters?.[k]) && !same(v, twin.parameters![k]));
  const current = new Map<Tool, Tool>();
  const gone = new Set<Tool>();
  const kept = designedTools.filter(keptBase);
  const merged = new Set<Tool>(); // a kept tool takes one merge
  for (const tool of designedTools) {
    if (keptBase(tool) || !isNode(tool)) continue;
    const brings = Object.values(tool.credentials ?? {}).filter((c) => c?.id).length;
    // A new tool of the same type with another operation takes the place of a kept one that still has no credential (an earlier fix's
    // "insert" SQLite made a read-only query tool): the person's change is the new operation, with its own asks-first state.
    const turned = brings > 1 ? undefined : kept.find((t) => isNode(t) && t.nodeType === tool.nodeType && !merged.has(t) && noCredential(current.get(t) ?? t) && !empty(tool.parameters?.operation) && !empty((current.get(t) ?? t).parameters?.operation) && !same(tool.parameters!.operation, (current.get(t) ?? t).parameters!.operation));
    if (turned) {
      const target = current.get(turned) ?? turned;
      const { requireApproval: _old, ...rest } = target;
      const filled: Tool = { ...rest, parameters: { ...(target.parameters ?? {}), ...Object.fromEntries(Object.entries(tool.parameters ?? {}).filter(([, v]) => !empty(v))) }, ...(tool.requireApproval !== undefined && { requireApproval: tool.requireApproval }) };
      const credentials = { ...(target.credentials ?? {}), ...(tool.credentials ?? {}) };
      if (!empty(credentials)) filled.credentials = credentials;
      current.set(turned, filled);
      merged.add(turned);
      gone.add(tool);
      continue;
    }
    const twin = brings > 1 ? undefined : kept.find((t) => isNode(t) && t.nodeType === tool.nodeType && !merged.has(t) && noCredential(current.get(t) ?? t) && !differs(current.get(t) ?? t, tool));
    if (!twin) continue;
    const target = current.get(twin) ?? twin;
    const credentials = { ...(tool.credentials ?? {}), ...(target.credentials ?? {}) };
    // Only what the kept tool lacks is filled in from the new one.
    const parameters = { ...Object.fromEntries(Object.entries(tool.parameters ?? {}).filter(([k]) => empty(target.parameters?.[k]))), ...Object.fromEntries(Object.entries(target.parameters ?? {}).filter(([, v]) => !empty(v))) };
    const filled: Tool = { ...target, parameters };
    if (empty(credentials)) delete filled.credentials;
    else filled.credentials = credentials;
    current.set(twin, filled);
    merged.add(twin);
    gone.add(tool);
  }
  const removed = [...gone].map((t) => String(t.name ?? t.nodeType ?? '')).filter(Boolean);
  return { config: { ...designed, tools: designedTools.filter((t) => !gone.has(t)).map((t) => current.get(t) ?? t) }, removed };
}
