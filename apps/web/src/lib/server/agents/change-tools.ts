/**
 * Re-check 3/4: what a designed CHANGE to an agent may do with tools, after the architect answered and before the card shows it.
 *  - A tool whose node type the agent kept is not added again ("SQLite 2"): the kept tool is filled in (a credential slot or a
 *    parameter it lacked), unless the ask wants another, or the new tool brings a credential that differs from the kept one's
 *    (then it is its own tool: "add a SQLite tool for the archive DB"). A tool the design dropped never comes back: the design
 *    is the person's change ("switch the SQLite tool to the Sales DB credential" drops one and adds one).
 *  - A fix (a cause is given) adds only what the cause needs: a new tool the change and the cause never name is dropped, but only
 *    when another new tool IS named (a fix never ends as an empty "No change" card), and the card says what was dropped.
 * Pure: the route calls it with the base config and the designed one.
 */
type Slot = Record<string, { id?: string } | undefined>;
type Tool = Record<string, unknown> & { id?: string; type?: string; nodeType?: string; name?: string; collection?: string; parameters?: Record<string, unknown>; credentials?: Slot };

const WANTS_ANOTHER = /\b(?:another|a second|second|extra|additional|one more|separate)\b/i;
const GENERIC = new Set(['tool', 'tools', 'node', 'core', 'api', 'request', 'data', 'the', 'and', 'for', 'with']);

const stem = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const wordsOf = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w))
    .map(stem);

/** Whether the ask names the tool: a word of its name, its node type (the last segment, the plugin prefix) or display title, its credential's name or a knowledge tool's collection. */
function named(tool: Tool, text: string, titleOf?: (nodeType: string) => string | undefined): boolean {
  const said = new Set(wordsOf(text));
  const own = [
    tool.name,
    tool.nodeType?.split('.').at(-1),
    tool.nodeType?.split('.')[0],
    tool.nodeType && titleOf?.(tool.nodeType),
    tool.collection,
    ...Object.values(tool.credentials ?? {}).map((c) => (c as { name?: string } | undefined)?.name),
  ].filter((x): x is string => typeof x === 'string');
  return own.some((n) => wordsOf(n).some((w) => said.has(w)));
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Two tools bring different credentials: some slot is filled on both with different ids. */
const credentialsConflict = (a: Tool, b: Tool) => Object.entries(b.credentials ?? {}).some(([slot, ref]) => ref?.id && a.credentials?.[slot]?.id && a.credentials[slot]!.id !== ref.id);

export function tidyChangedTools<C extends { tools?: unknown }>(base: C, designed: C, ask: { text: string; fix?: boolean; titleOf?: (nodeType: string) => string | undefined }): { config: C; dropped: string[]; removed: string[] } {
  const baseTools = (Array.isArray(base.tools) ? base.tools : []) as Tool[];
  const designedTools = (Array.isArray(designed.tools) ? designed.tools : []) as Tool[];
  const baseIds = new Set(baseTools.map((t) => t.id));
  const isNode = (t: Tool) => t.type === 'node' && Boolean(t.nodeType);
  // A tool the design kept: its base id, or a base tool's type and name under a new id (a design may give its own tools new ids).
  const listed = new Set(designedTools.map((t) => t.id));
  const keptBase = (t: Tool) => (t.id !== undefined && baseIds.has(t.id)) || (isNode(t) && baseTools.some((b) => !listed.has(b.id) && isNode(b) && b.nodeType === t.nodeType && b.name === t.name));
  const current = new Map<Tool, Tool>(); // a designed tool → what it becomes (a kept tool, filled in)
  const gone = new Set<Tool>();
  const added: Tool[] = [];
  const keptTools = designedTools.filter(keptBase);
  for (const tool of designedTools) {
    if (keptBase(tool)) continue;
    const twin = isNode(tool) && !WANTS_ANOTHER.test(ask.text) ? keptTools.find((t) => isNode(t) && t.nodeType === tool.nodeType && !credentialsConflict(current.get(t) ?? t, tool)) : undefined;
    if (twin) {
      const target = current.get(twin) ?? twin;
      const credentials = { ...(tool.credentials ?? {}), ...(target.credentials ?? {}) };
      const parameters = { ...Object.fromEntries(Object.entries(tool.parameters ?? {}).filter(([k]) => empty(target.parameters?.[k]))), ...Object.fromEntries(Object.entries(target.parameters ?? {}).filter(([, v]) => !empty(v))) };
      const filled: Tool = { ...target, parameters };
      if (empty(credentials)) delete filled.credentials;
      else filled.credentials = credentials;
      current.set(twin, filled);
      gone.add(tool);
      continue;
    }
    added.push(tool);
  }
  const dropped: string[] = [];
  // A fix adds only what its cause needs, when the cause names at least one of the new tools.
  if (ask.fix && added.some((t) => named(t, ask.text, ask.titleOf))) {
    for (const t of added) {
      if (named(t, ask.text, ask.titleOf)) continue;
      gone.add(t);
      dropped.push(String(t.name ?? t.nodeType ?? 'a tool'));
    }
  }
  const removed = [...gone].map((t) => String(t.name ?? t.nodeType ?? '')).filter(Boolean);
  return { config: { ...designed, tools: designedTools.filter((t) => !gone.has(t)).map((t) => current.get(t) ?? t) }, dropped, removed };
}
