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
import type { AgentSession, AgentStreamEvent, RemoteRun, RunEndReason, SessionExecution, TokenUsage } from '../../shared/agents';
import { reportsOf, rootOf, type AgentMember, type AgentTeamConfig, type RemoteMember, type TeamMember } from '../../shared/agent-teams';
import { shortArg, verdictOf } from '../../shared/team-progress';
import { agentConnections, remoteConnections } from '../agents/connections';
import { agentStore } from '../agents/store';
import { estimateCost, findPrice, priceOverrides } from '../ai-usage/prices';
import { newSession, runAgent, type TeamRole } from '../agents/runtime';
import { a2aAgentTool, type BuiltTool, type ToolContext, type ToolOutcome } from '../agents/tools';
import { liveJournal } from '../journal/writer';
import { holdMember } from './pause';
import { issuesOf } from './store';

/** How long a manager's own task is when it goes on to its reports. */
const TASK_CHARS = 600;
/** How often a manager is sent back to ask a reviewer before it may report done. */
const MAX_REVIEW_NUDGES = 2;
/** How many consults or hand-offs may follow one another (a member consults a peer who consults another): no more below this. */
const MAX_CONSULT_HOPS = 2;
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
  /**
   * A member's tokens so far, by title, whenever they change: after each model call of an agent member (and the lead), as
   * a remote member's mod reports them mid-task, and once it answers (`estimated` when it reports none).
   */
  onUsage?: (title: string, tokens: number, estimated: boolean) => void;
  /**
   * Going on after a wait: the state saved then (TeamRunResult.waiting), the person's answer to a question, or their
   * decisions on the tool calls waiting for approval (by call id, as `waiting.approval` named them).
   */
  resume?: { state: TeamState; answer: string; decisions?: Record<string, TeamDecision> };
}

/** A person's word on a tool call: from the approval route (`by` is who, `at` when). */
export interface TeamDecision {
  approved: boolean;
  by?: string;
  at?: string;
}

/** A tool call a member waits to use until a person approves it. */
export interface TeamApprovalCall {
  /** `<member id>/<call id>`: the key of the decision. */
  id: string;
  tool: string;
  label: string;
  input: Record<string, unknown>;
}

/** The tool calls the run waits on, and the member that wants them. */
export interface TeamApproval {
  member: string;
  calls: TeamApprovalCall[];
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
  /** Per member: time spent answering its requests, ms (absent in runs saved before it was kept). */
  ms?: Record<string, number>;
  /** Per member that handed its task to a peer in its running turn: the peer and its answer, which becomes the member's result. */
  handoffs?: Record<string, { to: string; answer: string }>;
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
  ms: {},
});

export interface MemberReport {
  title: string;
  /** How many times it was asked (the lead: 1). */
  asked: number;
  tokens: number;
  /** A remote member that reports no usage: its tokens are estimated from what went to it and came back. */
  estimated?: true;
  overBudget?: true;
  /** Its input and output tokens, and of the input what came from the prompt cache (when reported). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** USD: what its mod reported, priced (a remote member), or its model's price (an agent member). */
  costUsd?: number;
  /** The model it ran on, as it reported it (else its agent's). */
  model?: string;
  /** Model requests, when reported. */
  requests?: number;
  /** Time spent answering its requests (the lead: its whole run), ms. */
  ms?: number;
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
  /**
   * The run waits for a person: who asked what, and the state to go on from (TeamRunRequest.resume). With `approval`, the
   * wait is for a tool call that needs approval, not a question (`question` then says what the member wants to do).
   */
  waiting?: { member: string; question: string; state: TeamState; approval?: TeamApproval };
}

const total = (usage: { inputTokens: number; outputTokens: number }) => usage.inputTokens + usage.outputTokens;

