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
import { verdictOf } from '../../shared/team-progress';
import { agentStore } from '../agents/store';
import { newSession, runAgent, type TeamRole } from '../agents/runtime';
import { a2aAgentTool, type BuiltTool, type ToolContext, type ToolOutcome } from '../agents/tools';
import { liveJournal } from '../journal/writer';
import { issuesOf } from './store';

/** How long a manager's own task is when it goes on to its reports. */
const TASK_CHARS = 600;
/** How often a manager is sent back to ask a reviewer before it may report done. */
const MAX_REVIEW_NUDGES = 2;
/** What a manager is told to keep its answer to: it sees its reports' answers, not their work. */
const REPORT_RULE = 'When you answer, name only the files, tests, commands and results your reports gave you, as they wrote them; don\'t add details nobody reported.';

/** File names in a text (`get-alerts.ts`, `PLAN.md`), for telling which ones an answer made up. */
export function fileNamesIn(text: string): string[] {
  // A path's last part counts on its own: `src/index.ts` names `index.ts`. "Node.js" and its kind are products, not files.
  const names = text.match(/(?<![\w.-])[\w-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|rb|md|json|ya?ml|toml|sql|sh|css|html)\b/g) ?? [];
  return [...new Set(names.filter((name) => !/^(?:node|next|nuxt|vue|react|express|three|chart|d3)\.js$/i.test(name)))];
}

const TEST_WORD = /tests?|specs?|pass|fail/i;
/** Test counts as answers write them: "14/14 tests", "3 tests passed", "12 passed", "Tests passed: 14/14". */
const TEST_COUNTS = [
  /\b(\d+)\s*(?:\/|of)\s*(\d+)\s+(?:tests?|specs?)\b/gi,
  /\b(\d+)\s+(?:tests?|specs?)\s+(?:passed|passing|pass|failed|failing|fail)\b/gi,
  /\b(\d+)\s+(?:passed|passing|failed|failing)\b/gi,
  /\b(?:tests?|specs?)(?:\s+(?:passed|failed))?\s*[:=]\s*(\d+)(?:\s*\/\s*(\d+))?/gi,
];

/**
 * What an answer names that the source never gave: file names, commits, test counts and pull requests. A short commit counts
 * when the source has it in full, and a test count when each of its numbers sits next to a test word in the source.
 */
