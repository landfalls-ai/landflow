/**
 * What a Run a Team node reports while it runs (`node.progress`, docs/agent-teams.md#watching-a-team-work): who in the
 * team works now and on what, folded from the lead's timeline as it streams. The canvases turn the node into the member
 * at work (its face, title and what it does in plain words, with its last steps), mark each turn on a ribbon and show the
 * moments that matter beside it (a failing test, a review's verdict), so a run can be watched without opening it. What
 * the run did stays on the node's output as its `activity`.
 */
import type { AgentStreamEvent, RemoteToolStep } from './agents';

export type MemberState = 'idle' | 'working' | 'done' | 'failed';

export interface TeamProgressMember {
  title: string;
  state: MemberState;
  /** How many times its manager asked it so far. */
  asked: number;
  /** What it does now, in a few words (working only). */
  doing?: string;
}

/** A step on the node's ticker: the tool, its argument as short text, and the plain words for it. */
export interface TeamStep {
  name: string;
  status: RemoteToolStep['status'];
  args?: string;
  plain: string;
  /** How long it took, once finished. */
  ms?: number;
}

/** One member's turn at the work, in milliseconds since the team started. */
export interface TeamTurn {
  member: string;
  start: number;
  end?: number;
}

/** A result worth a glance (tests pass, a review asks for changes), when it happened and whose it was. */
export interface TeamMoment {
  at: number;
  member: string;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

/** What a team run did, kept on the node's output (`activity`): its turns, its moments and each member's step count. */
export interface TeamActivity {
  durationMs: number;
  turns: TeamTurn[];
  moments: TeamMoment[];
  steps: Record<string, number>;
}

/** The `data` of a team node's progress report. */
export interface TeamProgress {
  /** The member working now (the lead between hand-offs), also as `agent` for the generic progress readers. */
  member: string;
  agent: string;
  state: 'working';
  /** What it does, as the step reads ("Bash: pnpm test"). */
  doing?: string;
  /** The same in plain words ("Running the tests"). */
  plain?: string;
  /** The step's command or argument as written, when it runs one. */
  command?: string;
  /** How many steps the working member took in this turn. */
  stepCount: number;
  /** The working member's latest steps, arguments as short text. */
  steps: TeamStep[];
  team: { lead: string; members: TeamProgressMember[] };
  turns: TeamTurn[];
  /** The latest moments, oldest first. */
  moments: TeamMoment[];
  /** Milliseconds since the team started, when this was reported. */
  at: number;
}

const KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'query', 'url', 'pattern', 'text'];
const STEPS = 5;
const MOMENTS = 8;

/** The most telling argument of a step in a few words: a command, a path, a query. */
export function shortArg(args: Record<string, unknown> | undefined, max = 60): string | undefined {
  if (!args) return undefined;
  const key = KEYS.find((k) => typeof args[k] === 'string' && args[k]) ?? Object.keys(args).find((k) => typeof args[k] === 'string' && args[k]);
  const text = key ? String(args[key]).replace(/\s+/g, ' ').trim() : undefined;
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Arguments as an object: progress can carry them as JSON text. */
function argsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value };
  } catch {
    return { value };
  }
}

/** What a step is for, when it is one of the steps whose result matters. */
export type StepKind = 'test' | 'typecheck' | 'lint' | 'build' | 'install' | 'clone' | 'commit' | 'push' | 'pr' | 'merge';

