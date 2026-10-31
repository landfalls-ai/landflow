'use client';
/**
 * "Turn into a team" on the canvas (docs/agent-teams.md): save the team a Run an Agent node and its agent tools make,
 * publish it, and swap the lead and those sub-nodes for one Run a Team node, as one undo step. The graph rewrite is pure
 * (lib/shared/turn-into-team.ts); this adds the saving, the undo and the words.
 */
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { AgentTeam, AgentTeamConfig } from '@/lib/shared/agent-teams';
import { replaceWithTeam, teamFromLead, turnIntoTeamBlocker } from '@/lib/shared/turn-into-team';
import { useEditor } from './store';

/** Whether the node on the canvas can become a team (the toolbar shows the action only then). */
export const canTurnNodeIntoTeam = (nodeId: string) => turnIntoTeamBlocker(useEditor.getState().toWorkflow(), nodeId) === undefined;

/** Save a team and publish it; left as a draft when it can't be published yet (the Agents page lists what stops it). */
async function saveTeam(config: AgentTeamConfig): Promise<{ id: string; published: boolean }> {
  const { team } = await api<{ team: AgentTeam }>('/api/agent-teams', { method: 'POST', json: config });
  try {
    await api(`/api/agent-teams/${team.id}/publish`, { method: 'POST' });
    return { id: team.id, published: true };
  } catch {
    return { id: team.id, published: false };
  }
}

export async function turnIntoTeam(nodeId: string): Promise<boolean> {
  const made = teamFromLead(useEditor.getState().toWorkflow(), nodeId);
  if ('error' in made) {
    toast.error('Can’t turn this into a team', { description: made.error });
    return false;
  }
  try {
    const { id, published } = await saveTeam(made.team);
    // The canvas may have changed while the team was saving: rewrite what is there now, if the lead and members still are.
    const current = useEditor.getState().toWorkflow();
    if (turnIntoTeamBlocker(current, nodeId)) {
      toast.error('The canvas changed while the team was saved', { description: `The team “${made.team.name}” is on the Agents page; add a Run a Team node for it.` });
      return false;
    }
    const memberIds = made.members.map((m) => m.nodeId).filter((memberId) => current.nodes.some((n) => n.id === memberId));
    const undo = useEditor.getState().replaceGraph(replaceWithTeam(current, nodeId, memberIds, { id, name: made.team.name }), { id: nodeId, added: false });
    toast.success(`Turned into a team of ${made.team.members.length}`, {
      description: published ? `“${made.team.name}” is on the Agents page, published.` : `“${made.team.name}” is saved as a draft: open it on the Agents page to publish.`,
      action: { label: 'Undo', onClick: undo },
      duration: 15_000,
    });
    return true;
  } catch (error) {
    toast.error('Couldn’t save the team', { description: (error as Error).message });
    return false;
  }
}

/**
 * Spotlight's `turnIntoTeam` op swapped the graph already (a Run a Team node with no team yet): save the team the lead
 * and its agents made, from the graph as it was, and point the node at it.
 */
export async function saveTeamFor(nodeId: string, config: AgentTeamConfig) {
  try {
    const { id, published } = await saveTeam(config);
    const node = useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf;
    if (node) useEditor.getState().updateNode(nodeId, { parameters: { ...node.parameters, teamId: id, teamName: config.name } });
    if (!published) toast.message(`“${config.name}” is saved as a draft`, { description: 'Open it on the Agents page to publish it before the flow runs.' });
  } catch (error) {
    toast.error('Couldn’t save the team', { description: `${(error as Error).message} The Run a Team node has no team yet: undo, or pick one.` });
  }
}

/** A Run a Team node shows its team's name: fill it in when the team is chosen (the settings panel). */
export async function syncTeamName(nodeId: string) {
  const node = useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf;
  const teamId = node?.type === 'core.runTeam' ? String(node.parameters.teamId ?? '') : '';
  if (!node || !teamId) return;
  try {
    const { team } = await api<{ team: AgentTeam }>(`/api/agent-teams/${teamId}`);
    const latest = useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf;
    const name = team.draft.name;
    if (latest && latest.parameters.teamId === teamId && latest.parameters.teamName !== name) useEditor.getState().updateNode(nodeId, { parameters: { ...latest.parameters, teamName: name } });
  } catch {
    // The name is only a label.
  }
}
