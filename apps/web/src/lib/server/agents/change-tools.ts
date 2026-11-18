/**
 * Re-check 3/4/5: what a designed CHANGE to an agent may do with tools, after the architect answered and before the card shows it.
 * One rule: a new tool is merged into a same-type tool the design kept ONLY when that tool is incomplete (a required credential
 * slot or a required parameter is empty: "SQLite 2" for a SQLite tool that still lacks its credential) and no non-empty value
 * the new tool brings differs from the kept tool's. Every other new tool is its own tool, with its own Pick it row ("add a SQLite
 * tool for the archive DB" next to a complete one; "also let it call the weather API" with another URL). A tool the design dropped
 * never comes back, and a complete tool never receives anything from a new one. What a fix may add is the prompt's to say
 * (the card lists every tool it adds and the person applies it): nothing here guesses what a cause "names".
 * Pure: the route calls it with the base config, the designed one and what the node types require.
 */
type Slot = Record<string, { id?: string } | undefined>;
type Tool = Record<string, unknown> & { id?: string; type?: string; nodeType?: string; name?: string; parameters?: Record<string, unknown>; credentials?: Slot };

export interface Required {
  credentials: string[];
  parameters: string[];
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function tidyChangedTools<C extends { tools?: unknown }>(base: C, designed: C, required: (nodeType: string) => Required | undefined): { config: C; removed: string[] } {
  const baseTools = (Array.isArray(base.tools) ? base.tools : []) as Tool[];
  const designedTools = (Array.isArray(designed.tools) ? designed.tools : []) as Tool[];
  const baseIds = new Set(baseTools.map((t) => t.id));
  const listed = new Set(designedTools.map((t) => t.id));
  const isNode = (t: Tool) => t.type === 'node' && Boolean(t.nodeType);
  // A tool the design kept: its base id, or a base tool's type and name under a new id (a design may give its own tools new ids).
  const keptBase = (t: Tool) => (t.id !== undefined && baseIds.has(t.id)) || (isNode(t) && baseTools.some((b) => !listed.has(b.id) && isNode(b) && b.nodeType === t.nodeType && b.name === t.name));
  const incomplete = (t: Tool) => {
    const need = required(t.nodeType!);
    return Boolean(need && (need.credentials.some((slot) => !t.credentials?.[slot]?.id) || need.parameters.some((key) => empty(t.parameters?.[key]))));
  };
  const differs = (twin: Tool, added: Tool) => Object.entries(added.parameters ?? {}).some(([k, v]) => !empty(v) && !empty(twin.parameters?.[k]) && !same(v, twin.parameters![k]));
  const current = new Map<Tool, Tool>();
  const gone = new Set<Tool>();
  const kept = designedTools.filter(keptBase);
  for (const tool of designedTools) {
    if (keptBase(tool) || !isNode(tool)) continue;
    const twin = kept.find((t) => isNode(t) && t.nodeType === tool.nodeType && incomplete(current.get(t) ?? t) && !differs(current.get(t) ?? t, tool));
    if (!twin) continue;
    const target = current.get(twin) ?? twin;
    const credentials = { ...(tool.credentials ?? {}), ...(target.credentials ?? {}) };
    // Only what the kept tool lacks is filled in from the new one.
    const parameters = { ...Object.fromEntries(Object.entries(tool.parameters ?? {}).filter(([k]) => empty(target.parameters?.[k]))), ...Object.fromEntries(Object.entries(target.parameters ?? {}).filter(([, v]) => !empty(v))) };
    const filled: Tool = { ...target, parameters };
    if (empty(credentials)) delete filled.credentials;
    else filled.credentials = credentials;
    current.set(twin, filled);
    gone.add(tool);
  }
  const removed = [...gone].map((t) => String(t.name ?? t.nodeType ?? '')).filter(Boolean);
  return { config: { ...designed, tools: designedTools.filter((t) => !gone.has(t)).map((t) => current.get(t) ?? t) }, removed };
}
