/**
 * AG16: a saved agent placed on the canvas as a Run an Agent node bound to it (Your agents in the node creator: a click, or a drag
 * dropped where the person lets go). The node is named for the agent, and its bubbles are drawn from the agent (canvas/agent-bubbles.tsx).
 * `toolApprovals: 'askInChat'` as the starter flow sets it (agent-card.ts): a tool that needs approval waits for the person's Approve in the editor's chat.
 */
import { useEditor } from './store';

/** The agent's name as a node name, made unique among this flow's nodes ("Alert triager 2"). */
export function nodeNameFor(agentName: string): string {
  const taken = new Set(useEditor.getState().nodes.map((n) => n.data.wf.name));
  if (!taken.has(agentName)) return agentName;
  let i = 2;
  while (taken.has(`${agentName} ${i}`)) i++;
  return `${agentName} ${i}`;
}

/** The parameters of a Run an Agent node bound to this agent. */
export const boundParameters = (agentId: string): Record<string, unknown> => ({ agentId, toolApprovals: 'askInChat' });

/** Place a bound Run an Agent node at a flow position (a drop). Returns its id. */
export function placeAgentNode(agent: { id: string; name: string }, position: { x: number; y: number }): string | undefined {
  const state = useEditor.getState();
  const id = state.placeNode('core.messageAgent', { position }, position, boundParameters(agent.id));
  if (id) useEditor.getState().updateNode(id, { name: nodeNameFor(agent.name) });
  return id;
}
