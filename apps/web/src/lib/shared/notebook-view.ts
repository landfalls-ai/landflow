/**
 * How the Notebook tab arranges and words notes (components/agents/notebook-tab.tsx): which notes form a dispute pair, the
 * groups (open questions, decisions, facts), how long a note has left and what to call that, and the link into the Run Trace.
 */
import { RUN_NOTE_DAYS, TEAM_NOTE_DAYS, type TeamNote } from './notebook';

const DAY_MS = 86_400_000;

export interface DisputePair {
  /** The note that was disputed. */
  original: TeamNote;
  /** The note that disagrees with it. */
  challenge: TeamNote;
}

export interface NoteGroups {
  pairs: DisputePair[];
  questions: TeamNote[];
  decisions: TeamNote[];
  facts: TeamNote[];
}

/** Notes in the tab's groups; two notes that dispute each other form a pair, shown side by side instead of in a group. */
export function groupNotes(notes: TeamNote[]): NoteGroups {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const pairs: DisputePair[] = [];
  const paired = new Set<string>();
  for (const note of notes) {
    const original = note.disputes ? byId.get(note.disputes) : undefined;
    if (!original || note.status === 'expired' || original.status === 'expired') continue;
    pairs.push({ original, challenge: note });
    paired.add(note.id).add(original.id);
  }
  const rest = notes.filter((n) => !paired.has(n.id));
  return {
    pairs,
    questions: rest.filter((n) => n.kind === 'open_question'),
    decisions: rest.filter((n) => n.kind === 'decision'),
    facts: rest.filter((n) => n.kind !== 'open_question' && n.kind !== 'decision'),
  };
}

export interface ExpiryView {
  /** "expires in 12 days", "kept until deleted". */
  label: string;
  /** How much of its life is left, 0..1 (1 for a note that does not expire). */
  fraction: number;
  /** `ok`: plenty left or kept; `soon`: under a third left; `gone`: expired or about to be. */
  tone: 'ok' | 'soon' | 'gone';
}

export function expiryView(note: TeamNote, now = Date.now()): ExpiryView {
  if (note.status === 'expired') return { label: 'expired', fraction: 0, tone: 'gone' };
  if (note.scope === 'project') return { label: 'kept until deleted', fraction: 1, tone: 'ok' };
  if (!note.expiresAt) return { label: note.verifiedAt ? 'verified: kept' : 'kept', fraction: 1, tone: 'ok' };
  const left = Date.parse(note.expiresAt) - now;
  const life = (note.scope === 'run' ? RUN_NOTE_DAYS : TEAM_NOTE_DAYS) * DAY_MS;
  const days = Math.ceil(left / DAY_MS);
  const fraction = Math.max(0, Math.min(1, left / life));
  const label = left <= 0 ? 'expires today' : days <= 1 ? 'expires tomorrow' : `expires in ${days} days`;
  return { label, fraction, tone: fraction <= 0.05 ? 'gone' : fraction < 1 / 3 ? 'soon' : 'ok' };
}

/** The Run Trace page a note's provenance points to: the span when its id is known, else the trace of the run. */
export function traceHref(note: Pick<TeamNote, 'source'>): string | undefined {
  const { executionId, spanId } = note.source;
  if (!executionId) return undefined;
  return `/runs/${encodeURIComponent(executionId)}?tab=trace${spanId ? `&span=${encodeURIComponent(spanId)}` : ''}`;
}

/** The host of the page a note was read from, for a link's text. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

/** What the status pill says: an answered question reads "answered", a tainted note nobody checked says so. */
export function statusLabel(note: TeamNote): string {
  if (note.tainted && !note.verifiedAt && note.status === 'unverified') return 'unchecked';
  return note.status;
}

export interface SourcePart {
  kind: 'run' | 'step' | 'url';
  /** "Run Trace" for a run, the step's name, the URL's host. */
  label: string;
  href?: string;
}

/** Where a note came from, in the order the card reads them after "by <author>": the run (a Run Trace link), the step that ran the team, the page it was read from. */
export function sourceParts(note: Pick<TeamNote, 'source'>): SourcePart[] {
  const parts: SourcePart[] = [];
  const run = traceHref(note);
  if (run) parts.push({ kind: 'run', label: 'Run trace', href: run });
  if (note.source.step) parts.push({ kind: 'step', label: note.source.step });
  const host = hostOf(note.source.url);
  if (host) parts.push({ kind: 'url', label: host, ...(note.source.url && /^https?:\/\//i.test(note.source.url) && { href: note.source.url }) });
  return parts;
}