const baseName = (path: string) => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;
const sentence = (name: string) => {
  const words = name.replace(/^mcp__[^_]+__/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
};

/** Shell commands: the last command of a chain says what it is for ("cd x && pnpm install && pnpm test" runs the tests). */
const COMMANDS: Array<[RegExp, string, StepKind?]> = [
  [/\bgh\s+pr\s+create\b/, 'Opening a pull request', 'pr'],
  [/\bgh\s+pr\s+merge\b/, 'Merging the pull request', 'merge'],
  [/\bgh\s+pr\s+(view|diff|checks|status|list)\b/, 'Checking the pull request'],
  [/\bgit\s+clone\b/, 'Cloning the repository', 'clone'],
  [/\bgit\s+commit\b/, 'Committing', 'commit'],
  [/\bgit\s+push\b/, 'Pushing the branch', 'push'],
  [/\bgit\s+(checkout|switch)\b/, 'Switching branch'],
  [/\bgit\s+(pull|fetch)\b/, 'Fetching the latest'],
  [/\bgit\s+(status|diff|log|show)\b/, 'Looking at the changes'],
  [/\b(typecheck|type-check|tsc|mypy|pyright)\b/, 'Type-checking', 'typecheck'],
  [/\b(lint|eslint|ruff|golangci-lint|biome)\b/, 'Linting', 'lint'],
  [/\b(vitest|jest|pytest|unittest|mocha)\b|\bgo\s+test\b|\b(pnpm|npm|yarn|bun)\b.*\btest\b|\bcargo\s+test\b/, 'Running the tests', 'test'],
  [/\b(pnpm|npm|yarn|bun)\b.*\b(i|install|ci|add)\b|\bpip3?\s+install\b|\bgo\s+mod\s+(download|tidy)\b|\bpoetry\s+install\b/, 'Installing dependencies', 'install'],
  [/\b(pnpm|npm|yarn|bun)\b.*\bbuild\b|\bgo\s+build\b|\bcargo\s+build\b|\bmake\b/, 'Building', 'build'],
];

function narrateCommand(command: string): { plain: string; kind?: StepKind } {
  const parts = command.split(/&&|\|\||;|\n/).map((p) => p.trim()).filter(Boolean);
  const dir = parts.map((p) => /^cd\s+(\S+)/.exec(p)?.[1]).filter(Boolean).at(-1);
  const meaningful = parts.filter((p) => !/^(cd|export|set|source|\.)\s/.test(p));
  const last = meaningful.at(-1) ?? parts.at(-1) ?? command;
  for (const [pattern, plain, kind] of COMMANDS) if (pattern.test(last)) return { plain, kind };
  const [word, ...rest] = last.split(/\s+/);
  const target = rest.filter((a) => !a.startsWith('-')).at(-1);
  if (/^(cat|head|tail|less|wc)$/.test(word) && target) return { plain: `Reading ${baseName(target)}` };
  if (/^(ls|tree|find|pwd|du)$/.test(word)) return { plain: `Looking around ${baseName(target ?? dir ?? '.')}` };
  if (/^(grep|rg|ag)$/.test(word)) return { plain: 'Searching the code' };
  if (/^(curl|wget|http)$/.test(word)) return { plain: 'Calling a URL' };
  if (/^(mkdir|cp|mv|rm|touch|chmod)$/.test(word)) return { plain: 'Arranging files' };
  return { plain: word ? `Running ${baseName(word)}` : 'Running a command' };
}

/**
 * A step in plain words ("Running the tests", "Reading PLAN.md"), and what it is for when its result matters. A step
 * with no rule keeps its tool's name as a sentence.
 */
export function narrate(name: string, args?: unknown): { plain: string; kind?: StepKind } {
  const a = argsOf(args) ?? {};
  const text = (key: string) => (typeof a[key] === 'string' ? (a[key] as string) : undefined);
  const path = text('file_path') ?? text('filePath') ?? text('path') ?? text('notebook_path');
  const tool = name.replace(/^mcp__[^_]+__/, '').toLowerCase();
  const command = text('command') ?? text('cmd') ?? (/^(bash|shell|exec|run|terminal)/.test(tool) ? text('value') : undefined);
  if (command && /^(bash|shell|exec|run_command|run|terminal|execute_command)/.test(tool)) return narrateCommand(command);
  if (/^(read|read_file|view|open|cat)/.test(tool)) return { plain: path ? `Reading ${baseName(path)}` : 'Reading a file' };
  if (/^(write|edit|multiedit|multi_edit|str_replace|create_file|notebookedit|apply_patch)/.test(tool)) return { plain: path ? `Editing ${baseName(path)}` : 'Editing files' };
  if (/^(grep|glob|search|find|ls|list)/.test(tool)) {
    const pattern = text('pattern') ?? text('query');
    return { plain: pattern ? `Searching for ${pattern.length > 32 ? `${pattern.slice(0, 31)}…` : pattern}` : 'Searching the code' };
  }
  if (/^web_?fetch|^fetch/.test(tool)) {
    const url = text('url');
    const host = url && /^https?:\/\/([^/]+)/.exec(url)?.[1];
    return { plain: host ? `Reading ${host}` : 'Reading a web page' };
  }
  if (/^web_?search/.test(tool)) return { plain: 'Searching the web' };
  if (/^(task|agent)$/.test(tool)) return { plain: 'Asking a sub-agent' };
  if (/^todo/.test(tool)) return { plain: 'Updating the to-do list' };
  if (command) return narrateCommand(command);
  return { plain: sentence(name) };
}

/** "Bash: pnpm test". */
const stepLine = (step: Pick<RemoteToolStep, 'name' | 'args'>) => {
  const arg = shortArg(argsOf(step.args), 48);
  return arg ? `${step.name}: ${arg}` : step.name;
};

const textOf = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value));

