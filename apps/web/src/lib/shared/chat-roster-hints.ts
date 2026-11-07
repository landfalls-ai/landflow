/**
 * Per-agent memory for a roster pick (docs/specs/17-notes/FinishChat.md): a picked agent's item carries
 * `sessionId = <visitor session>:<agentKey>`, so its own memory works where the target reads `$json.sessionId` (the
 * default of Run an Agent and AI Agent). A Session Key typed as a fixed string, or read from the trigger node by name
 * (`$('When chat message received').item.json.sessionId`, which holds the visitor's plain id), keeps one memory for
 * every agent. Pure, so the editor panel and validation share it. Parameters are never rewritten.
 */

export interface HintNode {
  id: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}

/**
 * A string parameter whose `loadOptionsMethod` starts with this lists the workflow's own nodes of the types after it
 * (separated by `|`) in the editor, with free text still accepted. The plugin is not asked; the editor holds the nodes.
 */
export const WORKFLOW_NODES_METHOD = 'workflowNodes:';

/** The node types a roster entry can start (Run an Agent, Run a Team, AI Agent). */
export const ROSTER_TARGET_TYPES = ['core.messageAgent', 'core.runTeam', 'core.aiAgent'];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether an expression names the trigger node (`$('Name')` or `$node["Name"]`). */
const readsNode = (value: string, node: HintNode) => new RegExp(`\\$\\(\\s*['"\`]${escape(node.name)}['"\`]\\s*\\)|\\$node\\[\\s*['"\`]${escape(node.name)}['"\`]\\s*\\]`).test(value);

/** The session key a node uses, when it has one this concerns. */
function sessionKeyOf(node: HintNode): string | undefined {
  const p = node.parameters ?? {};
  if (node.type === 'core.messageAgent') return p.conversation === 'key' && typeof p.sessionKey === 'string' ? p.sessionKey : undefined;
  if (node.type === 'core.aiAgent') {
    const options = p.options as Record<string, unknown> | undefined;
    return options && typeof options.sessionId === 'string' ? options.sessionId : undefined;
  }
  return undefined;
}

/** What stops a picked agent from having its own memory, or undefined when nothing does. */
export function sessionKeyProblem(target: HintNode, trigger: HintNode): string | undefined {
  const key = sessionKeyOf(target)?.trim();
  if (!key) return undefined;
  if (!key.includes('{{')) return `"${target.name}" keeps its memory under the fixed Session Key "${key}", so every visitor and every picked agent shares it. Set its Session Key to {{ $json.sessionId }} to give each visitor their own memory.`;
  if (readsNode(key, trigger) && !/\$json\.sessionId/.test(key)) return `"${target.name}" reads its Session Key from the trigger "${trigger.name}" by name, which holds the visitor's plain session id, so a picked agent does not get its own memory. Use {{ $json.sessionId }} instead.`;
  return undefined;
}