export function ungrounded(answer: string, source: string): string[] {
  const lower = source.toLowerCase();
  const found: string[] = fileNamesIn(answer).filter((name) => !source.includes(name));
  const commits = (text: string) => (text.match(/(?<![\w#/.-])[0-9a-f]{7,40}(?![\w-])/gi) ?? []).filter((sha) => /\d/.test(sha) && /[a-f]/i.test(sha)).map((sha) => sha.toLowerCase());
  const known = commits(source);
  for (const sha of new Set(commits(answer))) if (!known.some((k) => k.startsWith(sha) || sha.startsWith(k))) found.push(`commit ${sha}`);
  const near = new Set<string>();
  for (const m of source.matchAll(/\b\d+\b/g)) if (TEST_WORD.test(source.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))) near.add(m[0]);
  // One count per stretch of text: "14/14 tests passed" is one claim, not two.
  const counts = TEST_COUNTS.flatMap((pattern) => [...answer.matchAll(pattern)]).sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  let end = -1;
  for (const m of counts) {
    if (m.index < end) continue;
    end = m.index + m[0].length;
    if (m.slice(1).some((n) => n && !near.has(n))) found.push(m[0].trim());
  }
  for (const m of answer.matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b|\/pull\/(\d+)/gi)) {
    const number = m[1] ?? m[2];
    if (!new RegExp(`(?:#|pull/|PR\\s*#?|pull request\\s*#?)${number}\\b`, 'i').test(lower)) found.push(`PR #${number}`);
  }
  return [...new Set(found)];
}

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
  /** The stream of a member that is a Landflow agent (its own loop: whom it asks, its own tools), by title. */
  onMemberEvent?: (title: string, event: AgentStreamEvent) => void;
  /** Whether the run can wait for a person (a flow's): a member's question for a person pauses it instead of ending it. */
  canWait?: boolean;
  /** Going on after a wait: the state saved then (TeamRunResult.waiting) and the person's answer to the question. */
  resume?: { state: TeamState; answer: string };
}

/** What a team run keeps between asks, as JSON: saved when it waits for a person, restored when it goes on. By member id. */
export interface TeamState {
  /** The lead's session, saved with the question it waits on. */
  lead?: AgentSession;
  /** Agent members' sessions: a second ask continues the first. */
  sessions: Record<string, AgentSession>;
  tokens: Record<string, number>;
  used: Record<string, TokenUsage>;
  /** Remote members that report no usage: estimated, counted against their budget but not in the team's usage. */
  estimated: Record<string, TokenUsage>;
  asked: Record<string, number>;
  tasks: Record<string, string>;
  warned: string[];
  overBudget: string[];
  /** When a member last delivered work, and when a reviewer was last asked: a counter of finished asks. */
  delivered: Record<string, number>;
  reviewed: Record<string, number>;
  /** Each reviewer's latest verdict (its `VERDICT:` line), when it gave one. */
  verdicts: Record<string, 'approve' | 'changes'>;
  clock: number;
  needsPerson: string[];
  /** What each manager was told (its task) and heard back (its reports' answers and steps): what its answer may name. */
  told: Record<string, string>;
  heard: Record<string, string[]>;
  /** Per member: review reminders sent, whether it was sent back for made-up details, for which, and what it still named after. */
  roles: Record<string, { nudges: number; grounded: 'no' | 'sent' | 'checked'; sentFor: string[]; unverified?: string[] }>;
}

const emptyState = (): TeamState => ({
  sessions: {},
  tokens: {},
  used: {},
  estimated: {},
  asked: {},
  tasks: {},
  warned: [],
  overBudget: [],
  delivered: {},
  reviewed: {},
  verdicts: {},
  clock: 0,
  needsPerson: [],
  told: {},
  heard: {},
  roles: {},
});

export interface MemberReport {
  title: string;
  /** How many times it was asked (the lead: 1). */
  asked: number;
  tokens: number;
  /** A remote member that reports no usage: its tokens are estimated from what went to it and came back. */
  estimated?: true;
  overBudget?: true;
}

export interface TeamRunResult {
  reply?: string;
  /** Why the run needs a person: a question for one, a review nobody did, a budget or a limit reached. */
  needsPerson?: string;
  members: MemberReport[];
  session: AgentSession;
  reason: RunEndReason;
  /** What the whole team used: the lead, its agent members and the usage remote members reported. */
  usage: TokenUsage;
  /** The run waits for a person: who asked what, and the state to go on from (TeamRunRequest.resume). */
  waiting?: { member: string; question: string; state: TeamState };
}

const total = (usage: { inputTokens: number; outputTokens: number }) => usage.inputTokens + usage.outputTokens;
/** About four characters a token. */
const tokensIn = (text: string) => Math.ceil(text.length / 4);
const asText = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

/**
 * What a remote member that reports no usage spent on one request, at least: the request, its answer and its steps'
 * arguments and results. Its own prompt and the files it read again aren't in it, so a budget stops it late, not early.
 */
export function estimateUsage(message: string, outcome: ToolOutcome): TokenUsage {
  const steps = outcome.remote?.steps ?? [];
  return {
    inputTokens: tokensIn(message) + steps.reduce((sum, step) => sum + tokensIn(asText(step.output)) + tokensIn(step.error ?? ''), 0),
    outputTokens: tokensIn(asText(outcome.output)) + steps.reduce((sum, step) => sum + tokensIn(asText(step.args)), 0),
  };
}
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

  // The run's bookkeeping, by member id: plain JSON, saved when the run waits for a person and restored when it goes on.
  const state: TeamState = request.resume ? structuredClone(request.resume.state) : emptyState();
  if (!request.resume) state.tasks[root.id] = request.message;
  const hear = (manager: TeamMember, ...texts: string[]) => (state.heard[manager.id] = [...(state.heard[manager.id] ?? []), ...texts]);
  const raise = (reason: string) => {
    if (!state.needsPerson.includes(reason)) state.needsPerson.push(reason);
  };

  if (journal && !request.resume) {
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

  /** A member's usage so far (`set`: its session's total) or more of it (a remote answer's, or an estimate of one). */
  const spend = (member: TeamMember, usage: TokenUsage, set = false, guess = false) => {
    const ledger = guess ? state.estimated : state.used;
    const before = ledger[member.id];
    const mine = set || !before ? { ...usage } : { inputTokens: before.inputTokens + usage.inputTokens, outputTokens: before.outputTokens + usage.outputTokens };
    ledger[member.id] = mine;
    if (!guess) delete state.estimated[member.id];
    const now = total(mine);
    state.tokens[member.id] = now;
    const budget = member.budgetTokens;
    if (!budget) return;
    const about = guess ? 'about ' : '';
    const why = guess ? ' (estimated: it reports no usage)' : '';
    if (now >= budget && !state.overBudget.includes(member.id)) {
      state.overBudget.push(member.id);
      check('Budget', 'fail', `${member.title} used ${about}${now.toLocaleString()} of its ${budget.toLocaleString()} tokens and was stopped${why}`, member.title);
    } else if (now >= budget * 0.8 && !state.warned.includes(member.id)) {
      state.warned.push(member.id);
      check('Budget', 'warn', `${member.title} used ${about}${now.toLocaleString()} of its ${budget.toLocaleString()} tokens (80%)${why}`, member.title);
    }
  };

  /** The goal and the manager's own task, in front of every request. */
  const withAncestry = (manager: TeamMember, message: string) =>
    [config.goal ? `Team goal: ${config.goal}` : '', state.tasks[manager.id] ? `${manager.title}'s current task: ${cut(state.tasks[manager.id], TASK_CHARS)}` : '', '', message]
      .filter((line, i) => line || i > 0)
      .join('\n')
      .trim();

  const byId = new Map(config.members.map((m) => [m.id, m]));
  /** A member's managers, nearest first. */
  const chain = (member: TeamMember) => {
    const up: TeamMember[] = [];
    for (let at = member.reportsTo && byId.get(member.reportsTo); at && !up.includes(at); at = at.reportsTo && byId.get(at.reportsTo)) up.push(at);
    return up;
  };
  /**
   * Who sees to a review: the nearest manager of both (their own manager when they share one). None when one manages the
   * other: a manager reads its report's work when it comes back.
   */
  const enforcer = (report: TeamMember, reviewer: TeamMember) => {
    const above = chain(report);
    const reviewers = chain(reviewer);
    if (above.includes(reviewer) || reviewers.includes(report)) return undefined;
    return above.find((m) => reviewers.includes(m));
  };
  /** The manager's direct report on the way to a member below it (the member itself when it reports to the manager). */
  const toward = (manager: TeamMember, member: TeamMember) => [member, ...chain(member)].find((m) => m.reportsTo === manager.id) ?? member;
  /**
   * What a manager may not report done without: reviews it sees to that are missing (the reviewer not asked since the work
   * was delivered) or that asked for changes (a `VERDICT: CHANGES` the work hasn't come back from).
   */
  const unreviewed = (manager: TeamMember) =>
    config.members.flatMap((reviewer) =>
      (reviewer.reviews ?? []).flatMap((id) => {
        const report = byId.get(id);
        if (!report || state.delivered[id] === undefined || enforcer(report, reviewer)?.id !== manager.id) return [];
        const asked = (state.reviewed[reviewer.id] ?? 0) >= state.delivered[id];
        if (asked && state.verdicts[reviewer.id] !== 'changes') return [];
        return [{ report, reviewer, changes: asked }];
      }),
    );
  /** How a manager reaches a member below it: `Reviewer (ask_reviewer)`, or `Reviewer through QA lead (ask_qa_lead)`. */
  const via = (manager: TeamMember, member: TeamMember) => {
    const head = toward(manager, member);
    return head.id === member.id ? `${member.title} (${toolNameOf(member.title)})` : `${member.title} through ${head.title} (${toolNameOf(head.title)})`;
  };

  /** What a manager that asked its reports was given: its task, its reports' answers and steps, and its own tools' results. */
  const given = (manager: TeamMember, session: AgentSession) => {
    const answers = state.heard[manager.id];
    if (!answers?.length) return undefined;
    const results = session.messages.flatMap((m) => (m.role === 'tool' ? m.results.map((r) => r.content) : []));
    return [state.told[manager.id] ?? '', ...answers, ...results].join('\n');
  };
  /** Files, commits, test counts and pull requests in a manager's answer that nothing gave it: made up, so it is sent back once. */
  const madeUp = (manager: TeamMember, reply: string, session: AgentSession) => {
    const source = given(manager, session);
    return source === undefined ? [] : ungrounded(reply, source);
  };
  /** The files a manager was given, for the note that sends it back: so it can name the real ones. */
  const filesGiven = (manager: TeamMember, session: AgentSession, names: string[]) => {
    if (!names.some((name) => fileNamesIn(name).length)) return '';
    const files = fileNamesIn(given(manager, session) ?? '');
    return files.length ? `The files your reports named: ${files.slice(0, 12).join(', ')}${files.length > 12 ? '…' : ''}. ` : 'None of your reports named a file. ';
  };

  /** A member's answer as it goes on: what it still named after it was sent back carries a note, so no one downstream takes it as reported. */
  const marked = (member: TeamMember, reply: string) => {
    const names = state.roles[member.id]?.unverified;
    return names?.length ? `${reply}\n\n(Not in any team member's report: ${names.join(', ')}. Check before relying on them.)` : reply;
  };

  function roleFor(member: TeamMember): TeamRole {
    /** Its review reminders so far, whether it was sent back for made-up details (and its next answer checked), and for which. */
    const mine = (state.roles[member.id] ??= { nudges: 0, grounded: 'no', sentFor: [] });
    return {
      tools: [],
      title: member.title,
      ...(member.budgetTokens && { budgetTokens: member.budgetTokens }),
      beforeAnswer(reply, session) {
        const pending = unreviewed(member);
        if (!pending.length) {
          if (mine.grounded === 'checked') return undefined;
          const names = madeUp(member, reply, session);
          if (mine.grounded === 'sent') {
            mine.grounded = 'checked';
            if (names.length) mine.unverified = names;
            // A span keeps one Grounded check per member: this one says what the answer was sent back for.
            check(
              'Grounded',
              names.length ? 'warn' : 'pass',
              names.length
                ? `${member.title}'s answer still names ${names.join(', ')}, which no report mentioned`
                : `${member.title} answered again without ${mine.sentFor.join(', ')}, which no report mentioned`,
              member.title,
            );
            return undefined;
          }
          if (!names.length) return undefined;
          mine.grounded = 'sent';
          mine.sentFor = names;
          check('Grounded', 'warn', `${member.title}'s answer named ${names.join(', ')}, which no report mentioned`, member.title);
          return `Your answer names ${names.join(', ')}, which none of your reports mentioned. ${filesGiven(member, session, names)}Answer the request again for the person who asked: leave those out unless a report gives them (ask your reports if you need them), where your instructions ask for something no report gave say it wasn't reported, and don't mention this note. ${REPORT_RULE}`;
        }
        if (mine.nudges >= MAX_REVIEW_NUDGES) {
          for (const { report, reviewer, changes } of pending) {
            if (changes) {
              check('Review', 'fail', `${reviewer.title} asked for changes to ${report.title}'s work, and it wasn't reviewed again`, reviewer.title);
              raise(`${reviewer.title} asked for changes to ${report.title}'s work`);
            } else {
              check('Review', 'fail', `${reviewer.title} never reviewed ${report.title}'s work`, reviewer.title);
              raise(`${reviewer.title} has not reviewed ${report.title}'s work`);
            }
          }
          return undefined;
        }
        mine.nudges++;
        return pending
          .map(({ report, reviewer, changes }) =>
            changes
              ? `You may not report done yet: ${reviewer.title} asked for changes to ${report.title}'s work. Send them to ${via(member, report)}, then ask ${via(member, reviewer)} to review it again, then give your answer.`
              : `You may not report done yet: ${report.title}'s work has not been reviewed by ${reviewer.title}. Ask ${via(member, reviewer)} to review it first, then give your answer.`,
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

  /** What every delegate tool does around the call: the budget, the count, then what the answer settles. A pause settles nothing yet. */
  async function guarded(manager: TeamMember, report: TeamMember, input: Record<string, unknown>, work: (message: string) => Promise<ToolOutcome>): Promise<ToolOutcome> {
    const text = String(input.message ?? '').trim();
    if (!text) throw new Error('"message" is empty');
    if (state.overBudget.includes(report.id)) {
      return {
        output: `${report.title} is over its budget of ${report.budgetTokens?.toLocaleString()} tokens for this run and can't take more work. Work with what it delivered, or say what is missing.`,
      };
    }
    state.asked[report.id] = (state.asked[report.id] ?? 0) + 1;
    const outcome = await work(text);
    return outcome.pause ? outcome : settle(manager, report, text, outcome);
  }

  /** A member answered: what its manager heard, the work delivered, the review ledger. */
  function settle(manager: TeamMember, report: TeamMember, text: string, outcome: ToolOutcome): ToolOutcome {
    const answer = typeof outcome.output === 'string' ? outcome.output : JSON.stringify(outcome.output ?? '');
    hear(manager, text, answer, outcome.remote ? JSON.stringify(outcome.remote.steps ?? []) : '');
    state.clock++;
    state.delivered[report.id] = state.clock;
    // A reviewer asked after the work was delivered has looked at it; its verdict, when it gives one, is the sign-off.
    state.reviewed[report.id] = state.clock;
    const verdict = verdictOf(answer);
    if (verdict) state.verdicts[report.id] = verdict;
    else delete state.verdicts[report.id];
    for (const id of report.reviews ?? []) {
      const target = byId.get(id);
      if (!target || state.delivered[id] === undefined) continue;
      if (verdict === 'approve') check('Review', 'pass', `${report.title} approved ${target.title}'s work`, report.title);
      else if (verdict === 'changes') check('Review', 'warn', `${report.title} asked for changes to ${target.title}'s work`, report.title);
      else check('Review', 'pass', `${report.title} was asked to review ${target.title}'s work`, report.title);
    }
    return outcome;
  }

  /** A question for a person, passed up from whoever asked it: the run waits on it at the lead. */
  const questionOf = (pending: AgentSession['pending']) => {
    const call = pending?.calls.find((c) => typeof c.remote?.state.ask === 'string');
    return call && { ask: String(call.remote!.state.ask), asker: String(call.remote!.state.asker ?? call.remote!.agent) };
  };

  async function agentTool(manager: TeamMember, report: AgentMember): Promise<BuiltTool> {
    /** Run the member's loop: with `text`, a new ask; without, going on from the question it paused on. */
    const runMember = async (ctx: ToolContext, text?: string): Promise<ToolOutcome> => {
      const agent = agentStore.get(report.agentId);
      if (!agent) throw new Error(`${report.title}'s agent was deleted`);
      // A member that manages others answers from what its reports gave it, like the lead.
      const manages = reportsOf(config, report.id).length > 0;
      if (text !== undefined) {
        state.tasks[report.id] = text;
        if (manages) state.told[report.id] = withAncestry(manager, text);
      }
      // One session per member for the run: a second ask continues the first.
      let session = state.sessions[report.id];
      if (!session) {
        session = newSession(agent, {
          source: 'agent',
          userId: `team:${request.team.id}`,
          version: agent.published?.version ?? 'draft',
          title: cut(text ?? report.title, 80),
          parentSessionId: ctx.session.id,
          parentAgentId: ctx.agent.id,
        });
        if (request.execution) session.execution = request.execution;
      }
      const role: TeamRole = {
        ...roleFor(report),
        tools: await toolsFor(report),
        ...(ctx.callSpan && { under: ctx.callSpan }),
      };
      const result = await runAgent({
        agent,
        session,
        ...(text !== undefined && { message: manages ? `${withAncestry(manager, text)}\n\n${REPORT_RULE}` : withAncestry(manager, text) }),
        depth: ctx.depth + 1,
        maxDepth: ctx.maxDepth,
        approvals: 'deny',
        signal: ctx.signal,
        team: role,
        ...(request.onMemberEvent && { onEvent: (event: AgentStreamEvent) => request.onMemberEvent!(report.title, event) }),
      });
      state.sessions[report.id] = result.session;
      spend(report, result.session.usage, true);
      const child = { childAgentId: agent.id, childSessionId: result.session.id };
      if (result.reason === 'error') {
        const last = [...result.session.timeline].reverse().find((e) => e.type === 'error');
        throw new Error(last?.type === 'error' ? last.message : `${report.title} failed`);
      }
      if (result.reason === 'awaiting_approval') {
        const question = questionOf(result.session.pending);
        if (!question) throw new Error(`${report.title} waits for an approval no one can give in a team run`);
        return { output: null, pause: { message: question.ask, remote: { agent: report.title, calls: [], state: { member: report.id, ...question } } }, ...child };
      }
      if (result.reason === 'budget') {
        if (!state.overBudget.includes(report.id)) state.overBudget.push(report.id);
        return { output: `${report.title} used up its token budget before it could answer.${result.reply ? ` Its last words: ${result.reply}` : ''}`, ...child };
      }
      return { output: result.reply !== undefined ? marked(report, result.reply) : `(${report.title} gave no answer)`, ...child };
    };
    return {
      kind: 'agent',
      name: toolNameOf(report.title),
      label: report.title,
      description: describe(report),
      inputSchema: inputSchema(report),
      requireApproval: false,
      invoke: (input, ctx) => guarded(manager, report, input, (text) => runMember(ctx, text)),
      // The person answered the question one of its reports asked: the answer goes down to the call it paused on.
      async resume(_saved, _approved, ctx, answer) {
        const pending = state.sessions[report.id]?.pending;
        if (!pending) throw new Error(`${report.title} has no question waiting`);
        for (const call of pending.calls) if (call.remote && typeof call.remote.state.ask === 'string') Object.assign(call, { decision: 'approved', answer: answer ?? '' });
        const outcome = await runMember(ctx);
        return outcome.pause ? outcome : settle(manager, report, answer ?? '', outcome);
      },
    };
  }

  async function remoteTool(manager: TeamMember, report: RemoteMember): Promise<BuiltTool> {
    const toPerson = report.questionsTo === 'person';
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
        // A run that can wait (a flow's) waits for the person's answer; otherwise the question ends it in Needs a person.
        questions: toPerson ? (request.canWait ? 'pause' : 'person') : 'caller',
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
    /** The member's answer as the team names it (by title), its usage counted (or estimated). */
    const account = (outcome: ToolOutcome, message: string): ToolOutcome => {
      if (outcome.remote?.usage) spend(report, outcome.remote.usage);
      else if (!outcome.pause && !state.used[report.id]) spend(report, estimateUsage(message, outcome), false, true);
      const question = outcome.pause?.remote.state.question as { questions?: string[] } | undefined;
      const ask = `${report.title} asks:\n${(question?.questions ?? []).map((q) => `- ${q}`).join('\n')}`;
      return {
        ...outcome,
        ...(outcome.remote && { remote: { ...outcome.remote, agent: report.title } }),
        ...(outcome.pause && { pause: { message: ask, remote: { ...outcome.pause.remote, agent: report.title, state: { ...outcome.pause.remote.state, ask, asker: report.title } } } }),
      };
    };
    return {
      ...base,
      requireApproval: false,
      invoke: (input, ctx) =>
        guarded(manager, report, input, async (text) => {
          if ('error' in built) throw new Error(built.error);
          const known = ctx.session.remoteContexts?.[report.id];
          // An answer to the remote agent's question goes as it is; a new request carries the goal and the manager's task.
          const message = known?.question ? text : withAncestry(manager, text);
          return account(await built.invoke({ ...input, message }, renamed(ctx)), message);
        }),
      // A person answered its question: the answer goes to the task it paused on.
      async resume(saved, approved, ctx, answer) {
        if ('error' in built || !built.resume) throw new Error(`${report.title} can't be reached to take the answer`);
        const outcome = account(await built.resume(saved, approved, renamed(ctx), answer), answer ?? '');
        return outcome.pause ? outcome : settle(manager, report, answer ?? '', outcome);
      },
    };
  }

  // The lead: the node's session (or the one saved when the run waited), its journal under the node's span.
  const userId = request.userId;
  let session: AgentSession;
  if (request.resume?.state.lead) {
    session = request.resume.state.lead;
    for (const call of session.pending?.calls ?? []) if (call.remote && typeof call.remote.state.ask === 'string') Object.assign(call, { decision: 'approved', answer: request.resume.answer });
  } else {
    session = newSession(leadAgent, {
      source: 'workflow',
      userId,
      version: leadAgent.published?.version ?? 'draft',
    });
    if (request.memory) session.messages = await request.memory.load(request.memoryKey || 'default');
    if (request.execution) session.execution = request.execution;
    state.told[root.id] = request.message;
  }
  const role: TeamRole = { ...roleFor(root), tools: await toolsFor(root) };
  const result = await runAgent({
    agent: leadAgent,
    session,
    ...(!request.resume && { message: [config.goal ? `Team goal: ${config.goal}` : '', request.message, reportsOf(config, root.id).length ? REPORT_RULE : ''].filter(Boolean).join('\n\n') }),
    approvals: 'deny',
    signal: request.signal,
    ...(request.flow && { flow: request.flow }),
    ...(request.onEvent && { onEvent: request.onEvent }),
    team: role,
  });
  session = result.session;
  spend(root, session.usage, true);
  const question = result.reason === 'awaiting_approval' ? questionOf(session.pending) : undefined;
  if (result.reason === 'awaiting_approval' && !question) raise(`${root.title} waits for an approval no one can give in a team run`);
  if (request.memory && result.reason !== 'error' && !question) await request.memory.save(request.memoryKey || 'default', session.messages);
  if (result.reason === 'budget') raise(`${root.title} used up its budget or limit (${root.budgetTokens ? `${root.budgetTokens.toLocaleString()} tokens` : 'tokens'})`);
  else if (result.reason === 'max_iterations') raise(`${root.title} did not reach an answer within its iteration limit`);

  return {
    ...(result.reply !== undefined && { reply: marked(root, result.reply) }),
    ...(state.needsPerson.length && { needsPerson: state.needsPerson.join('; ') }),
    ...(question && { waiting: { member: question.asker, question: question.ask, state: { ...state, lead: session } } }),
    members: config.members.map((m) => ({
      title: m.title,
      asked: m.id === root.id ? 1 : (state.asked[m.id] ?? 0),
      tokens: state.tokens[m.id] ?? 0,
      ...(state.estimated[m.id] && { estimated: true as const }),
      ...(state.overBudget.includes(m.id) && { overBudget: true as const }),
    })),
    session,
    reason: result.reason,
    usage: Object.values(state.used).reduce((sum, u) => ({ inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens }), { inputTokens: 0, outputTokens: 0 }),
  };
}
