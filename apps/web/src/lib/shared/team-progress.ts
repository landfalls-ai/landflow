/**
 * What a Run a Team node reports while it runs (`node.progress`, docs/agent-teams.md#watching-a-team-work): who in the
 * team works now and on what, folded from the lead's timeline as it streams. The canvases turn the node into the member
 * at work (its face, title and what it does in plain words, with its last steps), mark each turn on a ribbon and show the
 * moments that matter beside it (a failing test, a review's verdict), so a run can be watched without opening it. What
 * the run did stays on the node's output as its `activity`. Each member's tokens so far go with it, against its budget, and
 * a member's question for a person turns the node amber with the question and an Answer button.
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

/**
 * A result worth a glance (tests pass, a review asks for changes), when it happened and whose it was. `warn`: a member
 * near its budget, or asking a person (with the `question`).
 */
export interface TeamMoment {
  at: number;
  member: string;
  tone: 'ok' | 'bad' | 'warn' | 'info';
  text: string;
  /** A member's question for a person, in full: the run waits for the answer. For a tool waiting for approval: its input as short text. */
  question?: string;
  /** A note a member wrote in the team notebook (docs/team-notebook.md): worth a headline. */
  note?: true;
}

/** A tool call a member waits to use until a person approves it, as the node tells it. */
export interface TeamApprovalWait {
  /** The tool's name as a person reads it ("Comment on pull request"); several joined by commas. */
  tool: string;
  /** Its input as a few words: the comment, the command, the path. */
  summary?: string;
  /** What it acts on, from its input: "#5" for a pull request or issue, a path, a branch. */
  target?: string;
  /** A command the member's guard asks about (a push to main), not a tool: "wants to run". */
  run?: boolean;
}

/** Who consults whom while a peer works for another member (or has taken its task over). */
export interface TeamConsulting {
  from: string;
  to: string;
  kind: 'consult' | 'handoff';
}

/** What a member used so far, in tokens, against its budget when it has one. */
export interface TeamUsage {
  member: string;
  tokens: number;
  budget?: number;
  /** A remote member that reports no usage: estimated from what it read and wrote. */
  estimated?: boolean;
}

/** What a team run did, kept on the node's output (`activity`): its turns, its moments and each member's step count. */
export interface TeamActivity {
  durationMs: number;
  turns: TeamTurn[];
  moments: TeamMoment[];
  steps: Record<string, number>;
  /** Each member's tokens, against its budget (members that used none and have no budget left out). */
  usage?: TeamUsage[];
  /**
   * How long each part ran when the run waited for a person in between (ms, in order): `turns` and `moments` count from
   * the first part's start with the waits left out, and a part is a run of the node of its own (`node:<id>:<n>`).
   */
  parts?: number[];
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
  /** Each member's tokens so far, against its budget. */
  usage?: TeamUsage[];
  /** A member asked a person, or wants a tool that needs approval (`approval`): the run waits for the answer. */
  waiting?: { member: string; question: string; approval?: TeamApprovalWait };
  /** The member working was consulted by another (or took its task over): both show at work. */
  consulting?: TeamConsulting;
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

/** What a tool call acts on, from its input: "#5" (a pull request or issue number), else a path or a branch. */
export function targetOf(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['pull_number', 'pullNumber', 'pr', 'issue_number', 'issueNumber', 'number']) {
    const n = args[key];
    if ((typeof n === 'number' && Number.isInteger(n)) || (typeof n === 'string' && /^\d+$/.test(n))) return `#${n}`;
  }
  for (const key of ['path', 'file', 'filePath', 'branch', 'ref']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim().length > 48 ? `…${v.trim().slice(-47)}` : v.trim();
  }
  return undefined;
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

/** Installing a dependency: pnpm, npm, yarn or bun install/add/ci, Go modules, pip, poetry, apk. */
const INSTALL = /\b(pnpm|npm|yarn|bun)\b.*\b(i|install|ci|add)\b|\bpip3?\s+install\b|\bgo\s+mod\s+(download|tidy)\b|\bpoetry\s+install\b|\bapk\s+add\b/;
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
  [INSTALL, 'Installing dependencies', 'install'],
  [/\b(pnpm|npm|yarn|bun)\b.*\bbuild\b|\bgo\s+build\b|\bcargo\s+build\b|\bmake\b/, 'Building', 'build'],
];