/** The moment a finished step makes, when its result matters. */
function stepMoment(kind: StepKind | undefined, ok: boolean, output: string): Omit<TeamMoment, 'at' | 'member'> | undefined {
  const exit = /exit(?:ed with)?\s*(?:code)?\s*(\d+)/i.exec(output)?.[1];
  switch (kind) {
    case 'test': {
      const passed = /(\d+)\s+(?:tests?\s+)?pass(?:ed)?/i.exec(output)?.[1];
      return ok ? { tone: 'ok', text: passed ? `${passed} tests pass` : 'Tests pass' } : { tone: 'bad', text: exit ? `Tests failed · exit ${exit}` : 'Tests failed' };
    }
    case 'typecheck':
      return ok ? { tone: 'ok', text: 'Typecheck passed' } : { tone: 'bad', text: 'Typecheck failed' };
    case 'lint':
      return ok ? { tone: 'ok', text: 'Lint passed' } : { tone: 'bad', text: 'Lint failed' };
    case 'build':
      return ok ? { tone: 'ok', text: 'Build passed' } : { tone: 'bad', text: 'Build failed' };
    case 'install':
      return ok ? undefined : { tone: 'bad', text: 'Install failed' };
    case 'pr': {
      const number = /\/pull\/(\d+)/.exec(output)?.[1];
      return ok ? { tone: 'ok', text: number ? `Pull request #${number} opened` : 'Pull request opened' } : { tone: 'bad', text: 'Opening the pull request failed' };
    }
    case 'merge':
      return ok ? { tone: 'ok', text: 'Pull request merged' } : { tone: 'bad', text: 'Merge failed' };
    case 'push':
      return ok ? { tone: 'info', text: 'Branch pushed' } : { tone: 'bad', text: 'Push failed' };
    case 'commit':
      return ok ? { tone: 'info', text: 'Committed' } : undefined;
    default:
      return undefined;
  }
}

/** A member's answer: a review's verdict when it gives one. */
function answerMoment(member: string, output: string): Omit<TeamMoment, 'at'> {
  if (/VERDICT:\s*\**\s*APPROVE/i.test(output)) return { member, tone: 'ok', text: `${member}: approve` };
  if (/VERDICT:\s*\**\s*(REQUEST[_ ]CHANGES|CHANGES|REJECT)/i.test(output)) return { member, tone: 'bad', text: `${member} asks for changes` };
  return { member, tone: 'info', text: `${member} reported back` };
}