/** Two usages together: tokens add up, and cost, cache reads and requests where either has them; the later model wins. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd' | 'requests') => (a[key] !== undefined || b[key] !== undefined ? { [key]: (a[key] ?? 0) + (b[key] ?? 0) } : {});
  const model = b.model ?? a.model;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, ...sum('cacheReadTokens'), ...sum('cacheWriteTokens'), ...sum('costUsd'), ...sum('requests'), ...(model && { model }) };
}
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
export const consultToolNameOf = (title: string) => toToolName(`consult_${title}`).toLowerCase();
export const handOffToolNameOf = (title: string) => toToolName(`hand_off_to_${title}`).toLowerCase();

/** How a wait for approval reads: "Developer wants to use Comment on pull request". */
export const approvalText = (approval: TeamApproval) => `${approval.member} wants to use ${approval.calls.map((c) => c.label).join(', ')}`;

type Mode = 'ask' | 'consult' | 'handoff';
/** The members in a call chain (the lead down to the member running) and how many consults or hand-offs are in it. */
interface Trail {
  ids: string[];
  hops: number;
}

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

  /**
   * What a member works with, for the chart: an agent's settings (the lead's model and memory when the flow doesn't give
   * them), a remote member's kagent deployment (Claude Code, its model, plugins and network) or its host.
   */
  const connectionsOf = (m: TeamMember) => {
    try {
      if (m.kind === 'a2a') return remoteConnections(typeof m.parameters.agentUrl === 'string' ? m.parameters.agentUrl : undefined);
      const agent = agentStore.get(m.agentId);
      if (!agent) return [];
      return agentConnections(agent, m.id === root.id ? { model: Boolean(request.flow?.model), memory: Boolean(request.memory) } : {});
    } catch {
      return [];
    }
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
          members: config.members.map((m) => {
            const connections = connectionsOf(m);
            return {
              id: m.id,
              title: m.title,
              kind: m.kind,
              ...(m.role && { role: m.role }),
              ...(m.reportsTo && { reportsTo: m.reportsTo }),
              ...(m.reviews?.length && { reviews: m.reviews }),
              ...(m.consults?.length && { consults: m.consults }),
              ...(m.budgetTokens && { budgetTokens: m.budgetTokens }),
              ...(connections.length > 0 && { connections }),
            };
          }),
        },
      },
    });
  }

  /** A member's usage so far (`set`: its session's total) or more of it (a remote answer's, or an estimate of one). */
  const spend = (member: TeamMember, usage: TokenUsage, set = false, guess = false) => {
    const ledger = guess ? state.estimated : state.used;
    const before = ledger[member.id];
    const mine = set || !before ? { ...usage } : addUsage(before, usage);
    ledger[member.id] = mine;
    if (!guess) delete state.estimated[member.id];
    const now = total(mine);
    state.tokens[member.id] = now;
    request.onUsage?.(member.title, now, guess);
    const budget = member.budgetTokens;
    if (!budget) return;
    const about = guess ? 'about ' : '';
    const why = guess ? ' (estimated: it reports no usage)' : '';
    if (now >= budget && !state.overBudget.includes(member.id)) {
      state.overBudget.push(member.id);
      check('Budget', 'fail', `${member.title} used ${about}${now.toLocaleString()} of its ${budget.toLocaleString()} tokens and was stopped${why}`, member.title);
    } else if (now >= budget * 0.8 && !state.warned.includes(member.id) && !state.overBudget.includes(member.id)) {
      state.warned.push(member.id);
      check('Budget', 'warn', `${member.title} used ${about}${now.toLocaleString()} of its ${budget.toLocaleString()} tokens (80%)${why}`, member.title);
    }
  };

  const timed = (member: TeamMember, started: number) => {
    const ms = (state.ms ??= {});
    ms[member.id] = (ms[member.id] ?? 0) + (Date.now() - started);
  };

  /** USD a member's usage cost: what its mod reported (priced), else its agent's model's price (none for a remote guess). */
  const costOf = (member: TeamMember, usage: TokenUsage | undefined): number | undefined => {
    if (!usage) return undefined;
    if (usage.costUsd !== undefined) return usage.costUsd;
    if (member.kind !== 'agent') return undefined;
    const agent = agentStore.get(member.agentId);
    const model = (agent?.published?.config ?? agent)?.model;
    if (!model) return undefined;
    const price = findPrice(model.provider, model.model, priceOverrides());
    if (!price) return model.provider === 'ollama' ? 0 : undefined;
    return estimateCost(price, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0);
  };
  const modelOf = (member: TeamMember, usage: TokenUsage | undefined): string | undefined => {
    if (usage?.model) return usage.model;
    if (member.kind !== 'agent') return undefined;
    const agent = agentStore.get(member.agentId);
    return (agent?.published?.config ?? agent)?.model?.model;
  };

  /**
   * What the whole team used, its cost where some member's was priced. Its model is the lead's: the team node's span is
   * the lead's, so what the members' own spans don't account for (the lead's calls) is told with the lead's model.
   */
  const teamUsage = (): TokenUsage => {
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for (const member of config.members) {
      const used = state.used[member.id];
      if (!used) continue;
      const cost = costOf(member, used);
      const { model: _model, ...rest } = used;
      usage = addUsage(usage, { ...rest, ...(cost !== undefined && { costUsd: cost }) });
    }
    const lead = root && modelOf(root, state.used[root.id]);
    if (lead) usage.model = lead;
    return usage.costUsd !== undefined ? { ...usage, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 } : usage;
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
      // A member that handed its task to a peer is done once the peer has answered.
      stopAfterTools: () => {
        const handed = state.handoffs?.[member.id];
        return handed ? `Handed the task to ${byId.get(handed.to)?.title ?? 'a peer'}.` : undefined;
      },
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

  /** The tools for a member's direct reports, and for the peers it may consult or hand its task to. */
  async function toolsFor(manager: TeamMember, trail: Trail = { ids: [manager.id], hops: 0 }): Promise<BuiltTool[]> {
    const reports = await Promise.all(reportsOf(config, manager.id).map((report) => (report.kind === 'agent' ? agentTool(manager, report, 'ask', trail) : remoteTool(manager, report, 'ask'))));
    return [...reports, ...(await peerTools(manager, trail))];
  }

  /** Members running a turn now: a peer is consulted only when it is free (one session each). */
  const running = new Set<string>();

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
  async function guarded(manager: TeamMember, report: TeamMember, input: Record<string, unknown>, work: (message: string) => Promise<ToolOutcome>, mode: Mode = 'ask'): Promise<ToolOutcome> {
    const text = String(input.message ?? '').trim();
    if (!text) throw new Error('"message" is empty');
    if (state.overBudget.includes(report.id)) {
      return {
        output: `${report.title} is over its budget of ${report.budgetTokens?.toLocaleString()} tokens for this run and can't take more work. Work with what it delivered, or say what is missing.`,
      };
    }
    state.asked[report.id] = (state.asked[report.id] ?? 0) + 1;
    const started = Date.now();
    try {
      const outcome = await work(text);
      return outcome.pause ? outcome : settle(manager, report, text, outcome, mode);
    } finally {
      timed(report, started);
    }
  }

  /** A member answered: what its manager heard, the work delivered, the review ledger. */
  function settle(manager: TeamMember, report: TeamMember, text: string, outcome: ToolOutcome, mode: Mode = 'ask'): ToolOutcome {
    const answer = typeof outcome.output === 'string' ? outcome.output : JSON.stringify(outcome.output ?? '');
    hear(manager, text, answer, outcome.remote ? JSON.stringify(outcome.remote.steps ?? []) : '');
    state.clock++;
    // A consult answers a question: it is neither work delivered nor a review. A hand-off delivers the work.
    if (mode === 'consult') return outcome;
    state.delivered[report.id] = state.clock;
    if (mode === 'handoff') return outcome;
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

  /** The name a tool call went by in a session's timeline (the tool's label), else its tool name. */
  const labelOf = (session: AgentSession, callId: string, tool: string) => {
    const entry = session.timeline.find((e) => e.type === 'tool' && e.callId === callId);
    return entry?.type === 'tool' ? entry.label : tool;
  };

  /** What a paused session waits on: a question for a person, or tool calls that need approval (its own, or passed up from a member below). */
  type Block = { kind: 'question'; ask: string; asker: string } | { kind: 'approval'; approval: TeamApproval };
  const blockOf = (session: AgentSession, owner: TeamMember): Block | undefined => {
    const pending = session.pending;
    const question = questionOf(pending);
    if (question) return { kind: 'question', ...question };
    const passed = pending?.calls.find((c) => c.remote?.state.approval);
    if (passed) return { kind: 'approval', approval: passed.remote!.state.approval as TeamApproval };
    const own = pending?.calls.filter((c) => !c.remote) ?? [];
    if (!own.length) return undefined;
    return { kind: 'approval', approval: { member: owner.title, calls: own.map((c) => ({ id: `${owner.id}/${c.callId}`, tool: c.tool, label: labelOf(session, c.callId, c.tool), input: c.input as Record<string, unknown> })) } };
  };
  /** The pause a member's manager gets while the member waits on a person. */
  const pauseOf = (member: TeamMember, block: Block): NonNullable<ToolOutcome['pause']> =>
    block.kind === 'question'
      ? { message: block.ask, remote: { agent: member.title, calls: [], state: { member: member.id, ask: block.ask, asker: block.asker } } }
      : { message: approvalText(block.approval), remote: { agent: member.title, calls: [], state: { member: member.id, approval: block.approval as unknown as Record<string, unknown> } } };

  /**
   * The person's word goes into a paused session: its own tool calls get their decision (a check says who decided what and
   * when; one nobody decided in time is refused), a question gets the answer, and a call waiting on a member below is let
   * through to it.
   */
  const applyWord = (owner: TeamMember, session: AgentSession | undefined, answer: string) => {
    for (const call of session?.pending?.calls ?? []) {
      if (call.remote) {
        if (typeof call.remote.state.ask === 'string' || call.remote.state.approval) Object.assign(call, { decision: 'approved', answer });
        continue;
      }
      const word = request.resume?.decisions?.[`${owner.id}/${call.callId}`];
      const label = labelOf(session!, call.callId, call.tool);
      Object.assign(call, { decision: word?.approved ? 'approved' : 'denied' });
      const when = word?.at ? ` at ${word.at.replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z$/, ' UTC')}` : '';
      if (!word) check('Approval', 'warn', `${owner.title}'s use of ${label} was not approved in time`, owner.title);
      else check('Approval', word.approved ? 'pass' : 'warn', `${word.by ?? 'A person'} ${word.approved ? 'approved' : 'rejected'} ${owner.title}'s use of ${label}${when}`, owner.title);
    }
  };

  async function agentTool(manager: TeamMember, report: AgentMember, mode: Mode, trail: Trail): Promise<BuiltTool> {
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
      // A person may pause this member between steps and give it an instruction (pause.ts).
      const held = request.execution && holdMember(request.execution.executionId, report.title, 'agent', { under: ctx.callSpan, actor: { id: `agent:${agent.id}`, name: report.title, type: 'agent' } });
      const role: TeamRole = {
        ...roleFor(report),
        tools: await toolsFor(report, { ids: [...trail.ids, report.id], hops: trail.hops + (mode === 'ask' ? 0 : 1) }),
        ...(ctx.callSpan && { under: ctx.callSpan }),
        ...(held && { pause: held }),
      };
      running.add(report.id);
      const result = await runAgent({
        agent,
        session,
        ...(text !== undefined && { message: manages ? `${withAncestry(manager, text)}\n\n${REPORT_RULE}` : withAncestry(manager, text) }),
        depth: ctx.depth + 1,
        maxDepth: ctx.maxDepth,
        approvals,
        signal: ctx.signal,
        team: role,
        ...(request.onMemberEvent && { onEvent: (event: AgentStreamEvent) => request.onMemberEvent!(report.title, event) }),
        onUsage: (usage) => spend(report, usage, true),
      }).finally(() => {
        held?.release();
        running.delete(report.id);
      });
      state.sessions[report.id] = result.session;
      spend(report, result.session.usage, true);
      const child = { childAgentId: agent.id, childSessionId: result.session.id };
      if (result.reason === 'error') {
        const last = [...result.session.timeline].reverse().find((e) => e.type === 'error');
        throw new Error(last?.type === 'error' ? last.message : `${report.title} failed`);
      }
      if (result.reason === 'awaiting_approval') {
        const block = blockOf(result.session, report);
        if (!block) throw new Error(`${report.title} waits for an approval no one can give in a team run`);
        return { output: null, pause: pauseOf(report, block), ...child };
      }
      if (result.reason === 'budget') {
        if (!state.overBudget.includes(report.id)) state.overBudget.push(report.id);
        return { output: `${report.title} used up its token budget before it could answer.${result.reply ? ` Its last words: ${result.reply}` : ''}`, ...child };
      }
      // A member that handed its task to a peer answers with the peer's answer: its manager gets that as the result of its ask.
      const handed = state.handoffs?.[report.id];
      if (handed) {
        delete state.handoffs![report.id];
        return { output: `${handed.answer}\n\n(${report.title} handed this task to ${byId.get(handed.to)?.title ?? 'a peer'}, who answered.)`, ...child };
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
      invoke: (input, ctx) => guarded(manager, report, input, (text) => runMember(ctx, text), mode),
      // The person answered the question one of its reports asked, or decided its tool calls: it goes down to the calls it paused on.
      async resume(_saved, _approved, ctx, answer) {
        if (!state.sessions[report.id]?.pending) throw new Error(`${report.title} has nothing waiting`);
        applyWord(report, state.sessions[report.id], answer ?? '');
        const outcome = await runMember(ctx);
        return outcome.pause ? outcome : settle(manager, report, answer ?? '', outcome, mode);
      },
    };
  }

  async function remoteTool(manager: TeamMember, report: RemoteMember, mode: Mode): Promise<BuiltTool> {
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
    /** What it used before this request, and so far in it as its mod reports (no spend: the answer brings the total). */
    const liveUsage = (remote: RemoteRun) => {
      const now = remote.usage ?? (remote.trace && { inputTokens: remote.trace.usage.inputTokens, outputTokens: remote.trace.usage.outputTokens });
      if (now && total(now) > 0) request.onUsage?.(report.title, (state.used[report.id] ? total(state.used[report.id]) : 0) + total(now), false);
    };
    const renamed = (ctx: ToolContext): ToolContext => ({
      ...ctx,
      progress:
        ctx.progress &&
        ((remote) => {
          liveUsage(remote);
          ctx.progress!({ ...remote, agent: report.title });
        }),
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
    /**
     * Send `message` so a person can stop the task and redirect it (pause.ts): the task is canceled, the person's instruction
     * goes to the same conversation as a new message, and its answer is the call's.
     */
    const redirectable = async (ctx: ToolContext, input: Record<string, unknown>, first: string): Promise<ToolOutcome> => {
      if ('error' in built) throw new Error(built.error);
      const send = (message: string, c: ToolContext) => built.invoke({ ...input, message }, c);
      if (!request.execution) return account(await send(first, renamed(ctx)), first);
      const attempt = { taskId: undefined as string | undefined, contextId: undefined as string | undefined, stopped: false, abort: new AbortController() };
      const held = holdMember(request.execution.executionId, report.title, 'remote', {
        under: ctx.callSpan,
        actor: { id: `remote:${report.title}`, name: report.title, type: 'agent' },
        async stop() {
          attempt.stopped = true;
          if (attempt.taskId) await built.cancelTask?.(attempt.taskId).catch(() => {});
          attempt.abort.abort();
        },
      });
      try {
        let message = first;
        for (;;) {
          Object.assign(attempt, { taskId: undefined, contextId: undefined, stopped: false, abort: new AbortController() });
          const stop = () => attempt.abort.abort();
          if (ctx.signal?.aborted) stop();
          else ctx.signal?.addEventListener('abort', stop, { once: true });
          const own = renamed(ctx);
          const watching: ToolContext = {
            ...own,
            signal: attempt.abort.signal,
            progress: (remote) => {
              attempt.taskId = remote.taskId ?? attempt.taskId;
              attempt.contextId = remote.contextId ?? attempt.contextId;
              own.progress?.(remote);
            },
          };
          try {
            return account(await send(message, watching), message);
          } catch (error) {
            if (!attempt.stopped || ctx.signal?.aborted) throw error;
            if (attempt.contextId) (ctx.session.remoteContexts ??= {})[report.id] = { contextId: attempt.contextId };
            const instruction = await held.wait({ summary: `Stopped ${report.title} to redirect it`, signal: ctx.signal });
            if (ctx.signal?.aborted) throw error;
            message = instruction ? `A person stopped you and says:\n${instruction}` : 'A person stopped you and let you go on: carry on with your task from where you stopped.';
          } finally {
            ctx.signal?.removeEventListener('abort', stop);
          }
        }
      } finally {
        held.release();
      }
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
          return redirectable(ctx, input, message);
        }, mode),
      // A person answered its question: the answer goes to the task it paused on.
      async resume(saved, approved, ctx, answer) {
        if ('error' in built || !built.resume) throw new Error(`${report.title} can't be reached to take the answer`);
        const outcome = account(await built.resume(saved, approved, renamed(ctx), answer), answer ?? '');
        return outcome.pause ? outcome : settle(manager, report, answer ?? '', outcome, mode);
      },
    };
  }

  /**
   * The tools of a member for its peers (`consults`): `consult_<title>` asks a peer a question and the answer comes back to
   * the member that asked (not to its manager); `hand_off_to_<title>` passes the member's task and notes to the peer, which
   * works on it while the member steps out, and the peer's answer goes to the member's manager as the result of the ask.
   * Only Landflow agents have these tools (a remote member has none to call), though a peer may be a remote member. A peer
   * already in the chain is not offered, and one busy with another request says so: no loops.
   */
  async function peerTools(member: TeamMember, trail: Trail): Promise<BuiltTool[]> {
    if (member.kind !== 'agent' || trail.hops >= MAX_CONSULT_HOPS) return [];
    const peers = (member.consults ?? []).flatMap((id) => {
      const peer = byId.get(id);
      return peer && peer.id !== member.id && !trail.ids.includes(peer.id) ? [peer] : [];
    });
    const tools: BuiltTool[] = [];
    for (const peer of peers) {
      for (const mode of ['consult', 'handoff'] as const) {
        const base = peer.kind === 'agent' ? await agentTool(member, peer, mode, trail) : await remoteTool(member, peer, mode);
        const handOff = mode === 'handoff';
        const role = peer.role?.trim().replace(/\.$/, '');
        const ready = (outcome: ToolOutcome): ToolOutcome => {
          if (!handOff || outcome.pause) return outcome;
          // A peer over its budget answered nothing: the task isn't handed off.
          if (state.overBudget.includes(peer.id)) return outcome;
          state.handoffs = { ...state.handoffs, [member.id]: { to: peer.id, answer: asText(outcome.output) } };
          check('Hand-off', 'pass', `${member.title} handed the task to ${peer.title}`, member.title);
          return { ...outcome, output: `You handed the task to ${peer.title}, who has finished it; its answer goes to your manager as yours. Your turn is over: reply with one short line saying so.` };
        };
        tools.push({
          ...base,
          name: handOff ? handOffToolNameOf(peer.title) : consultToolNameOf(peer.title),
          label: peer.title,
          description: handOff
            ? [role, `${peer.title} is your peer`, `hand your task to ${peer.title} when it is better placed than you to finish it: it works on it with your notes and its answer goes to your manager as your result, and your turn ends`].filter(Boolean).join('. ') + '.'
            : [role, `${peer.title} is your peer, not your report`, 'consult it when you need its knowledge: its answer comes back to you'].filter(Boolean).join('. ') + '.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              message: {
                type: 'string',
                description: handOff
                  ? `Your notes for ${peer.title}: what you did and found, and what is left. It does not see your conversation`
                  : `What to ask ${peer.title}. It does not see your conversation: say what it needs to know`,
              },
              reason: { type: 'string', description: REASON_DESCRIPTION },
            },
            required: ['message', 'reason'],
          },
          invoke: async (input, ctx) => {
            if (running.has(peer.id)) return { output: `${peer.title} is busy with another request right now. Ask your manager, or go on without it.` };
            return ready(await base.invoke(input, ctx));
          },
          ...(base.resume && { resume: async (...args: Parameters<NonNullable<BuiltTool['resume']>>) => ready(await base.resume!(...args)) }),
        });
      }
    }
    return tools;
  }

  // The lead: the node's session (or the one saved when the run waited), its journal under the node's span.
  const userId = request.userId;
  /** Tools that need approval pause the run where a person can decide (a flow's); elsewhere they are refused. */
  const approvals = request.canWait ? ('ask' as const) : ('deny' as const);
  let session: AgentSession;
  if (request.resume?.state.lead) {
    session = request.resume.state.lead;
    applyWord(root, session, request.resume.answer);
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
  const heldLead = request.execution && holdMember(request.execution.executionId, root.title, 'agent', { under: nodeSpan(), actor: { id: `agent:${leadAgent.id}`, name: root.title, type: 'agent' } });
  const role: TeamRole = { ...roleFor(root), tools: await toolsFor(root), ...(heldLead && { pause: heldLead }) };
  const leadStarted = Date.now();
  const result = await runAgent({
    agent: leadAgent,
    session,
    ...(!request.resume && { message: [config.goal ? `Team goal: ${config.goal}` : '', request.message, reportsOf(config, root.id).length ? REPORT_RULE : ''].filter(Boolean).join('\n\n') }),
    approvals,
    signal: request.signal,
    ...(request.flow && { flow: request.flow }),
    ...(request.onEvent && { onEvent: request.onEvent }),
    onUsage: (usage) => spend(root, usage, true),
    team: role,
  }).finally(() => heldLead?.release());
  session = result.session;
  timed(root, leadStarted);
  spend(root, session.usage, true);
  const block = result.reason === 'awaiting_approval' ? blockOf(session, root) : undefined;
  if (result.reason === 'awaiting_approval' && !block) raise(`${root.title} waits for an approval no one can give in a team run`);
  // A lead that handed its task to a peer answers with the peer's answer.
  const handed = state.handoffs?.[root.id];
  if (handed) delete state.handoffs![root.id];
  // Outside a flow nobody can approve: the tool was refused, and the run leaves by Needs a person with what was wanted.
  if (!request.canWait) {
    const sessions = [[root.title, session] as const, ...config.members.flatMap((m) => (state.sessions[m.id] ? [[m.title, state.sessions[m.id]] as const] : []))];
    for (const [title, s] of sessions) {
      for (const e of s.timeline) if (e.type === 'tool' && e.status === 'denied' && e.error?.includes("needs a person's approval")) raise(`${title} wanted to use ${e.label}, which needs a person's approval`);
    }
  }
  if (request.memory && result.reason !== 'error' && !block) await request.memory.save(request.memoryKey || 'default', session.messages);
  if (result.reason === 'budget') raise(`${root.title} used up its budget or limit (${root.budgetTokens ? `${root.budgetTokens.toLocaleString()} tokens` : 'tokens'})`);
  else if (result.reason === 'max_iterations') raise(`${root.title} did not reach an answer within its iteration limit`);

  return {
    ...(result.reply !== undefined && { reply: handed ? handed.answer : marked(root, result.reply) }),
    ...(state.needsPerson.length && { needsPerson: state.needsPerson.join('; ') }),
    ...(block && {
      waiting:
        block.kind === 'question'
          ? { member: block.asker, question: block.ask, state: { ...state, lead: session } }
          : { member: block.approval.member, question: approvalText(block.approval), state: { ...state, lead: session }, approval: block.approval },
    }),
    members: config.members.map((m) => {
      const used = state.used[m.id];
      const cost = costOf(m, used);
      const model = modelOf(m, used);
      return {
        title: m.title,
        asked: m.id === root.id ? 1 : (state.asked[m.id] ?? 0),
        tokens: state.tokens[m.id] ?? 0,
        ...(state.estimated[m.id] && { estimated: true as const }),
        ...(state.overBudget.includes(m.id) && { overBudget: true as const }),
        ...(used && { inputTokens: used.inputTokens, outputTokens: used.outputTokens }),
        ...(used?.cacheReadTokens && { cacheReadTokens: used.cacheReadTokens }),
        ...(cost !== undefined && { costUsd: Math.round(cost * 1e6) / 1e6 }),
        ...(model && { model }),
        ...(used?.requests && { requests: used.requests }),
        ...(state.ms?.[m.id] && { ms: state.ms[m.id] }),
      };
    }),
    session,
    reason: result.reason,
    usage: teamUsage(),
  };
}
