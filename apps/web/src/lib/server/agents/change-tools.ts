/**
 * Re-check 3: what a designed CHANGE to an agent may do with tools, after the architect answered and before the card shows it.
 *  - A tool whose node type the agent already has is not added again ("SQLite 2"): the existing tool is kept and filled in (a
 *    credential slot or a parameter it lacked), unless the ask says it wants another one.
 *  - A fix (a cause is given) adds only what the cause needs: a new tool the change and the cause never name is dropped
 *    (the HTTP Request tool that came with the SQLite one).
 * Pure: the route calls it with the base config and the designed one.
 */
type Tool = Record<string, unknown> & { id?: string; type?: string; nodeType?: string; name?: string; parameters?: Record<string, unknown>; credentials?: Record<string, unknown> };

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const WANTS_ANOTHER = /\b(?:another|a second|second|two|extra|additional|one more|both|separate)\b/i;

/** Whether the text names the tool: its name, its node type's own name, or the operation words, ignoring case, spaces and underscores. */
function named(tool: Tool, text: string): boolean {
  const haystack = compact(text);
  const own = [tool.name, tool.nodeType?.split('.').at(-1)].filter((x): x is string => typeof x === 'string' && compact(x).length >= 3);
  return own.some((n) => haystack.includes(compact(n)));
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

export function tidyChangedTools<C extends { tools?: unknown }>(base: C, designed: C, ask: { text: string; fix?: boolean }): C {
  const baseTools = (Array.isArray(base.tools) ? base.tools : []) as Tool[];
  const designedTools = (Array.isArray(designed.tools) ? designed.tools : []) as Tool[];
  const baseIds = new Set(baseTools.map((t) => t.id));
  const merged = new Map<string, Tool>();
  const out: Tool[] = [];
  for (const tool of designedTools) {
    if (tool.id && baseIds.has(tool.id)) {
      out.push(tool);
      continue;
    }
    // A new tool.
    const sameType = (t: Tool) => t.type === 'node' && t.nodeType === tool.nodeType;
    // The one it has: by name first (a design may give its own tools new ids), else any of that node type.
    const twin = tool.type === 'node' && tool.nodeType ? (baseTools.find((t) => sameType(t) && t.name === tool.name) ?? out.find((t) => sameType(t) && baseIds.has(t.id)) ?? baseTools.find(sameType)) : undefined;
    if (twin && !WANTS_ANOTHER.test(ask.text)) {
      // Reuse the one it has: fill what it lacked from the one that was about to be added.
      const target = merged.get(twin.id ?? '') ?? out.find((t) => t.id === twin.id) ?? twin;
      const filled: Tool = {
        ...target,
        credentials: { ...(tool.credentials ?? {}), ...(target.credentials ?? {}) },
        parameters: { ...Object.fromEntries(Object.entries(tool.parameters ?? {}).filter(([k]) => empty(target.parameters?.[k]))), ...Object.fromEntries(Object.entries(target.parameters ?? {}).filter(([, v]) => !empty(v))) },
      };
      if (empty(filled.credentials)) delete filled.credentials;
      const at = out.findIndex((t) => t.id === twin.id);
      if (at >= 0) out[at] = filled;
      else out.push(filled);
      merged.set(twin.id ?? '', filled);
      continue;
    }
    if (ask.fix && !named(tool, ask.text)) continue;
    out.push(tool);
  }
  // Base tools the design dropped stay dropped (the change asked for it); only additions are tidied.
  return { ...designed, tools: out };
}