const norm = (s: string) => s.trim().toLowerCase();
const msBetween = (start?: string, end?: string) => {
  const ms = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/**
 * Folds the lead's stream into who works on what. `titles` are the members in chart order, the lead first. One per team
 * run: `fold(event)` returns the report to send, or undefined when the event changes nothing worth showing;
 * `fold.activity()` is what the run did, for the node's output.
 */
export function teamProgressFolder(titles: string[], now: () => number = Date.now) {
  const lead = titles[0] ?? 'Lead';
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const members = new Map<string, TeamProgressMember>(titles.map((title) => [norm(title), { title, state: 'idle' as MemberState, asked: 0 }]));
  const calls = new Map<string, string>();
  const stepsOf = new Map<string, TeamStep[]>();
  const counts = new Map<string, number>();
  const totals = new Map<string, Set<string>>();
  /** Step id → the status its moment was made for, so a step makes one moment however often it is reported. */
  const seen = new Map<string, RemoteToolStep['status']>();
  const turns: TeamTurn[] = [];
  const moments: TeamMoment[] = [];
  let current = lead;
  let command: string | undefined;
  let plain: string | undefined;

  const set = (title: string, patch: Partial<TeamProgressMember>) => {
    const member = members.get(norm(title));
    if (member) Object.assign(member, patch, patch.state && patch.state !== 'working' && { doing: undefined });
  };
  const turnTo = (title: string) => {
    const last = turns.at(-1);
    if (last && norm(last.member) === norm(title) && last.end === undefined) return;
    if (last && last.end === undefined) last.end = elapsed();
    turns.push({ member: title, start: elapsed() });
  };
  const moment = (m: Omit<TeamMoment, 'at'>) => {
    moments.push({ at: elapsed(), ...m });
  };
  /** The lead's own ticker: whom it asked, its own tools. */
  const leadStep = (id: string, step: TeamStep) => {
    const list = stepsOf.get(norm(lead)) ?? [];
    const at = list.findIndex((s) => (s as TeamStep & { id?: string }).id === id);
    const entry = { ...step, id } as TeamStep & { id: string };
    if (at >= 0) list[at] = entry;
    else list.push(entry);
    stepsOf.set(norm(lead), list.slice(-STEPS));
  };
  const leadWorks = (doing: string, words: string) => {
    current = lead;
    turnTo(lead);
    command = undefined;
    plain = words;
    set(lead, { state: 'working', doing });
  };
  const report = (): TeamProgress => {
    const nowMember = members.get(norm(current));
    return {
      member: current,
      agent: current,
      state: 'working',
      ...(nowMember?.doing && { doing: nowMember.doing }),
      ...(plain && { plain }),
      ...(command && { command }),
      stepCount: counts.get(norm(current)) ?? 0,
      steps: (stepsOf.get(norm(current)) ?? []).map(({ name, status, args, plain: words, ms }) => ({ name, status, plain: words, ...(args && { args }), ...(ms !== undefined && { ms }) })),
      team: { lead, members: [...members.values()].map((m) => ({ ...m })) },
      turns: turns.map((t) => ({ ...t })),
      moments: moments.slice(-MOMENTS).map((m) => ({ ...m })),
      at: elapsed(),
    };
  };

  const fold = function fold(event: AgentStreamEvent): TeamProgress | undefined {
    if (event.type === 'run.started') {
      leadWorks('thinking', 'Planning the work');
      return report();
    }
    if (event.type === 'run.finished') {
      for (const member of members.values()) if (member.state === 'working') Object.assign(member, { state: 'done', doing: undefined });
      const last = turns.at(-1);
      if (last && last.end === undefined) last.end = elapsed();
      current = lead;
      command = undefined;
      plain = 'Done';
      return report();
    }
    const entry = event.entry;
    if (entry.type === 'assistant') {
      // Between hand-offs the lead writes; its words don't change who works while a member is still at it.
      if (norm(current) !== norm(lead)) return undefined;
      leadWorks('writing', 'Writing');
      return report();
    }
    if (entry.type !== 'tool') return undefined;
    const member = members.get(norm(entry.label));
    // A tool of the lead's own (a branch check): the lead is busy with it.
    if (!member || norm(member.title) === norm(lead)) {
      const words = narrate(entry.tool === entry.label ? entry.tool : entry.label, entry.input).plain;
      leadStep(entry.callId, { name: entry.label, status: entry.status === 'denied' ? 'error' : entry.status, plain: words, ...(entry.durationMs !== undefined && { ms: entry.durationMs }) });
      if (entry.status === 'running') {
        leadWorks(entry.label, words);
        command = shortArg(entry.input, 200);
      } else leadWorks('thinking', 'Thinking it over');
      return report();
    }
    if (!calls.has(entry.callId)) {
      calls.set(entry.callId, member.title);
      member.asked++;
      counts.set(norm(member.title), 0);
      moment({ member: lead, tone: 'info', text: `Asked the ${member.title}` });
    }
    const steps = entry.remote?.steps ?? [];
    const total = totals.get(norm(member.title)) ?? new Set<string>();
    for (const step of steps) total.add(`${entry.callId}:${step.id}`);
    totals.set(norm(member.title), total);
    counts.set(norm(member.title), steps.length);
    stepsOf.set(
      norm(member.title),
      steps.slice(-STEPS).map((s) => {
        const args = shortArg(argsOf(s.args), 200);
        const ms = msBetween(s.startedAt, s.endedAt);
        return { name: s.name, status: s.status, plain: narrate(s.name, s.args).plain, ...(args && { args }), ...(ms !== undefined && s.status !== 'running' && { ms }) };
      }),
    );
    for (const step of steps) {
      const key = `${entry.callId}:${step.id}`;
      if ((step.status !== 'success' && step.status !== 'error') || seen.get(key) === step.status) continue;
      seen.set(key, step.status);
      const made = stepMoment(narrate(step.name, step.args).kind, step.status === 'success', `${textOf(step.output)} ${step.error ?? ''}`);
      if (made) moment({ member: member.title, ...made });
    }
    if (entry.status === 'running' || entry.status === 'awaiting_approval') {
      const step = [...steps].reverse().find((s) => s.status === 'running' || s.status === 'awaiting_approval') ?? steps.at(-1);
      const reason = typeof entry.input?.reason === 'string' ? entry.input.reason : undefined;
      current = member.title;
      turnTo(member.title);
      command = step ? shortArg(argsOf(step.args), 200) : undefined;
      plain = step ? narrate(step.name, step.args).plain : reason ? `Starting: ${reason.length > 60 ? `${reason.slice(0, 59)}…` : reason}` : 'Starting';
      set(member.title, { state: 'working', doing: step ? stepLine(step) : reason ? `asked: ${reason}` : 'working' });
      set(lead, { state: 'working', doing: `waiting on ${member.title}` });
      leadStep(entry.callId, { name: entry.label, status: 'running', plain: `Asking the ${member.title}` });
    } else {
      const ok = entry.status === 'success';
      set(member.title, { state: ok ? 'done' : 'failed' });
      leadStep(entry.callId, { name: entry.label, status: ok ? 'success' : 'error', plain: `Asked the ${member.title} · ${total.size} ${total.size === 1 ? 'step' : 'steps'}`, ...(entry.durationMs !== undefined && { ms: entry.durationMs }) });
      moment(ok ? answerMoment(member.title, textOf(entry.output)) : { member: member.title, tone: 'bad', text: `${member.title} failed` });
      if (norm(current) === norm(member.title)) leadWorks(`reading ${member.title}'s answer`, `Reading the ${member.title}'s answer`);
    }
    return report();
  };
  /** What the run did: every turn (closed), the moments and each member's step count. */
  fold.activity = (): TeamActivity => ({
    durationMs: elapsed(),
    turns: turns.map((t) => ({ ...t, end: t.end ?? elapsed() })),
    moments: moments.slice(-50).map((m) => ({ ...m })),
    steps: Object.fromEntries([...members.values()].flatMap((m) => (totals.get(norm(m.title))?.size ? [[m.title, totals.get(norm(m.title))!.size]] : []))),
  });
  return fold;
}

/** A finished Run a Team node's activity, from its output's first item (undefined for older runs). */
export function activityOf(json: unknown): TeamActivity | undefined {
  const activity = (json as { activity?: TeamActivity } | undefined)?.activity;
  return activity && Array.isArray(activity.turns) && Array.isArray(activity.moments) ? activity : undefined;
}

/** The activity of a node's last run: its last item's, on Done or Needs a person. */
export function activityOfRuns(runs: ReadonlyArray<{ outputs?: ReadonlyArray<ReadonlyArray<{ json?: unknown }> | null | undefined> }> | undefined): TeamActivity | undefined {
  const items = (runs?.at(-1)?.outputs ?? []).flatMap((items) => items ?? []);
  for (const item of [...items].reverse()) {
    const activity = activityOf(item.json);
    if (activity) return activity;
  }
  return undefined;
}