/** The names of the EgressPolicies that open only Landflow's package cache (deploy/k8s/components/package-cache). */
export const PACKAGE_POLICY = /package|registry|npm|pypi/i;

/** What narrate() can know besides a step's name and arguments. */
export interface NarrateContext {
  /** The step's result, once it has one (a search says how many notes it found). */
  output?: unknown;
  /** The member's sandbox works through Landflow's package cache: its installs read "from the cache". */
  cache?: boolean;
}

/** The cache's address in a step's own output (`landflow-cache.landflow.svc…`): a registry URL npm, pip or Go printed. */
const CACHE_ADDRESS = /landflow-cache/i;

function narrateCommand(command: string, cx: NarrateContext = {}): { plain: string; kind?: StepKind } {
  const parts = command.split(/&&|\|\||;|\n/).map((p) => p.trim()).filter(Boolean);
  const dir = parts.map((p) => /^cd\s+(\S+)/.exec(p)?.[1]).filter(Boolean).at(-1);
  const meaningful = parts.filter((p) => !/^(cd|export|set|source|\.)\s/.test(p));
  // A pipeline is for what its first stage does: `find . -name x | head` looks around, `head` only trims it.
  const last = (meaningful.at(-1) ?? parts.at(-1) ?? command).split('|')[0].trim();
  for (const [pattern, plain, kind] of COMMANDS) {
    if (!pattern.test(last)) continue;
    const cached = pattern === INSTALL && (cx.cache || CACHE_ADDRESS.test(textOf(cx.output)));
    return { plain: cached ? `${plain} · from the cache` : plain, kind };
  }
  const [word, ...rest] = last.split(/\s+/);
  const args = rest.filter((a) => !a.startsWith('-'));
  const target = args.at(-1);
  if (/^(cat|head|tail|less|wc)$/.test(word) && target) return { plain: `Reading ${baseName(target)}` };
  if (/^(ls|tree|find|pwd|du)$/.test(word)) {
    // find takes its path first; "." is the directory the chain went to.
    const path = word === 'find' ? args[0] : target;
    const where = path && path !== '.' ? path : dir;
    return { plain: where ? `Looking around ${baseName(where)}` : 'Looking around the files' };
  }
  if (/^(grep|rg|ag)$/.test(word)) return { plain: 'Searching the code' };
  if (/^(curl|wget|http)$/.test(word)) return { plain: 'Calling a URL' };
  if (/^(mkdir|cp|mv|rm|touch|chmod)$/.test(word)) return { plain: 'Arranging files' };
  return { plain: word ? `Running ${baseName(word)}` : 'Running a command' };
}

const NOTE_TOOL = /^(?:mcp__[^_]+__)?(note_add|note_search|note_update|note_dispute|note_promote)$/i;
const clip = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A notebook tool in plain words ("Searching the notebook · 3 found", "Noting a decision"). */
function narrateNote(tool: string, a: Record<string, unknown>, output?: unknown): string {
  switch (tool.toLowerCase()) {
    case 'note_search': {
      const found = foundNotes(output);
      return found === undefined ? 'Searching the notebook' : `Searching the notebook · ${found} found`;
    }
    case 'note_add':
      return a.kind === 'decision' ? 'Noting a decision' : a.kind === 'open_question' ? 'Noting an open question' : a.kind === 'artifact_ref' ? 'Noting an artifact' : a.kind === 'task_status' ? 'Noting where the work stands' : 'Noting a fact';
    case 'note_update':
      return a.answer ? 'Answering a question' : 'Updating a note';
    case 'note_dispute':
      return 'Disputing a note';
    default:
      return a.to === 'project' ? 'Suggesting a note for the project' : 'Promoting a note to the team';
  }
}

/** The words of a tool result: a string, `{ text }`, or MCP's `{ content: [{ text }] }`. */
function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainText).join('\n');
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return plainText(o.content);
  }
  return '';
}

