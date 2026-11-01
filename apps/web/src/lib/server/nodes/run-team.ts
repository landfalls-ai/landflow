/**
 * Run a Team (docs/agent-teams.md): a published agent team as one step of a flow. The lead runs with the message; its
 * reports are its tools (and theirs), asked by title with a reason; reviews and budgets are enforced around the calls. A
 * chat model, memory and tools connected to the node go to the lead, so a flow keeps its own model and a tool such as a
 * GitHub check on the team node. The result leaves by Done, or by Needs a person when the team can't finish alone.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { AgentMemory, AgentTool, LanguageModel } from '@landflow/engine';
import { chartOrder } from '../../shared/agent-teams';
import type { AgentStreamEvent } from '../../shared/agents';
import { joinActivity, teamProgressFolder, type TeamActivity } from '../../shared/team-progress';
import type { TeamState } from '../agent-teams/runtime';
import { streamer } from './agents';

const main = [{ type: 'main' as const }];

/** What the node keeps while a member's question waits for a person: where it was in its items, and the team's state. */
interface Waiting {
  itemIndex: number;
  done: NodeItem[];
  needsPerson: NodeItem[];
  state: TeamState;
  activity: TeamActivity;
}

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
    // Run an Agent's ports and names (short, so the labels fit under the node), all optional: what is connected goes to the lead.
    inputs: [
      { type: 'main' },
      { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
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
          'The lead runs with the team’s goal; each member is asked by title, with a reason, and reports back. A model, memory and tools connected here go to the lead. Tools that need approval are refused (nobody is there to approve them). A member’s question for a person pauses the run until someone answers it (Needs you, or the form link), then the team goes on. Done carries { reply, team, members, usage, activity }; Needs a person adds a reason: a review nobody did or that asked for changes, a budget or limit reached.',
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
    // Back from a wait for a person (a member's question): the items already done, and the team's state to go on from.
    const saved = ctx.getNodeState?.() as { waiting?: Waiting; $resume?: { kind: string; data?: JsonObject } } | undefined;
    ctx.setNodeState?.(undefined);
    const waited = saved?.waiting && saved.$resume ? saved.waiting : undefined;
    const done: NodeItem[] = waited ? [...waited.done] : [];
    const needsPerson: NodeItem[] = waited ? [...waited.needsPerson] : [];
    for (let i = waited?.itemIndex ?? 0; i < Math.max(items.length, 1); i++) {
      const resume = waited && i === waited.itemIndex ? { state: waited.state, answer: String(saved?.$resume?.data?.answer ?? '').trim() } : undefined;
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
        // Who works on what, for the canvases (lib/shared/team-progress.ts): the lead's stream, folded. What the run did
        // (turns, moments) goes on the output too, so a finished node shows it.
        const fold = teamProgressFolder(chartOrder(config).map((m) => m.title));
        const stream = send && streamer(send, i);
        const onEvent = (event: AgentStreamEvent) => {
          stream?.(event);
          const report = fold(event);
          if (report) ctx.sendProgress?.(report as unknown as JsonObject);
        };
        // A member that manages others asks them in its own loop: folded too, so its reports show at work.
        const onMemberEvent = (title: string, event: AgentStreamEvent) => {
          const report = fold(event, title);
          if (report) ctx.sendProgress?.(report as unknown as JsonObject);
        };
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
          onEvent,
          onMemberEvent,
          canWait: Boolean(ctx.putExecutionToWait),
          ...(resume && { resume }),
        });
        send?.({ type: 'end', itemIndex: i });
        const activity = joinActivity(resume ? waited?.activity : undefined, fold.activity());
        if (result.waiting && ctx.putExecutionToWait) {
          // A member asked a person: the run waits for the answer, then this node runs again and the team goes on.
          const { member, question, state } = result.waiting;
          ctx.setNodeState?.({ waiting: { itemIndex: i, done, needsPerson, state, activity } as unknown as JsonObject });
          ctx.putExecutionToWait({
            resume: 'form',
            rerun: true,
            data: {
              form: {
                title: `${member} asks`,
                description: question,
                fields: [{ fieldLabel: 'Answer', fieldName: 'answer', fieldType: 'textarea', requiredField: true }],
                buttonLabel: 'Send the answer',
              },
              teamQuestion: { team: config.name, member, question },
            } as unknown as JsonObject,
          });
          ctx.logger.info(`${member} asked a person; waiting for the answer`);
          return [done, needsPerson];
        }
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
            ...(m.estimated && { estimated: true }),
            ...(m.overBudget && { overBudget: true }),
          })),
          ...(result.needsPerson && { reason: result.needsPerson }),
          usage: { ...result.usage },
          activity: activity as unknown as JsonObject,
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
