/**
 * The three memory tools of a Landflow agent on kagent (docs/a2a.md#memory-on-kagent, C09 FR-7): `recall_memory`, `remember` and
 * `forget_memory` on the agent's MCP endpoint, offered when the deployed version has cross-session memory on. Each takes the
 * `memoryKey` Landflow put in the conversation's first message (./memory-key.ts); without a valid key for this agent, nothing is
 * read or written. The stubs only name the tools for kagent's binding; `memoryToolCall` runs them.
 */
import type { BuiltTool } from '../agents/tools';
import { forgetAgentMemory, recallFor, rememberMemory } from '../agents/memory';
import { MemoryNotFoundError } from '../memory';
import { openMemoryKey } from './memory-key';

export const MEMORY_TOOL_NAMES = ['recall_memory', 'remember', 'forget_memory'] as const;
export const isMemoryTool = (name: string): boolean => (MEMORY_TOOL_NAMES as readonly string[]).includes(name);

/** What the tool says without a usable key. */
export const NEEDS_KEY = 'Memory needs the key Landflow gave you in this conversation: pass it as memoryKey. Without it nothing can be recalled or saved.';

const KEY = { type: 'string', description: 'The memory key from the first message of this conversation' };

const stub = (name: string, description: string, properties: Record<string, unknown>, required: string[], destructive = false): BuiltTool => ({
  kind: 'memory',
  name,
  label: name === 'recall_memory' ? 'Recall' : name === 'forget_memory' ? 'Forget' : 'Remember',
  description,
  inputSchema: { type: 'object', properties: { ...properties, memoryKey: KEY }, required: [...required, 'memoryKey'] },
  requireApproval: false,
  ...(destructive && { destructive: true }),
  async invoke() {
    throw new Error('memory tools run on the agent’s MCP endpoint');
  },
});

export const memoryStubs = (): BuiltTool[] => [
  stub('recall_memory', 'What you remember about the person you are working for: their profile, and what is relevant to the query. Call it first, with the task.', { query: { type: 'string', description: 'The task or question' } }, ['query']),
  stub(
    'remember',
    'Save a durable fact about this person. Set static for things that stay true (a name, a role). To correct a memory pass replaces with its id (m_…) instead of adding a second.',
    { fact: { type: 'string', description: 'One short sentence' }, static: { type: 'boolean' }, replaces: { type: 'string', description: 'The id (m_…) of the memory this corrects' } },
    ['fact'],
  ),
  stub('forget_memory', 'Forget one of this person’s memories (its id m_… is in what recall_memory returned), with the reason. Destructive; a person can restore it.', { id: { type: 'string' }, reason: { type: 'string' } }, ['id', 'reason'], true),
];

/** Run one memory tool for the person the key names; the answer is text (an error says why, never what exists). */
export async function memoryToolCall(agentId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const opened = openMemoryKey(args.memoryKey, agentId);
  if (!opened) return { text: NEEDS_KEY, isError: true };
  const { userId } = opened;
  try {
    if (name === 'recall_memory') return { text: (await recallFor(agentId, userId, String(args.query ?? ''))).text };
    if (name === 'remember') {
      const replaces = typeof args.replaces === 'string' && args.replaces.trim() ? args.replaces.trim() : undefined;
      const { outcome, count } = await rememberMemory(agentId, userId, { fact: String(args.fact ?? ''), static: args.static === true, ...(replaces && { replaces }) });
      return { text: `${outcome === 'replaced' ? 'Replaced.' : outcome === 'refreshed' ? 'Already remembered; refreshed.' : 'Saved.'} You now remember ${count} fact(s) about this person.` };
    }
    const id = String(args.id ?? '').trim();
    const reason = String(args.reason ?? '').trim();
    if (!id || !reason) return { text: '"id" and "reason" are both needed', isError: true };
    await forgetAgentMemory(agentId, userId, id, reason, userId);
    return { text: `Forgot ${id}.` };
  } catch (error) {
    if (error instanceof MemoryNotFoundError) return { text: `Memory ${String(args.id ?? '')} not found`, isError: true };
    return { text: (error as Error).message, isError: true };
  }
}
