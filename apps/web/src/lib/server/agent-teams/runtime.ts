/**
 * Running a team (docs/agent-teams.md): the lead runs as a Landflow agent (agents/runtime.ts), and each member who has
 * reports gets one delegate tool per direct report, `ask_<title>(message, reason)`. A member that is a Landflow agent runs
 * its own loop with *its* reports as tools (a team can have several levels); a remote member is called over A2A, with one
 * conversation for the whole run. Around the call the runtime adds what the team promises: the goal and the manager's task
 * on every request, a reviewer asked before a manager reports done, a token budget per member, and a question from a
 * remote member going to its manager (or to a person). The journal names members by title and records the team's
 * chart on the node's span, so the Run Trace can draw it from the record.
 */
import { toToolName, REASON_DESCRIPTION, type AgentMemory, type AgentTool, type LanguageModel } from '@landflow/engine';
import type { AgentSession, AgentStreamEvent, RunEndReason, SessionExecution, TokenUsage } from '../../shared/agents';
import { reportsOf, rootOf, type AgentMember, type AgentTeamConfig, type RemoteMember, type TeamMember } from '../../shared/agent-teams';
import { agentStore } from '../agents/store';
import { newSession, runAgent, type TeamRole } from '../agents/runtime';
import { a2aAgentTool, type BuiltTool, type ToolContext, type ToolOutcome } from '../agents/tools';
import { liveJournal } from '../journal/writer';
import { issuesOf } from './store';

/** How long a manager's own task is when it goes on to its reports. */
const TASK_CHARS = 600;
/** How often a manager is sent back to ask a reviewer before it may report done. */
const MAX_REVIEW_NUDGES = 2;

