/** The policy gate after the AI verdict. There is no noise outcome here: the AI path cannot drop an alert. */
import { asSeverity } from './alert';
import { getPath, isObj, str, tryJson, type Obj } from './util';

export type Outcome = 'open' | 'attach' | 'ask';
export type VerdictKind = 'real' | 'duplicate' | 'unsure' | 'noise';
export const VERDICTS: VerdictKind[] = ['real', 'duplicate', 'unsure', 'noise'];

export interface Verdict {
  verdict: VerdictKind;
  confidence: number;
  reasons: string[];
  suggestedSeverity?: string;
  summary?: string;
}

export type VerdictResult = { ok: true; verdict: Verdict } | { ok: false; reason: string };

/** Pull a JSON object out of text: plain JSON, ```json fences, or JSON inside prose. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const direct = tryJson(trimmed);
  if (direct !== undefined) return direct;
  const fence = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence) {
    const inner = tryJson(fence[1].trim());
    if (inner !== undefined) return inner;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return tryJson(trimmed.slice(start, end + 1));
  return undefined;
}

function unwrap(raw: unknown, depth = 0): Obj | undefined {
  if (depth > 4) return undefined;
  let v = raw;
  if (typeof v === 'string') v = parseJsonText(v);
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (!isObj(v)) return undefined;
  if (typeof v.verdict === 'string' || 'confidence' in v) return v;
  if (isObj(v.verdict)) return unwrap(v.verdict, depth + 1);
  for (const key of ['output', 'text', 'response', 'content', 'result']) {
    if (key in v) {
      const inner = unwrap(v[key], depth + 1);
      if (inner) return inner;
    }
  }
  return v;
}

export function readVerdict(item: Obj, verdictField: string): VerdictResult {
  let raw = getPath(item, verdictField);
  if (raw === undefined || raw === null || raw === '') raw = item.output;
  if (raw === undefined || raw === null || raw === '') return { ok: false, reason: `no verdict found at "${verdictField}" or "output"` };
  const obj = unwrap(raw);
  if (!obj) return { ok: false, reason: 'the verdict is not valid JSON' };
  const kind = str(obj.verdict).trim().toLowerCase();
  if (!VERDICTS.includes(kind as VerdictKind)) return { ok: false, reason: `unknown verdict "${str(obj.verdict)}" (expected real, duplicate, unsure or noise)` };
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : typeof obj.confidence === 'string' && obj.confidence.trim() !== '' ? Number(obj.confidence) : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, reason: 'confidence is missing or not a number between 0 and 1' };
  const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(str).filter(Boolean) : typeof obj.reasons === 'string' && obj.reasons ? [obj.reasons] : [];
  const suggestedSeverity = asSeverity(obj.suggestedSeverity);
  const summary = str(obj.summary).trim();
  return { ok: true, verdict: { verdict: kind as VerdictKind, confidence, reasons, ...(suggestedSeverity && { suggestedSeverity }), ...(summary && { summary }) } };
}

export interface DecisionConfig {
  mode: 'shadow' | 'enforce';
  verdictField: string;
  minConfidence: number;
  existingRoomField: string;
  severityField: string;
}

export interface Decision {
  outcome: Outcome;
  /** What Enforce would do (always set; equals `outcome` in enforce mode). */
  enforceOutcome: Outcome;
  reasons: string[];
  failedOpen: boolean;
  verdict: Verdict | null;
  existingRoom: string | null;
}

export function decide(item: Obj, cfg: DecisionConfig): Decision {
  const severity = asSeverity(getPath(item, cfg.severityField));
  const roomRaw = getPath(item, cfg.existingRoomField);
  const existingRoom = typeof roomRaw === 'string' || typeof roomRaw === 'number' ? str(roomRaw).trim() || null : null;
  const parsed = readVerdict(item, cfg.verdictField);
  const verdict = parsed.ok ? parsed.verdict : null;
  const min = cfg.minConfidence;
  let enforceOutcome: Outcome;
  let failedOpen = false;
  const reasons: string[] = [];

  if (severity === 'sev1') {
    enforceOutcome = 'open';
    reasons.push('sev1 is never held: a room opens');
  } else if (!parsed.ok) {
    enforceOutcome = 'open';
    failedOpen = true;
    reasons.push(`fail open: ${parsed.reason}`);
  } else {
    const v = parsed.verdict;
    if (v.verdict === 'noise') {
      enforceOutcome = 'ask';
      reasons.push('the AI judged this noise, but only a rule a person approved can drop an alert: asking on-call');
    } else if (v.verdict === 'unsure') {
      enforceOutcome = 'ask';
      reasons.push('the AI is unsure: asking on-call');
    } else if (v.confidence < min) {
      enforceOutcome = 'ask';
      reasons.push(`confidence ${v.confidence} is below the minimum ${min}: asking on-call`);
    } else if (existingRoom) {
      enforceOutcome = 'attach';
      reasons.push(v.verdict === 'duplicate' ? 'the AI judged this a duplicate of an open room: attaching' : 'a real alert with an open room for the same group: attaching');
    } else {
      enforceOutcome = 'open';
      reasons.push(v.verdict === 'duplicate' ? 'the AI judged this a duplicate but no open room was found: a room opens' : 'the AI judged this a real incident: a room opens');
    }
  }
  const outcome: Outcome = cfg.mode === 'shadow' ? 'open' : enforceOutcome;
  if (cfg.mode === 'shadow' && enforceOutcome !== 'open') reasons.push(`shadow mode: Enforce would have chosen "${enforceOutcome}"; a room opens instead`);
  return { outcome, enforceOutcome, reasons, failedOpen, verdict, existingRoom };
}

/** A short paragraph for the Landfall room summary. */
export function summarize(item: Obj, d: Decision, mode: 'shadow' | 'enforce'): string {
  const title = str(getPath(item, 'alert.title')) || 'Alert';
  const sev = str(getPath(item, 'alert.severity'));
  const service = str(getPath(item, 'alert.service'));
  const head = `${title}${sev || service ? ` (${[sev, service].filter(Boolean).join(', ')})` : ''}`;
  const action = d.outcome === 'open' ? 'Opening a room' : d.outcome === 'attach' ? `Attaching to open room ${d.existingRoom}` : 'Asking on-call to decide';
  const parts = [`${head}. ${action}${mode === 'shadow' ? ' (shadow mode)' : ''}: ${d.reasons[0]}.`];
  if (d.verdict) {
    parts.push(`AI verdict: ${d.verdict.verdict} at ${Math.round(d.verdict.confidence * 100)}% confidence.`);
    if (d.verdict.reasons.length) parts.push(`Reasons: ${d.verdict.reasons.slice(0, 5).join('; ')}.`);
    if (d.verdict.summary) parts.push(d.verdict.summary);
  }
  return parts.join(' ');
}
