/**
 * The "Where this work fits" block (docs/agents.md#project-context): one pure builder for every runtime. Same input, same
 * text; every value is redacted, flattened to one line and capped, so a brief can't smuggle a heading or a secret into a
 * prompt. The format, the drop order and the empty rule are in the Paperclip plan (P-C4).
 */
import {
  CONTEXT_FOOTER,
  CONTEXT_HEADING,
  CONTEXT_LIMITS,
  type ContextGoalData,
  type ContextProjectData,
} from '../../shared/project-context';
import { redactPatterns, redactText } from '../secrets/redact';

export interface ContextRunLine {
  /** e.g. `workflow “Nightly export” → step “Check invoices”` */
  text: string;
}

export interface ProjectContextInput {
  mission?: string;
  project?: ContextProjectData;
  /** Root first. */
  chain: ContextGoalData[];
  run: ContextRunLine;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Cut to `cap` characters, ending in an ellipsis when something was cut. */
function cut(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

/** One value as the block may carry it: redacted, one line, no heading or quote markers, capped. */
export function clean(value: string | undefined, cap: number): string {
  if (!value) return '';
  let text = redactPatterns(redactText(String(value)));
  text = text.replace(CONTROL, '').replace(/\r\n|[\r\n\u2028\u2029\t]/g, ' ');
  text = text.replace(/`{3,}/g, "'''");
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[#>\-\s]+/, '');
  return cut(text, cap);
}

/** The text with one closing full stop (none doubled). */
export function sentence(text: string): string {
  const t = text.trimEnd();
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

const unstop = (text: string) => text.replace(/[.!?]+$/, '');

/** Drop or cut lines until the text fits: each step returns false when it has nothing left to do. */
export function fit(render: () => string, cap: number, steps: Array<() => boolean>): string {
  let out = render();
  for (const step of steps) {
    if (out.length <= cap) return out;
    while (out.length > cap && step()) out = render();
  }
  return out;
}

interface Parts {
  mission: string;
  project: string;
  chain: Array<{ level: string; title: string; owner: string; date: string }>;
  why: string;
  brief: string;
  constraints: string;
  doneWhen: string;
  glossary: string;
  status: string;
  run: string;
}

function parts(input: ProjectContextInput, size: 'full' | 'compact'): Parts {
  const p = input.project;
  const chain = input.chain.slice(-CONTEXT_LIMITS.chain);
  const last = input.chain.at(-1);
  return {
    mission: clean(input.mission, CONTEXT_LIMITS.field),
    project: clean(p?.name, CONTEXT_LIMITS.goalTitle),
    chain: chain.map((g) => ({
      level: g.level,
      title: unstop(clean(g.title, CONTEXT_LIMITS.goalTitle)),
      owner: clean(g.ownerName, 80),
      date: clean(g.targetDate, 10),
    })),
    why: size === 'full' ? clean(last?.why, CONTEXT_LIMITS.why) : '',
    brief: clean(p?.brief, size === 'full' ? CONTEXT_LIMITS.brief : CONTEXT_LIMITS.compactBrief),
    constraints: size === 'full' ? clean(p?.constraints, CONTEXT_LIMITS.field) : '',
    doneWhen: size === 'full' ? clean(p?.doneWhen, CONTEXT_LIMITS.field) : '',
    glossary: size === 'full' ? clean(p?.glossary, CONTEXT_LIMITS.field) : '',
    status: size === 'full' ? statusLine(p) : '',
    run: clean(input.run.text, CONTEXT_LIMITS.runLine),
  };
}

function statusLine(p: ContextProjectData | undefined): string {
  if (!p) return '';
  const status = clean(p.status, 40);
  if (!status) return '';
  const date = clean(p.targetDate, 10);
  const lead = clean(p.leadName, 80);
  return `${status[0]!.toUpperCase()}${status.slice(1)}${date ? `, target ${date}` : ''}${lead ? `, lead ${lead}` : ''}`;
}

function goalLine(g: Parts['chain'][number], i: number): string {
  const indent = i === 0 ? '' : `${' '.repeat(2 * (i - 1))}└ `;
  return `${indent}Goal (${g.level}): ${g.title}${g.owner ? ` — owner ${g.owner}` : ''}${g.date ? `, by ${g.date}` : ''}.`;
}

function renderFull(x: Parts): string {
  const lines = [`${CONTEXT_HEADING}${x.project ? ` (from project “${x.project}”)` : ''}`];
  if (x.mission) lines.push(`Company mission: ${sentence(x.mission)}`);
  x.chain.forEach((g, i) => lines.push(goalLine(g, i)));
  if (x.why && x.chain.length) lines.push(`Why: ${sentence(x.why)}`);
  const brief = [
    x.brief && sentence(x.brief),
    x.constraints && `Constraints: ${sentence(x.constraints)}`,
    x.doneWhen && `Done when: ${sentence(x.doneWhen)}`,
  ].filter(Boolean);
  if (brief.length) lines.push(`Project brief: ${brief.join(' ')}`);
  if (x.glossary) lines.push(`Words we use: ${sentence(x.glossary)}`);
  if (x.status) lines.push(`Project status: ${sentence(x.status)}`);
  lines.push(`This run: ${sentence(x.run)}`);
  lines.push(CONTEXT_FOOTER);
  return lines.join('\n');
}

function renderCompact(x: Parts): string {
  const lines = [`${CONTEXT_HEADING}${x.project ? ` (from project “${x.project}”)` : ''}`];
  if (!x.chain.length && x.mission) lines.push(`Company mission: ${sentence(x.mission)}`);
  if (x.chain.length) lines.push(`Goal: ${x.chain.map((g) => g.title).join(' → ')}`);
  if (x.brief) lines.push(`Project brief: ${x.brief}`);
  lines.push(`This run: ${sentence(x.run)}`);
  lines.push(CONTEXT_FOOTER);
  return lines.join('\n');
}

/** Nothing to say: no mission, no goal, no brief, constraints or done-when. */
function empty(input: ProjectContextInput): boolean {
  const p = input.project;
  return !input.mission?.trim() && !input.chain.length && !p?.brief?.trim() && !p?.constraints?.trim() && !p?.doneWhen?.trim();
}

const chopTitles = (x: Parts, to: number) => {
  let changed = false;
  for (const g of x.chain) {
    if (g.title.length > to) {
      g.title = cut(g.title, to);
      changed = true;
    }
  }
  return changed;
};

/** The block for one run: `''` when there is nothing to say; at most 2,400 characters (full) or 600 (compact). */
export function projectContext(input: ProjectContextInput, size: 'full' | 'compact'): string {
  if (empty(input)) return '';
  const x = parts(input, size);
  if (size === 'compact') {
    return fit(() => renderCompact(x), CONTEXT_LIMITS.compact, [
      () => {
        if (x.brief.length <= 40) return false;
        x.brief = cut(x.brief, Math.max(40, x.brief.length - 40));
        return true;
      },
      () => (x.chain.length > 2 ? (x.chain.shift(), true) : false),
      () => chopTitles(x, 60),
      () => chopTitles(x, 30),
      () => (x.brief ? ((x.brief = ''), true) : false),
      () => (x.mission ? ((x.mission = ''), true) : false),
      () => (x.project.length > 40 ? ((x.project = cut(x.project, 40)), true) : false),
    ]);
  }
  const clear = (key: 'glossary' | 'status' | 'why' | 'constraints' | 'doneWhen') => () => (x[key] ? ((x[key] = ''), true) : false);
  return fit(() => renderFull(x), CONTEXT_LIMITS.full, [
    clear('glossary'),
    clear('status'),
    clear('why'),
    clear('constraints'),
    clear('doneWhen'),
    () => {
      if (x.brief.length <= 80) return false;
      x.brief = cut(x.brief, Math.max(80, x.brief.length - 80));
      return true;
    },
    () => (x.chain.length > 2 ? (x.chain.shift(), true) : false),
    () => chopTitles(x, 80),
    () => chopTitles(x, 40),
    () => (x.brief ? ((x.brief = ''), true) : false),
    () => (x.mission.length > 120 ? ((x.mission = cut(x.mission, 120)), true) : false),
  ]);
}

/** One line for a team's requests: `Project “P” · goal: G`, `Project “P”`, `Goal: G`, or `''`. */
export function contextLine(input: ProjectContextInput): string {
  const project = clean(input.project?.name, CONTEXT_LIMITS.goalTitle);
  const goal = unstop(clean(input.chain.at(-1)?.title, CONTEXT_LIMITS.goalTitle));
  if (project && goal) return `Project “${project}” · goal: ${goal}`;
  if (project) return `Project “${project}”`;
  return goal ? `Goal: ${goal}` : '';
}
