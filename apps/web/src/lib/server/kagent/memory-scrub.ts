/**
 * Keeps a memory key and the memories a `recall_memory` call returned out of what Landflow stores or shows (C09, docs/a2a.md#memory-on-kagent).
 * A remote agent's steps, said text and data parts go into node output, the run journal and the session, which other members of a project
 * can read; the key opens one person's memories for 24 hours, so it must never be in them. A leaf module (no imports from the memory code), so
 * the A2A client can use it.
 */

/** What a memory key looks like. Always use it with `replace` (it is global, so `test` would keep state). */
export const MEMORY_KEY_PATTERN = /mk_[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/g;

export const MEMORY_KEY_REDACTED = '[memory key]';

/** The text with every memory key taken out. */
export const scrubKeys = (text: string): string => text.replace(MEMORY_KEY_PATTERN, MEMORY_KEY_REDACTED);

/** Any value with every memory key taken out of its strings, deeply. */
export function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubKeys(value) as T;
  if (Array.isArray(value)) return value.map(scrubValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)])) as T;
  return value;
}

const TOOL = /^(?:mcp__.+?__)?(recall_memory|remember|forget_memory)$/;

/** Which memory tool a remote tool name is (Claude Code names MCP tools `mcp__<server>__<tool>`), if any. */
export const memoryToolOf = (name: unknown): 'recall_memory' | 'remember' | 'forget_memory' | undefined => (typeof name === 'string' ? (TOOL.exec(name)?.[1] as 'recall_memory' | 'remember' | 'forget_memory' | undefined) : undefined);

/** Whether a remote tool is the memory recall (its output is memory text). */
export const isRecallTool = (name: unknown): boolean => memoryToolOf(name) === 'recall_memory';

/** What a recall step shows in place of what it returned: how many memories came back, never their words. */
export function recalledSummary(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const count = (text.match(/(^|\\n|\n)- \[m_/g) ?? []).length;
  return `recalled ${count} ${count === 1 ? 'memory' : 'memories'}`;
}

/** A memory tool's arguments as stored: a recall keeps its query (the person's own question), remember and forget keep nothing of the memory's words. */
export function memoryArgs(name: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const tool = memoryToolOf(name);
  if (tool === 'remember') return { summary: 'remembered a memory' };
  if (tool === 'forget_memory') return { summary: 'forgot a memory' };
  return scrubValue(args);
}

/** A memory tool's output as stored: how many a recall brought back, "remembered a memory", "forgot a memory"; any other tool's with a key taken out. */
export function memoryOutput(name: unknown, output: unknown): unknown {
  const tool = memoryToolOf(name);
  if (tool === 'recall_memory') return recalledSummary(output);
  if (tool === 'remember') return 'remembered a memory';
  if (tool === 'forget_memory') return 'forgot a memory';
  return scrubValue(output);
}