/** How many notes a note_search returned, from its result ("3 notes (matched by meaning): ...", "Nothing in the notebook matches ..."); undefined while there is no result. */
function foundNotes(output: unknown): number | undefined {
  const text = plainText(output).trim();
  if (!text) return undefined;
  const n = /^(\d+) notes?\b/.exec(text)?.[1];
  if (n) return Number(n);
  return /^Nothing in the notebook/i.test(text) ? 0 : undefined;
}

/** The moment a notebook write makes ("Reviewer noted: plugins need an icons/ folder"), when the tool wrote something. */
export function noteMoment(member: string, name: string, args: unknown): Omit<TeamMoment, 'at'> | undefined {
  const tool = NOTE_TOOL.exec(name)?.[1]?.toLowerCase();
  const a = argsOf(args) ?? {};
  const text = typeof a.text === 'string' ? clip(a.text.replace(/\s+/g, ' ').trim()) : '';
  const answer = typeof a.answer === 'string' ? clip(a.answer.replace(/\s+/g, ' ').trim()) : '';
  if (tool === 'note_add' && text) {
    const verb = a.kind === 'decision' ? 'decided' : a.kind === 'open_question' ? 'asked' : a.kind === 'artifact_ref' ? 'noted an artifact' : 'noted';
    return { member, tone: a.kind === 'decision' ? 'ok' : 'info', text: `${member} ${verb}: ${text}`, note: true };
  }
  if (tool === 'note_update' && answer) return { member, tone: 'ok', text: `${member} answered: ${answer}`, note: true };
  if (tool === 'note_dispute') return { member, tone: 'warn', text: `${member} disputed a note${text ? `: ${text}` : ''}`, note: true };
  if (tool === 'note_promote') return { member, tone: 'ok', text: a.to === 'project' ? `${member} suggested a note for the project` : `${member} promoted a note to the team`, note: true };
  return undefined;
}

/**
 * A step in plain words ("Running the tests", "Reading PLAN.md"), and what it is for when its result matters. A step
 * with no rule keeps its tool's name as a sentence.
 */
