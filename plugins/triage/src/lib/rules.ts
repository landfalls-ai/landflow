/** Triage rules: ordered, person-approved, first match wins. Pure functions. */
import { asSeverity } from './alert';
import { getPath, isObj, str, tryJson, type Obj } from './util';

export type RuleAction = 'open' | 'ask' | 'noise';
export type Operator = 'equals' | 'notEquals' | 'contains' | 'regex' | 'in' | 'exists' | 'notExists';

export interface Condition {
  path: string;
  operator: Operator;
  value: string;
}

export interface Rule {
  name: string;
  action: RuleAction;
  match: 'all' | 'any';
  conditions: Condition[];
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}

export interface RuleMatch {
  name: string;
  action: RuleAction;
  approvedBy: string | null;
  builtin?: boolean;
}

/** Names that are not a person. A Noise rule "approved" by one of these is refused. */
const NOT_A_PERSON = /^(ai|a\.i\.|llm|gpt|claude|model|bot|agent|auto|automatic|automated|system|workflow|landflow|n\/a|none|null|unknown|tbd)$/i;

const OPERATORS: Operator[] = ['equals', 'notEquals', 'contains', 'regex', 'in', 'exists', 'notExists'];

/** The rules parameter: `{ rule: [...] }` from the editor, a bare array, or a JSON string of either. */
export function readRules(param: unknown): Rule[] {
  let value = param;
  if (typeof value === 'string') value = value.trim() ? tryJson(value) : [];
  if (isObj(value) && 'rule' in value) value = value.rule;
  if (isObj(value)) value = [value];
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).map((r, i) => {
    let conds: unknown = r.conditions;
    if (typeof conds === 'string') conds = tryJson(conds);
    if (isObj(conds) && 'condition' in conds) conds = conds.condition;
    if (isObj(conds)) conds = [conds];
    const conditions = (Array.isArray(conds) ? conds : []).filter(isObj).map((c) => ({
      path: str(c.path).trim(),
      operator: (OPERATORS.includes(c.operator as Operator) ? c.operator : 'equals') as Operator,
      value: str(c.value),
    }));
    return {
      name: str(r.name).trim() || `Rule ${i + 1}`,
      action: (['open', 'ask', 'noise'].includes(str(r.action)) ? str(r.action) : 'ask') as RuleAction,
      match: str(r.match) === 'any' ? 'any' : 'all',
      conditions,
      approvedBy: str(r.approvedBy).trim(),
      approvedAt: str(r.approvedAt).trim(),
      expiresAt: str(r.expiresAt).trim(),
    };
  });
}

/** Throws an Error (the node wraps it) when a Noise rule has no person's approval. */
export function validateRules(rules: Rule[]): void {
  for (const rule of rules) {
    if (rule.action !== 'noise') continue;
    if (!rule.approvedBy || NOT_A_PERSON.test(rule.approvedBy)) {
      throw new Error(
        `Noise rule "${rule.name}" has no approver. A person must approve noise rules: set "Approved By" to the name or e-mail of the person who reviewed it. An AI verdict can never mark an alert as noise.`,
      );
    }
  }
}

function parseTime(s: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** Expired when `expiresAt` is in the past. An unparsable `expiresAt` counts as expired: the rule cannot be trusted. */
export function isExpired(rule: Rule, now: number): boolean {
  if (!rule.expiresAt) return false;
  const t = parseTime(rule.expiresAt);
  return t === undefined || t <= now;
}

function scalars(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(scalars);
  if (v === undefined || v === null) return [];
  if (isObj(v)) return [JSON.stringify(v)];
  return [str(v)];
}

function toRegex(pattern: string): RegExp | undefined {
  try {
    const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
    return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function inList(list: string): string[] {
  const parsed = list.trim().startsWith('[') ? tryJson(list) : undefined;
  if (Array.isArray(parsed)) return parsed.map(str);
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

export function evalCondition(c: Condition, item: Obj): boolean {
  const raw = getPath(item, c.path);
  const present = raw !== undefined && raw !== null && raw !== '' && !(Array.isArray(raw) && raw.length === 0);
  if (c.operator === 'exists') return present;
  if (c.operator === 'notExists') return !present;
  const values = scalars(raw);
  switch (c.operator) {
    case 'equals':
      return values.includes(c.value);
    case 'notEquals':
      return !values.includes(c.value);
    case 'contains':
      return c.value !== '' && values.some((v) => v.includes(c.value));
    case 'regex': {
      const re = toRegex(c.value);
      return !!re && values.some((v) => re.test(v));
    }
    case 'in': {
      const list = inList(c.value);
      return values.some((v) => list.includes(v));
    }
    default:
      return false;
  }
}

/** A rule with no conditions never matches (an empty rule must not swallow everything). */
export function ruleMatches(rule: Rule, item: Obj): boolean {
  if (rule.conditions.length === 0) return false;
  const test = (c: Condition) => evalCondition(c, item);
  return rule.match === 'any' ? rule.conditions.some(test) : rule.conditions.every(test);
}

export interface RuleOutcome {
  /** 0 Bypass, 1 Noise, 2 Ask, 3 Evaluate */
  output: 0 | 1 | 2 | 3;
  rule?: RuleMatch;
  skipped: string[];
}

/**
 * Pick the output for one item. sev1 is always bypassed, whatever `bypassSeverities` says. Expired rules are skipped
 * (and named in `skipped`), a missing severity never bypasses.
 */
export function evaluateRules(item: Obj, rules: Rule[], bypassSeverities: string[], severityField: string, now: number): RuleOutcome {
  const skipped: string[] = [];
  const severity = asSeverity(getPath(item, severityField));
  const bypass = new Set<string>(['sev1', ...bypassSeverities.map((s) => asSeverity(s) ?? s)]);
  if (severity && bypass.has(severity)) {
    return { output: 0, rule: { name: `Severity bypass (${severity})`, action: 'open', approvedBy: null, builtin: true }, skipped };
  }
  for (const rule of rules) {
    if (isExpired(rule, now)) {
      skipped.push(rule.name);
      continue;
    }
    if (!ruleMatches(rule, item)) continue;
    const match: RuleMatch = { name: rule.name, action: rule.action, approvedBy: rule.approvedBy || null };
    return { output: rule.action === 'open' ? 0 : rule.action === 'noise' ? 1 : 2, rule: match, skipped };
  }
  return { output: 3, skipped };
}
