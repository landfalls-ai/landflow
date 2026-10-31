/**
 * Run a Team (docs/agent-teams.md): a published agent team as one step of a flow. The lead runs with the message; its
 * reports are its tools (and theirs), asked by title with a reason; reviews and budgets are enforced around the calls. A
 * chat model, memory and tools connected to the node go to the lead, so a flow keeps its own model and a tool such as a
 * GitHub check on the team node. The result leaves by Done, or by Needs a person when the team can't finish alone.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { AgentMemory, AgentTool, LanguageModel } from '@landflow/engine';
import { streamer } from './agents';

const main = [{ type: 'main' as const }];

export const runTeamNode = defineNode({
  description: {
    name: 'runTeam',
    displayName: 'Run a Team',
    description: 'Run a team of agents as one step: a lead who delegates to members by title, with reviews, budgets and questions between them',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:users-round',
    color: '#a855f7',
    subtitle: '{{teamName}}',
    keywords: ['team', 'agents', 'org chart', 'lead', 'delegate', 'review', 'multi-agent', 'crew', 'run a team'],
    // Like Run an Agent's ports, all optional: what is connected goes to the lead.
    inputs: [
      { type: 'main' },
      {
        type: 'ai_languageModel',
        displayName: 'Lead’s Chat Model',
        maxConnections: 1,
      },
      { type: 'ai_memory', displayName: 'Lead’s Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Lead’s Tool' },
    ],
    outputs: [
      { type: 'main', displayName: 'Done' },
      { type: 'main', displayName: 'Needs a person' },
    ],
    properties: [
      {
        name: 'teamId',
        displayName: 'Team',
        type: 'options',
        default: '',
        required: true,
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'teams' },
        description: 'Teams are built on the Agents page (Teams) and published',
      },
      // Shown on the node (the subtitle); the editor and Spotlight fill it in when a team is chosen.
      {
        name: 'teamName',
        displayName: 'Team Name',
        type: 'hidden',
        default: '',
      },
      {
        name: 'message',
        displayName: 'Message',
        type: 'string',
        default: '{{ $json.chatInput ?? $json.text }}',
        required: true,
        typeOptions: { rows: 3 },
        description: 'The task for the team’s lead',
      },
      {
        name: 'version',
        displayName: 'Version',
        type: 'options',
        default: 'published',
        noDataExpression: true,
        options: [
          {
            name: 'Published',
            value: 'published',
            description: 'The version published on the Agents page',
          },
          {
            name: 'Draft',
            value: 'draft',
            description: 'What is being edited now (for trying a change)',
          },
        ],
      },
      {
        name: 'notice',
        displayName:
          'The lead runs with the team’s goal; each member is asked by title, with a reason, and reports back. A model, memory and tools connected here go to the lead. Tools that need approval are refused (nobody is there to approve them). Done carries { reply, team, members }; Needs a person adds a reason: a question for a person, a review nobody did, a budget or limit reached.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    // Loaded lazily: the agents runtime imports the runner, which needs the registry this plugin is part of.
    const { agentTeamStore } = await import('../agent-teams/store');
    const { runTeam } = await import('../agent-teams/runtime');
    const connection = ctx.getInputConnectionData;
    const [model] = connection ? await connection<LanguageModel>('ai_languageModel') : [];
    const [memory] = connection ? await connection<AgentMemory>('ai_memory') : [];
    const tools = connection ? await connection<AgentTool>('ai_tool') : [];
    const send = ctx.sendChunk;
    const items = ctx.getInputData();
    const done: NodeItem[] = [];
    const needsPerson: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      try {
        const team = agentTeamStore.get(ctx.getNodeParameter<string>('teamId', i));
        if (!team) throw new NodeOperationError('Choose a team — the selected one was deleted', { itemIndex: i });
        const draft = ctx.getNodeParameter<string>('version', i, 'published') === 'draft';
        const config = draft ? team.draft : team.published;
        if (!config)
          throw new NodeOperationError(`Publish “${team.draft.name}” first`, {
            description: 'Flows run the published version of a team.',
            itemIndex: i,
          });
        const message = String(ctx.getNodeParameter('message', i) ?? '').trim();
        if (!message)
          throw new NodeOperationError('The message is empty', {
            itemIndex: i,
          });
        const node = ctx.getNode();
        const execution = {
          workflowId: ctx.getWorkflowId() ?? 'unknown',
          executionId: ctx.getExecutionId(),
          nodeId: node.id,
          ...(node.name && { nodeName: node.name }),
        };
        send?.({ type: 'begin', itemIndex: i });
        const result = await runTeam({
          team: { id: team.id, name: config.name },
          config,
          message,
          userId: `workflow:${ctx.getWorkflowId() ?? 'unknown'}`,
          execution,
          signal: ctx.signal,
          ...((model || tools.length) && {
            flow: { ...(model && { model }), ...(tools.length && { tools }) },
          }),
          ...(memory && { memory }),
          ...(send && { onEvent: streamer(send, i) }),
        });
        send?.({ type: 'end', itemIndex: i });
        if (result.reason === 'error') {
          const last = [...result.session.timeline].reverse().find((e) => e.type === 'error');
          throw new NodeOperationError(`${config.name} failed: ${last?.type === 'error' ? last.message : 'unknown error'}`, { itemIndex: i });
        }
        const json: JsonObject = {
          reply: result.reply ?? null,
          team: {
            id: team.id,
            name: config.name,
            version: draft ? null : (team.published?.version ?? null),
          },
          members: result.members.map((m) => ({
            title: m.title,
            asked: m.asked,
            tokens: m.tokens,
            ...(m.overBudget && { overBudget: true }),
          })),
          ...(result.needsPerson && { reason: result.needsPerson }),
        };
        (result.needsPerson ? needsPerson : done).push({
          json,
          pairedItem: { item: i },
        });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        done.push({
          json: { error: (error as Error).message },
          pairedItem: { item: i },
        });
      }
    }
    return [done, needsPerson];
  },
  methods: {
    loadOptions: {
      async teams() {
        const { agentTeamStore } = await import('../agent-teams/store');
        return agentTeamStore.list().map((team) => ({
          name: team.draft.name || 'Untitled team',
          value: team.id,
          description: team.published ? `Published v${team.published.version} · ${team.published.members.length} members` : 'Not published yet',
        }));
      },
    },
  },
});