export function narrate(name: string, args?: unknown, cx: NarrateContext = {}): { plain: string; kind?: StepKind } {
  const a = argsOf(args) ?? {};
  const text = (key: string) => (typeof a[key] === 'string' ? (a[key] as string) : undefined);
  const path = text('file_path') ?? text('filePath') ?? text('path') ?? text('notebook_path');
  const tool = name.replace(/^mcp__[^_]+__/, '').toLowerCase();
  if (NOTE_TOOL.test(name)) return { plain: narrateNote(tool, a, cx.output) };
  const command = text('command') ?? text('cmd') ?? (/^(bash|shell|exec|run|terminal)/.test(tool) ? text('value') : undefined);
  if (command && /^(bash|shell|exec|run_command|run|terminal|execute_command)/.test(tool)) return narrateCommand(command, cx);
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
  if (command) return narrateCommand(command, cx);
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
/** A review's verdict, from its `VERDICT:` line: approve, or changes (request changes, reject). */
export function verdictOf(output: string): 'approve' | 'changes' | undefined {
  if (/VERDICT:\s*\**\s*APPROVE/i.test(output)) return 'approve';
  if (/VERDICT:\s*\**\s*(REQUEST[_ ]CHANGES|CHANGES|REJECT)/i.test(output)) return 'changes';
  return undefined;
}

function answerMoment(member: string, output: string): Omit<TeamMoment, 'at'> {
  const verdict = verdictOf(output);
  if (verdict === 'approve') return { member, tone: 'ok', text: `${member}: approve` };
  if (verdict === 'changes') return { member, tone: 'bad', text: `${member} asks for changes` };
  return { member, tone: 'info', text: `${member} reported back` };
}

const norm = (s: string) => s.trim().toLowerCase();
const msBetween = (start?: string, end?: string) => {
  const ms = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

export interface TeamFolderOptions {
  /** Each member's token budget for the run, by title. */
  budgets?: Record<string, number>;
  /** What members used before (a run going on after a person answered), so the bars and their moments carry on. */
  usage?: TeamUsage[];
  /** Titles of the members whose sandboxes work through Landflow's package cache: their installs read "from the cache". */
  packageCache?: string[];
}

/**
 * Folds the lead's stream into who works on what. `titles` are the members in chart order, the lead first. One per team
 * run: `fold(event)` returns the report to send, or undefined when the event changes nothing worth showing;
 * `fold(event, title)` folds the stream of a member that manages others (its own loop: whom it asks, its own tools);
 * `fold.usage(title, tokens)` takes a member's tokens so far (a moment at 80% and at 100% of its budget);
 * `fold.waiting(member, question, approval?)` marks the question (or the tool waiting for approval) the run now waits on; `fold.activity()` is what the run did, for
 * the node's output.
 */
export function teamProgressFolder(titles: string[], now: () => number = Date.now, options: TeamFolderOptions = {}) {
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
  let waiting: { member: string; question: string; approval?: TeamApprovalWait } | undefined;
  /** Peers at work for another member, by the peer's name: who asked, how, which call, and why. */
  const consulting = new Map<string, TeamConsulting & { callId: string; reason?: string }>();
  const budgets = new Map(Object.entries(options.budgets ?? {}).filter(([, b]) => b > 0).map(([title, b]) => [norm(title), b]));
  const tokens = new Map<string, { tokens: number; estimated?: boolean }>((options.usage ?? []).map((u) => [norm(u.member), { tokens: u.tokens, ...(u.estimated && { estimated: true }) }]));
  /** The budget moment each member had: one at 80%, one at 100%. */
  const flagged = new Map<string, 'warn' | 'bad'>();
  const cached = new Set((options.packageCache ?? []).map(norm));
  const narrated = (title: string, name: string, args: unknown, output?: unknown) => narrate(name, args, { cache: cached.has(norm(title)), ...(output !== undefined && { output }) });
  const levelOf = (key: string): 'warn' | 'bad' | undefined => {
    const budget = budgets.get(key);
    const used = tokens.get(key)?.tokens ?? 0;
    return !budget ? undefined : used >= budget ? 'bad' : used >= budget * 0.8 ? 'warn' : undefined;
  };
  for (const key of tokens.keys()) {
    const level = levelOf(key);
    if (level) flagged.set(key, level);
  }
  const usageList = (): TeamUsage[] | undefined => {
    const list = [...members.values()].flatMap((m) => {
      const key = norm(m.title);
      const used = tokens.get(key);
      const budget = budgets.get(key);
      if (!used?.tokens && !budget) return [];
      return [{ member: m.title, tokens: used?.tokens ?? 0, ...(budget && { budget }), ...(used?.estimated && { estimated: true }) }];
    });
    return list.length ? list : undefined;
  };
  /** Who asked whom, for the members a manager below the lead asked: its manager's stream doesn't take the work back. */
  const askedBy = new Map<string, string>();
  const works = (title: string) => {
    for (let at: string | undefined = norm(current); at; at = askedBy.get(at)) if (at === norm(title)) return true;
    return false;
  };

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
  /** A manager's own ticker (the lead's, or a member's that asks others): whom it asked, its own tools. */
  const ownStep = (owner: string, id: string, step: TeamStep) => {
    const list = stepsOf.get(norm(owner)) ?? [];
    const at = list.findIndex((s) => (s as TeamStep & { id?: string }).id === id);
    const entry = { ...step, id } as TeamStep & { id: string };
    if (at >= 0) list[at] = entry;
    else list.push(entry);
    stepsOf.set(norm(owner), list.slice(-STEPS));
  };
  const ownerWorks = (owner: string, doing: string, words: string) => {
    current = members.get(norm(owner))?.title ?? owner;
    turnTo(current);
    command = undefined;
    plain = words;
    set(owner, { state: 'working', doing });
  };
  const report = (): TeamProgress => {
    const nowMember = members.get(norm(current));
    const usage = usageList();
    const peer = consulting.get(norm(current));
    // A peer at work shows the request that brought it (the asker's row, spinning) above its own steps.
    const request = peer && (stepsOf.get(norm(peer.from)) ?? []).find((s) => (s as TeamStep & { id?: string }).id === peer.callId);
    const shown = request ? [request, ...(stepsOf.get(norm(current)) ?? []).slice(-2)] : (stepsOf.get(norm(current)) ?? []);
    return {
      member: current,
      agent: current,
      state: 'working',
      ...(nowMember?.doing && { doing: nowMember.doing }),
      ...(plain && { plain }),
      ...(command && { command }),
      stepCount: counts.get(norm(current)) ?? 0,
      steps: shown.map(({ name, status, args, plain: words, ms }) => ({ name, status, plain: words, ...(args && { args }), ...(ms !== undefined && { ms }) })),
      team: { lead, members: [...members.values()].map((m) => ({ ...m })) },
      turns: turns.map((t) => ({ ...t })),
      moments: moments.slice(-MOMENTS).map((m) => ({ ...m })),
      ...(usage && { usage }),
      ...(waiting && { waiting: { ...waiting } }),
      ...(peer && { consulting: { from: peer.from, to: members.get(norm(current))?.title ?? current, kind: peer.kind } }),
      at: elapsed(),
    };
  };

  const fold = function fold(event: AgentStreamEvent, by: string = lead): TeamProgress | undefined {
    const owner = members.get(norm(by))?.title ?? by;
    // A member's own loop starts and ends inside its manager's call to it: that call says when it works and when it is done.
    if (owner !== lead && (event.type === 'run.started' || event.type === 'run.finished')) return undefined;
    if (event.type === 'run.started') {
      ownerWorks(lead, 'thinking', 'Planning the work');
      return report();
    }
    if (event.type === 'run.finished') {
      for (const member of members.values()) if (member.state === 'working') Object.assign(member, { state: 'done', doing: undefined });
      const last = turns.at(-1);
      if (last && last.end === undefined) last.end = elapsed();
      current = lead;
      command = undefined;
      // A member's question for a person: the run waits for the answer rather than being done.
      plain = event.reason === 'awaiting_approval' ? 'Waiting for a person’s answer' : 'Done';
      return report();
    }
    const entry = event.entry;
    if (entry.type === 'assistant') {
      // Between hand-offs a manager writes; its words don't change who works while a member it asked is still at it.
      if (norm(current) !== norm(owner)) return undefined;
      ownerWorks(owner, 'writing', 'Writing');
      return report();
    }
    if (entry.type !== 'tool') return undefined;
    const member = members.get(norm(entry.label));
    // A tool of the manager's own (a branch check, a member's Bash): it is busy with it.
    if (!member || norm(member.title) === norm(owner)) {
      if (owner !== lead && !works(owner)) return undefined;
      if (owner !== lead) {
        // A member's own steps count as its work, like a remote member's.
        const total = totals.get(norm(owner)) ?? new Set<string>();
        if (!total.has(entry.callId)) counts.set(norm(owner), (counts.get(norm(owner)) ?? 0) + 1);
        totals.set(norm(owner), total.add(entry.callId));
      }
      const words = narrated(owner, entry.tool === entry.label ? entry.tool : entry.label, entry.input, entry.output).plain;
      ownStep(owner, entry.callId, { name: entry.label, status: entry.status === 'denied' ? 'error' : entry.status, plain: words, ...(entry.durationMs !== undefined && { ms: entry.durationMs }) });
      if (entry.status === 'running') {
        ownerWorks(owner, entry.label, words);
        command = shortArg(entry.input, 200);
      } else {
        // A note written makes a moment, once however often the step is reported.
        if (entry.status === 'success' && !seen.has(`own:${entry.callId}`)) {
          seen.set(`own:${entry.callId}`, 'success');
          const made = noteMoment(owner, entry.tool, entry.input);
          if (made) moment(made);
        }
        ownerWorks(owner, 'thinking', 'Thinking it over');
      }
      return report();
    }
    if (owner !== lead) askedBy.set(norm(member.title), norm(owner));
    // A consult or a hand-off: a peer asked by a member, not by its manager (the tool's name tells: consult_<title>, hand_off_to_<title>).
    const peerKind = /^consult_/.test(entry.tool) ? 'consult' : /^hand_off_to_/.test(entry.tool) ? 'handoff' : undefined;
    const asked = typeof entry.input?.reason === 'string' ? entry.input.reason.trim() : '';
    const asking = peerKind === 'handoff' ? `Handing the task to the ${member.title}` : `Asking the ${member.title}${asked ? ` ${asked.length > 70 ? `${asked.slice(0, 69)}…` : asked}` : ''}`;
    if (!calls.has(entry.callId)) {
      calls.set(entry.callId, member.title);
      member.asked++;
      counts.set(norm(member.title), 0);
      if (peerKind) consulting.set(norm(member.title), { from: owner, to: member.title, kind: peerKind, callId: entry.callId, ...(asked && { reason: asked }) });
      moment({
        member: owner,
        tone: 'info',
        text: peerKind === 'handoff' ? `${owner} handed the task to the ${member.title}` : peerKind === 'consult' ? `${owner} consults the ${member.title}` : owner === lead ? `Asked the ${member.title}` : `${owner} asked the ${member.title}`,
      });
    }
    const steps = entry.remote?.steps ?? [];
    const total = totals.get(norm(member.title)) ?? new Set<string>();
    for (const step of steps) total.add(`${entry.callId}:${step.id}`);
    totals.set(norm(member.title), total);
    // A remote member's steps come with its manager's call; a Landflow agent's come in its own stream (its own ticker).
    if (entry.remote) {
      counts.set(norm(member.title), steps.length);
      stepsOf.set(
        norm(member.title),
        steps.slice(-STEPS).map((s) => {
          const args = shortArg(argsOf(s.args), 200);
          const ms = msBetween(s.startedAt, s.endedAt);
          return { name: s.name, status: s.status, plain: narrated(member.title, s.name, s.args, s.output).plain, ...(args && { args }), ...(ms !== undefined && s.status !== 'running' && { ms }) };
        }),
      );
    }
    for (const step of steps) {
      const key = `${entry.callId}:${step.id}`;
      if ((step.status !== 'success' && step.status !== 'error') || seen.get(key) === step.status) continue;
      seen.set(key, step.status);
      const wrote = step.status === 'success' ? noteMoment(member.title, step.name, step.args) : undefined;
      if (wrote) {
        moment(wrote);
        continue;
      }
      const made = stepMoment(narrated(member.title, step.name, step.args).kind, step.status === 'success', `${textOf(step.output)} ${step.error ?? ''}`);
      if (made) moment({ member: member.title, ...made });
    }
    if (entry.status === 'running' || entry.status === 'awaiting_approval') {
      const step = [...steps].reverse().find((s) => s.status === 'running' || s.status === 'awaiting_approval') ?? steps.at(-1);
      const reason = typeof entry.input?.reason === 'string' ? entry.input.reason : undefined;
      // Someone this member asked is at work: the member's call goes on, the live view stays with whoever works.
      if (works(member.title) && norm(current) !== norm(member.title)) return undefined;
      current = member.title;
      turnTo(member.title);
      command = step ? shortArg(argsOf(step.args), 200) : undefined;
      plain = step ? narrated(member.title, step.name, step.args, step.output).plain : peerKind ? asking : reason ? `Starting: ${reason.length > 60 ? `${reason.slice(0, 59)}…` : reason}` : 'Starting';
      set(member.title, { state: 'working', doing: step ? stepLine(step) : reason ? `asked: ${reason}` : 'working' });
      set(owner, { state: 'working', doing: peerKind === 'handoff' ? `handed over to ${member.title}` : peerKind === 'consult' ? `consulting ${member.title}` : `waiting on ${member.title}` });
      ownStep(owner, entry.callId, { name: entry.label, status: 'running', plain: peerKind ? asking : `Asking the ${member.title}` });
    } else {
      const ok = entry.status === 'success';
      consulting.delete(norm(member.title));
      set(member.title, { state: ok ? 'done' : 'failed' });
      ownStep(owner, entry.callId, { name: entry.label, status: ok ? 'success' : 'error', plain: `${peerKind === 'handoff' ? 'Handed over to' : 'Asked'} the ${member.title} · ${total.size} ${total.size === 1 ? 'step' : 'steps'}`, ...(entry.durationMs !== undefined && { ms: entry.durationMs }) });
      moment(ok ? (peerKind === 'consult' ? { member: member.title, tone: 'info', text: `${member.title} answered ${owner}` } : answerMoment(member.title, textOf(entry.output))) : { member: member.title, tone: 'bad', text: `${member.title} failed` });
      if (works(member.title)) ownerWorks(owner, `reading ${member.title}'s answer`, `Reading the ${member.title}'s answer`);
    }
    return report();
  };
  /** A member's tokens so far: the report when they changed, with a moment the first time it reaches 80% and 100% of its budget. */
  fold.usage = (title: string, used: number, estimated = false): TeamProgress | undefined => {
    const key = norm(title);
    const before = tokens.get(key);
    if (before && before.tokens === used && Boolean(before.estimated) === estimated) return undefined;
    tokens.set(key, { tokens: used, ...(estimated && { estimated: true }) });
    const level = levelOf(key);
    const had = flagged.get(key);
    if (level && had !== level && had !== 'bad') {
      flagged.set(key, level);
      const name = members.get(key)?.title ?? title;
      const about = estimated ? 'about ' : '';
      moment({ member: name, tone: level, text: level === 'bad' ? `${name} used up its budget` : `${name} used ${about}80% of its budget` });
    }
    return report();
  };
  /** The run waits for a person's answer to a member's question: a moment with the question, and the node turns to the asker. */
  fold.waiting = (member: string, question: string, approval?: TeamApprovalWait): TeamProgress => {
    const name = members.get(norm(member))?.title ?? member;
    waiting = { member: name, question, ...(approval && { approval }) };
    current = name;
    command = undefined;
    plain = approval ? 'Waiting for a person’s approval' : 'Waiting for a person’s answer';
    moment(approval ? { member: name, tone: 'warn', text: `${name} asks to use ${approval.tool}`, ...(approval.summary && { question: approval.summary }) } : { member: name, tone: 'warn', text: `${name} asks a person`, question });
    return report();
  };
  /** What the run did: every turn (closed), the moments, each member's step count and tokens. */
  fold.activity = (): TeamActivity => {
    const usage = usageList();
    return {
      durationMs: elapsed(),
      turns: turns.map((t) => ({ ...t, end: t.end ?? elapsed() })),
      moments: moments.slice(-50).map((m) => ({ ...m })),
      steps: Object.fromEntries([...members.values()].flatMap((m) => (totals.get(norm(m.title))?.size ? [[m.title, totals.get(norm(m.title))!.size]] : []))),
      ...(usage && { usage }),
    };
  };
  return fold;
}

/** What a run did before it waited for a person, then after: one activity, the second part's times after the first's. */
export function joinActivity(before: TeamActivity | undefined, after: TeamActivity): TeamActivity {
  if (!before) return after;
  const shift = before.durationMs;
  const steps = { ...before.steps };
  for (const [member, count] of Object.entries(after.steps)) steps[member] = (steps[member] ?? 0) + count;
  // The second part's usage carries on from the first's (TeamFolderOptions.usage); a member only the first part names keeps its own.
  const usage = new Map((before.usage ?? []).map((u) => [u.member, u]));
  for (const u of after.usage ?? []) usage.set(u.member, u);
  return {
    durationMs: shift + after.durationMs,
    parts: [...(before.parts ?? [shift]), ...(after.parts ?? [after.durationMs])],
    turns: [...before.turns, ...after.turns.map((t) => ({ ...t, start: t.start + shift, ...(t.end !== undefined && { end: t.end + shift }) }))],
    moments: [...before.moments, ...after.moments.map((m) => ({ ...m, at: m.at + shift }))].slice(-50),
    steps,
    ...(usage.size > 0 && { usage: [...usage.values()] }),
  };
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