export interface TeamRunRequest {
  team: { id: string; name: string };
  config: AgentTeamConfig & { version?: number };
  /** The task, for the lead. */
  message: string;
  flow?: { model?: LanguageModel; tools?: AgentTool[] };
  memory?: AgentMemory;
  memoryKey?: string;
  userId: string;
  execution?: SessionExecution;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface MemberReport {
  title: string;
  /** How many times it was asked (the lead: 1). */
  asked: number;
  tokens: number;
  overBudget?: true;
}

export interface TeamRunResult {
  reply?: string;
  /** Why the run needs a person: a question for one, a review nobody did, a budget or a limit reached. */
  needsPerson?: string;
  members: MemberReport[];
  session: AgentSession;
  reason: RunEndReason;
  usage: TokenUsage;
}

const total = (usage: { inputTokens: number; outputTokens: number }) => usage.inputTokens + usage.outputTokens;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export const toolNameOf = (title: string) => toToolName(`ask_${title}`).toLowerCase();

export async function runTeam(request: TeamRunRequest): Promise<TeamRunResult> {
  const { config } = request;
  const issues = issuesOf(config);
  if (issues.length) throw new Error(`The team can't run: ${issues[0]}`);
  const root = rootOf(config) as AgentMember | undefined;
  if (!root || root.kind !== 'agent') throw new Error('The lead must be a Landflow agent');
  const leadAgent = agentStore.get(root.agentId);
  if (!leadAgent) throw new Error(`${root.title}'s agent no longer exists`);

  const journal = request.execution ? liveJournal(request.execution.executionId) : undefined;
  const nodeSpan = () => (request.execution ? journal?.spanOfNode(request.execution.nodeId) : undefined);
  const check = (name: string, status: 'pass' | 'warn' | 'fail', message: string, subject: string) =>
    journal?.record({
      type: 'check',
      spanId: nodeSpan() ?? 'run',
      check: { name, status, message, subject, source: 'builtin' },
    });

  // The run's bookkeeping, by member id.
  const sessions = new Map<string, AgentSession>();
  const tokens = new Map<string, number>();
  const asked = new Map<string, number>();
  const tasks = new Map<string, string>([[root.id, request.message]]);
  const warned = new Set<string>();
  const overBudget = new Set<string>();
  /** When a member last delivered work, and when a reviewer was last asked: a counter of finished asks. */
  const delivered = new Map<string, number>();
  const reviewed = new Map<string, number>();
  let clock = 0;
  const needsPerson: string[] = [];
  const raise = (reason: string) => {
    if (!needsPerson.includes(reason)) needsPerson.push(reason);
  };

  if (journal) {
    // The chart as recorded: the Run Trace draws the team from this, not from who happened to call whom.
    journal.record({
      type: 'span.updated',
      spanId: nodeSpan() ?? 'run',
      attrs: {
        team: {
          id: request.team.id,
          name: request.team.name,
          ...(request.config.version !== undefined && {
            version: request.config.version,
          }),
          ...(config.goal && { goal: config.goal }),
          members: config.members.map((m) => ({
            id: m.id,
            title: m.title,
            kind: m.kind,
            ...(m.role && { role: m.role }),
            ...(m.reportsTo && { reportsTo: m.reportsTo }),
            ...(m.reviews?.length && { reviews: m.reviews }),
            ...(m.budgetTokens && { budgetTokens: m.budgetTokens }),
          })),
        },
      },
    });
  }

  const spend = (member: TeamMember, used: number, set = false) => {
    const now = set ? used : (tokens.get(member.id) ?? 0) + used;
    tokens.set(member.id, now);
    const budget = member.budgetTokens;
    if (!budget) return;
    if (now >= budget && !overBudget.has(member.id)) {
      overBudget.add(member.id);
      check('Budget', 'fail', `${member.title} used ${now.toLocaleString()} of its ${budget.toLocaleString()} tokens and was stopped`, member.title);
    } else if (now >= budget * 0.8 && !warned.has(member.id)) {
      warned.add(member.id);
      check('Budget', 'warn', `${member.title} used ${now.toLocaleString()} of its ${budget.toLocaleString()} tokens (80%)`, member.title);
    }
  };

  /** The goal and the manager's own task, in front of every request. */
  const withAncestry = (manager: TeamMember, message: string) =>
    [config.goal ? `Team goal: ${config.goal}` : '', tasks.get(manager.id) ? `${manager.title}'s current task: ${cut(tasks.get(manager.id)!, TASK_CHARS)}` : '', '', message]
      .filter((line, i) => line || i > 0)
      .join('\n')
      .trim();

  /** What a manager may not report done without: reviewers of its reports' work who haven't been asked since it was delivered. */
  const unreviewed = (manager: TeamMember) =>
    reportsOf(config, manager.id).flatMap((report) =>
      delivered.has(report.id)
        ? reportsOf(config, manager.id)
            .filter((v) => v.reviews?.includes(report.id) && (reviewed.get(v.id) ?? 0) < delivered.get(report.id)!)
            .map((reviewer) => ({ report, reviewer }))
        : [],
    );

  function roleFor(member: TeamMember): TeamRole {
    let nudges = 0;
    return {
      tools: [],
      title: member.title,
      ...(member.budgetTokens && { budgetTokens: member.budgetTokens }),
      beforeAnswer() {
        const pending = unreviewed(member);
        if (!pending.length) return undefined;
        if (nudges >= MAX_REVIEW_NUDGES) {
          for (const { report, reviewer } of pending) {
            check('Review', 'fail', `${reviewer.title} never reviewed ${report.title}'s work`, reviewer.title);
            raise(`${reviewer.title} has not reviewed ${report.title}'s work`);
          }
          return undefined;
        }
        nudges++;
        return pending
          .map(
            ({ report, reviewer }) =>
              `You may not report done yet: ${report.title}'s work has not been reviewed by ${reviewer.title}. Ask ${reviewer.title} (${toolNameOf(reviewer.title)}) to review it first, then give your answer.`,
          )
          .join('\n');
      },
    };
  }

  /** The tools for a member's direct reports. */
  async function toolsFor(manager: TeamMember): Promise<BuiltTool[]> {
    return Promise.all(reportsOf(config, manager.id).map((report) => (report.kind === 'agent' ? agentTool(manager, report) : remoteTool(manager, report))));
  }

  const describe = (report: TeamMember) => {
    const reviewing = config.members.filter((m) => report.reviews?.includes(m.id)).map((m) => m.title);
    return (
      [report.role?.trim().replace(/\.$/, ''), `${report.title} reports to you`, reviewing.length ? `reviews ${reviewing.join(' and ')}'s work` : ''].filter(Boolean).join('. ') +
      '.'
    );
  };

  const inputSchema = (report: TeamMember) => ({
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: `What to ask ${report.title}. It does not see your conversation: say what it needs to know${report.kind === 'a2a' ? '. It keeps the conversation across your calls in this run' : ''}`,
      },
      reason: { type: 'string', description: REASON_DESCRIPTION },
    },
    required: ['message', 'reason'],
  });

  /** What every delegate tool does around the call: the budget, the count, delivered work, the review ledger. */
  async function guarded(manager: TeamMember, report: TeamMember, input: Record<string, unknown>, work: (message: string) => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const text = String(input.message ?? '').trim();
    if (!text) throw new Error('"message" is empty');
    if (overBudget.has(report.id)) {
      return {
        output: `${report.title} is over its budget of ${report.budgetTokens?.toLocaleString()} tokens for this run and can't take more work. Work with what it delivered, or say what is missing.`,
      };
    }
    asked.set(report.id, (asked.get(report.id) ?? 0) + 1);
    const outcome = await work(text);
    clock++;
    delivered.set(report.id, clock);
    // A reviewer asked after the work was delivered has looked at it.
    reviewed.set(report.id, clock);
    for (const id of report.reviews ?? []) {
      const target = config.members.find((m) => m.id === id);
      if (target && delivered.has(id)) check('Review', 'pass', `${report.title} was asked to review ${target.title}'s work`, report.title);
    }
    return outcome;
  }

  async function agentTool(manager: TeamMember, report: AgentMember): Promise<BuiltTool> {
    return {
      kind: 'agent',
      name: toolNameOf(report.title),
      label: report.title,
      description: describe(report),
      inputSchema: inputSchema(report),
      requireApproval: false,
      invoke: (input, ctx) =>
        guarded(manager, report, input, async (text) => {
          const agent = agentStore.get(report.agentId);
          if (!agent) throw new Error(`${report.title}'s agent was deleted`);
          tasks.set(report.id, text);
          // One session per member for the run: a second ask continues the first.
          let session = sessions.get(report.id);
          if (!session) {
            session = newSession(agent, {
              source: 'agent',
              userId: `team:${request.team.id}`,
              version: agent.published?.version ?? 'draft',
              title: cut(text, 80),
              parentSessionId: ctx.session.id,
              parentAgentId: ctx.agent.id,
            });
            if (request.execution) session.execution = request.execution;
            sessions.set(report.id, session);
          }
          const role: TeamRole = {
            ...roleFor(report),
            tools: await toolsFor(report),
            ...(ctx.callSpan && { under: ctx.callSpan }),
          };
          const result = await runAgent({
            agent,
            session,
            message: withAncestry(manager, text),
            depth: ctx.depth + 1,
            maxDepth: ctx.maxDepth,
            approvals: 'deny',
            signal: ctx.signal,
            team: role,
          });
          spend(report, total(result.session.usage), true);
          if (result.reason === 'error') {
            const last = [...result.session.timeline].reverse().find((e) => e.type === 'error');
            throw new Error(last?.type === 'error' ? last.message : `${report.title} failed`);
          }
          if (result.reason === 'budget') {
            overBudget.add(report.id);
            return {
              output: `${report.title} used up its token budget before it could answer.${result.reply ? ` Its last words: ${result.reply}` : ''}`,
              childAgentId: agent.id,
              childSessionId: result.session.id,
            };
          }
          return {
            output: result.reply ?? `(${report.title} gave no answer)`,
            childAgentId: agent.id,
            childSessionId: result.session.id,
          };
        }),
    };
  }

  async function remoteTool(manager: TeamMember, report: RemoteMember): Promise<BuiltTool> {
    const built = await a2aAgentTool(
      {
        id: report.id,
        type: 'a2a',
        name: report.title,
        parameters: report.parameters,
        ...(report.credentials && { credentials: report.credentials }),
        useWhen: describe(report),
      },
      {
        questions: report.questionsTo === 'person' ? 'person' : 'caller',
        onPerson: (question) => raise(`${report.title} has a question for a person: ${cut(question, 400)}`),
      },
    );
    const base: Pick<BuiltTool, 'kind' | 'name' | 'label' | 'nodeType' | 'description' | 'inputSchema' | 'requireApproval'> =
      'error' in built
        ? {
            kind: 'a2a',
            name: toolNameOf(report.title),
            label: report.title,
            description: describe(report),
            inputSchema: inputSchema(report),
            requireApproval: false,
          }
        : {
            ...built,
            name: toolNameOf(report.title),
            label: report.title,
            description: describe(report),
            inputSchema: inputSchema(report),
          };
    const renamed = (ctx: ToolContext): ToolContext => ({
      ...ctx,
      progress: ctx.progress && ((remote) => ctx.progress!({ ...remote, agent: report.title })),
    });
    return {
      ...base,
      requireApproval: false,
      invoke: (input, ctx) =>
        guarded(manager, report, input, async (text) => {
          if ('error' in built) throw new Error(built.error);
          const known = ctx.session.remoteContexts?.[report.id];
          // An answer to the remote agent's question goes as it is; a new request carries the goal and the manager's task.
          const message = known?.question ? text : withAncestry(manager, text);
          const outcome = await built.invoke({ ...input, message }, renamed(ctx));
          if (outcome.remote?.usage) spend(report, total(outcome.remote.usage));
          return {
            ...outcome,
            ...(outcome.remote && {
              remote: { ...outcome.remote, agent: report.title },
            }),
          };
        }),
    };
  }

  // The lead: the node's session, its journal under the node's span.
  const userId = request.userId;
  let session = newSession(leadAgent, {
    source: 'workflow',
    userId,
    version: leadAgent.published?.version ?? 'draft',
  });
  if (request.memory) session.messages = await request.memory.load(request.memoryKey || 'default');
  if (request.execution) session.execution = request.execution;
  const role: TeamRole = { ...roleFor(root), tools: await toolsFor(root) };
  const result = await runAgent({
    agent: leadAgent,
    session,
    message: config.goal ? `Team goal: ${config.goal}\n\n${request.message}` : request.message,
    approvals: 'deny',
    signal: request.signal,
    ...(request.flow && { flow: request.flow }),
    ...(request.onEvent && { onEvent: request.onEvent }),
    team: role,
  });
  session = result.session;
  if (request.memory && result.reason !== 'error') await request.memory.save(request.memoryKey || 'default', session.messages);
  spend(root, total(session.usage), true);
  if (result.reason === 'budget') raise(`${root.title} used up its budget or limit (${root.budgetTokens ? `${root.budgetTokens.toLocaleString()} tokens` : 'tokens'})`);
  else if (result.reason === 'max_iterations') raise(`${root.title} did not reach an answer within its iteration limit`);

  return {
    ...(result.reply !== undefined && { reply: result.reply }),
    ...(needsPerson.length && { needsPerson: needsPerson.join('; ') }),
    members: config.members.map((m) => ({
      title: m.title,
      asked: m.id === root.id ? 1 : (asked.get(m.id) ?? 0),
      tokens: tokens.get(m.id) ?? 0,
      ...(overBudget.has(m.id) && { overBudget: true as const }),
    })),
    session,
    reason: result.reason,
    usage: session.usage,
  };
}
