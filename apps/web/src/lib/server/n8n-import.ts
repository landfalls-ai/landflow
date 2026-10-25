/**
 * Workflow import: Landflow's own JSON export, or an n8n workflow (or nodes
 * copied in n8n) converted to Landflow. n8n node types map to the core nodes
 * and the integration plugins, which mirror n8n's parameter names; known
 * parameter differences are fixed, credential references are dropped, sticky
 * notes become canvas notes and nodes without an equivalent become disabled
 * No Operation placeholders. Everything is reported back to the user.
 *
 * Pure: no file system or registry access. The caller passes the registered
 * node types (`resolveType`) for default versions and port checks.
 */
import { nanoid } from 'nanoid';
import { defaultVersionOf, isPropertyVisible, withPropertyDefaults, type ConnectionType, type NodeDescriptor } from '@landflow/protocol';
import type { StickyNote, Workflow, WorkflowConnection, WorkflowNode, WorkflowSettings } from '@landflow/engine';
import type { ImportReport } from '../shared/types';

/** Rule outputs of core.switch (SWITCH_OUTPUTS in nodes/flow.ts); its fallback output comes after them. */
const SWITCH_OUTPUTS = 4;
/** Category outputs of core.textClassifier (CLASSIFIER_OUTPUTS in nodes/chains.ts); "Other" comes after them. */
const CLASSIFIER_OUTPUTS = 4;
/** Limits of workflowSchema (schemas.ts). */
const LIMITS = { maxTries: [1, 10], waitMs: [0, 60_000], timeout: [1, 86_400], sticky: [40, 4000], stickyContent: 20_000 } as const;
const AI_TYPES = new Set<string>(['ai_languageModel', 'ai_memory', 'ai_tool']);
const B = 'n8n-nodes-base.';
const L = '@n8n/n8n-nodes-langchain.';

type Params = Record<string, unknown>;

export interface ImportOptions {
  /** Descriptor of a registered node type: default versions, port checks and "only if registered" mappings. */
  resolveType?: (type: string) => NodeDescriptor | undefined;
}

export interface ImportResult {
  workflow: Omit<Workflow, 'id'>;
  report: ImportReport;
}

/** A node as n8n stores it in workflow and clipboard JSON. */
export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Params;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  onError?: string;
  continueOnFail?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
}

interface Ctx {
  node: N8nNode;
  version: number;
  warn(message: string): void;
  /** Descriptor of a registered Landflow type. */
  descriptor(type: string): NodeDescriptor | undefined;
}

interface Conversion {
  parameters: Params;
  disabled?: boolean;
  notes?: string;
  /** n8n output index → Landflow output index (undefined: no equivalent, the connection is dropped). */
  outputMap?: (index: number) => number | undefined;
}

type Converter = (p: Params, ctx: Ctx) => Conversion;

interface Mapping {
  /** Landflow type, or candidates (the first registered one wins). */
  to: string | string[];
  convert?: Converter;
  /** Only map when the type is registered; otherwise the node becomes a placeholder. */
  registered?: boolean;
  /** Added to the report whenever the mapping is used. */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Params => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);
const list = (value: unknown): Params[] => (Array.isArray(value) ? value.filter(isObject) : []);
const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));
const num = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
/** A value as a parameter string: strings as they are, everything else as JSON. */
const text = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value));

/**
 * n8n parameter values → Landflow's: a string starting with "=" is an n8n expression (the template after it), and a
 * resource locator `{ __rl: true, value, mode }` is just its value.
 */
export function convertValue(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('=') ? value.slice(1) : value;
  if (Array.isArray(value)) return value.map(convertValue);
  if (isObject(value)) {
    if (value.__rl === true) return convertValue(value.value ?? '');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, convertValue(entry)]));
  }
  return value;
}

/** A date value as a millisecond timestamp expression, so Landflow's numeric comparisons work on dates. */
function asTimestamp(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const whole = /^\s*\{\{([\s\S]+)\}\}\s*$/.exec(value);
  if (whole && !whole[1].includes('}}')) return `{{ new Date(${whole[1].trim()}).getTime() }}`;
  if (!value.includes('{{')) return `{{ new Date(${JSON.stringify(value)}).getTime() }}`;
  return value;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Conditions (If, Filter, Switch)
// ---------------------------------------------------------------------------

interface LfCondition {
  left: unknown;
  operator: string;
  right: unknown;
}

/** n8n filter (v2 conditions) operations → Landflow operators. */
const FILTER_OPS: Record<string, string> = {
  equals: 'equals',
  notEquals: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  regex: 'regex',
  empty: 'isEmpty',
  notEmpty: 'isNotEmpty',
  exists: 'isNotEmpty',
  notExists: 'isEmpty',
  true: 'isTrue',
  false: 'isFalse',
  after: 'gt',
  before: 'lt',
  afterOrEquals: 'gte',
  beforeOrEquals: 'lte',
};

/** n8n v1 condition operations (If v1, Switch v1/v2) → Landflow operators. */
const LEGACY_OPS: Record<string, string> = {
  equal: 'equals',
  notEqual: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  regex: 'regex',
  isEmpty: 'isEmpty',
  isNotEmpty: 'isNotEmpty',
  smaller: 'lt',
  smallerEqual: 'lte',
  larger: 'gt',
  largerEqual: 'gte',
  after: 'gt',
  before: 'lt',
};

const SINGLE_VALUE = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

function condition(left: unknown, operation: string, right: unknown, type: string, table: Record<string, string>, ctx: Ctx): LfCondition {
  if (type === 'dateTime') {
    left = asTimestamp(left);
    right = asTimestamp(right);
  }
  if (operation === 'endsWith' && typeof right === 'string' && !right.includes('{{')) return { left, operator: 'regex', right: `${escapeRegex(right)}$` };
  const operator = table[operation];
  if (!operator) {
    ctx.warn(`${ctx.node.name}: the condition “${type} ${operation}” has no Landflow equivalent; it was set to “is equal to”. Check it.`);
    return { left, operator: 'equals', right };
  }
  if (type === 'array' && (operator === 'contains' || operator === 'notContains')) {
    ctx.warn(`${ctx.node.name}: “array ${operation}” compares the array as text in Landflow. Check the condition.`);
  }
  return { left, operator, right: SINGLE_VALUE.has(operator) ? '' : (right ?? '') };
}

/** n8n's filter value `{ conditions: [{ leftValue, rightValue, operator: { type, operation } }], combinator }`. */
function filterConditions(group: Params, ctx: Ctx): { condition: LfCondition[]; combinator: 'and' | 'or' } {
  return {
    condition: list(group.conditions).map((c) => {
      const operator = isObject(c.operator) ? c.operator : {};
      return condition(c.leftValue ?? '', str(operator.operation) ?? 'equals', c.rightValue ?? '', str(operator.type) ?? 'string', FILTER_OPS, ctx);
    }),
    combinator: group.combinator === 'or' ? 'or' : 'and',
  };
}

/** If v1 / Filter v1: `{ string: [{ value1, operation, value2 }], number: […], boolean: […], dateTime: […] }`. */
function legacyConditions(groups: Params, combine: unknown, ctx: Ctx): { condition: LfCondition[]; combinator: 'and' | 'or' } {
  const out: LfCondition[] = [];
  for (const [type, entries] of Object.entries(groups)) {
    for (const c of list(entries)) out.push(condition(c.value1 ?? '', str(c.operation) ?? (type === 'number' ? 'smaller' : 'equal'), c.value2 ?? '', type, LEGACY_OPS, ctx));
  }
  return { condition: out, combinator: String(combine).toLowerCase() === 'any' || String(combine).toLowerCase() === 'or' ? 'or' : 'and' };
}

const conditionsNode: Converter = (p, ctx) => {
  const raw = isObject(p.conditions) ? p.conditions : {};
  const converted = Array.isArray(raw.conditions) ? filterConditions(raw, ctx) : legacyConditions(raw, p.combineOperation ?? p.combineConditions, ctx);
  return { parameters: { conditions: { condition: converted.condition }, combinator: converted.combinator } };
};

// ---------------------------------------------------------------------------
// Core node converters
// ---------------------------------------------------------------------------

const empty: Converter = () => ({ parameters: {} });

const webhook: Converter = (p, ctx) => {
  let method = p.httpMethod ?? 'GET';
  if (Array.isArray(method)) {
    if (method.length > 1) ctx.warn(`${ctx.node.name}: Landflow webhooks take one HTTP method; ${method[0]} was kept.`);
    method = method[0] ?? 'GET';
  }
  const respond = { onReceived: 'immediately', lastNode: 'lastNode', responseNode: 'responseNode' }[str(p.responseMode) ?? 'onReceived'] ?? 'immediately';
  const descriptor = ctx.descriptor('core.webhook');
  const options = descriptor?.properties.find((d) => d.name === 'respond')?.options ?? [];
  if (respond === 'responseNode' && descriptor && !options.some((o) => o.value === 'responseNode')) {
    ctx.warn(`${ctx.node.name}: “Respond to Webhook” responses aren't available; the webhook now answers when the last node finishes.`);
    return { parameters: { path: str(p.path) ?? 'webhook', method: String(method).toUpperCase(), respond: 'lastNode' } };
  }
  return { parameters: { path: str(p.path) ?? 'webhook', method: String(method).toUpperCase(), respond, ...(isObject(p.options) && { options: p.options }) } };
};

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400, weeks: 604_800, months: 2_592_000 };

/** Seconds → Schedule v1's `every` + `unit`. */
function everyUnit(seconds: number): { every: number; unit: 'seconds' | 'minutes' | 'hours' } {
  const s = Math.max(1, Math.round(seconds));
  if (s % 3600 === 0) return { every: s / 3600, unit: 'hours' };
  if (s % 60 === 0) return { every: s / 60, unit: 'minutes' };
  return { every: s, unit: 'seconds' };
}

const scheduleTrigger: Converter = (p, ctx) => {
  const rule = isObject(p.rule) ? p.rule : { interval: [{}] };
  const rules = list(rule.interval);
  const first = rules[0] ?? {};
  const field = str(first.field) ?? 'days';
  const n = (key: string, fallback: number) => Math.max(1, num(first[key], fallback));
  const intervals: Record<string, () => number> = {
    seconds: () => n('secondsInterval', 30),
    minutes: () => n('minutesInterval', 5) * 60,
    hours: () => n('hoursInterval', 1) * 3600,
    days: () => n('daysInterval', 1) * 86_400,
    weeks: () => n('weeksInterval', 1) * 604_800,
    months: () => n('monthsInterval', 1) * 2_592_000,
  };
  let seconds = intervals[field]?.();
  if (seconds === undefined) {
    ctx.warn(`${ctx.node.name}: the cron rule (${text(first.expression)}) was simplified to every hour. Check the schedule.`);
    seconds = 3600;
  } else if (['days', 'weeks', 'months'].includes(field)) {
    ctx.warn(`${ctx.node.name}: the “${field}” rule was simplified to a fixed interval from activation, without n8n's time of day. Check the schedule.`);
  }
  if (rules.length > 1) ctx.warn(`${ctx.node.name}: only the first of ${rules.length} schedule rules was converted.`);
  return { parameters: { ...everyUnit(seconds), rule } };
};

/** Legacy Cron node: `triggerTimes.item[]` with everyMinute / everyHour / everyX / everyDay… */
const cron: Converter = (p, ctx) => {
  const items = isObject(p.triggerTimes) ? list(p.triggerTimes.item) : [];
  const first = items[0] ?? { mode: 'everyDay' };
  const mode = str(first.mode) ?? 'everyDay';
  const table: Record<string, number> = { everyMinute: 60, everyHour: 3600, everyDay: 86_400, everyWeek: 604_800, everyMonth: 2_592_000 };
  let seconds = mode === 'everyX' ? Math.max(1, num(first.value, 2)) * (UNIT_SECONDS[str(first.unit) ?? 'hours'] ?? 3600) : table[mode];
  if (seconds === undefined) seconds = 3600;
  if (!['everyMinute', 'everyHour', 'everyX'].includes(mode) || items.length > 1) {
    ctx.warn(`${ctx.node.name}: the Cron schedule was simplified to every ${everyUnit(seconds).every} ${everyUnit(seconds).unit}. Check the schedule.`);
  }
  return { parameters: everyUnit(seconds) };
};

/** Legacy Interval node: `interval` + `unit`. */
const interval: Converter = (p) => ({ parameters: everyUnit(Math.max(1, num(p.interval, 1)) * (UNIT_SECONDS[str(p.unit) ?? 'seconds'] ?? 1)) });

const pairs = (entries: unknown) => list(entries).map((e) => ({ name: text(e.name), value: text(e.value) }));

/** `{ a: 1 }` JSON text, or key/value pairs → a JSON body string. */
function bodyFromPairs(entries: Array<{ name: string; value: string }>) {
  return JSON.stringify(Object.fromEntries(entries.filter((e) => e.name).map((e) => [e.name, e.value])), null, 2);
}

/** A JSON object literal of n8n's "Using JSON" query/header modes → name/value pairs (when it is literal JSON). */
function jsonPairs(value: unknown, what: string, ctx: Ctx): Array<{ name: string; value: string }> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (isObject(parsed)) return Object.entries(parsed).map(([name, v]) => ({ name, value: text(v) }));
  } catch {}
  ctx.warn(`${ctx.node.name}: the ${what} were given as an expression; add them again as name/value pairs.`);
  return [];
}

const httpRequest: Converter = (p, ctx) => {
  const options = isObject(p.options) ? p.options : {};
  const out: Params = {};
  const lfOptions: Params = {};
  const legacy = 'requestMethod' in p || 'queryParametersUi' in p || 'headerParametersUi' in p || 'jsonParameters' in p || 'bodyParametersUi' in p;
  if (legacy) {
    out.method = str(p.requestMethod) ?? 'GET';
    out.url = p.url ?? '';
    const query = pairs(isObject(p.queryParametersUi) ? p.queryParametersUi.parameter : undefined);
    const headers = pairs(isObject(p.headerParametersUi) ? p.headerParametersUi.parameter : undefined);
    if (query.length) out.query = { parameter: query };
    if (headers.length) out.headers = { header: headers };
    if (p.jsonParameters) out.body = text(p.bodyParametersJson);
    else if (isObject(p.bodyParametersUi)) out.body = bodyFromPairs(pairs(p.bodyParametersUi.parameter));
    if (options.fullResponse) lfOptions.fullResponse = true;
  } else {
    out.method = str(p.method) ?? 'GET';
    out.url = p.url ?? '';
    if (p.sendQuery) {
      const query = p.specifyQuery === 'json' ? jsonPairs(p.jsonQuery, 'query parameters', ctx) : pairs(isObject(p.queryParameters) ? p.queryParameters.parameters : undefined);
      if (query.length) out.query = { parameter: query };
    }
    if (p.sendHeaders) {
      const headers = p.specifyHeaders === 'json' ? jsonPairs(p.jsonHeaders, 'headers', ctx) : pairs(isObject(p.headerParameters) ? p.headerParameters.parameters : undefined);
      if (headers.length) out.headers = { header: headers };
    }
    if (p.sendBody) {
      const contentType = str(p.contentType) ?? 'json';
      if (contentType === 'raw') out.body = text(p.body);
      else if (contentType === 'binaryData') ctx.warn(`${ctx.node.name}: binary request bodies aren't supported yet; the body was left empty.`);
      else if (p.specifyBody === 'json') out.body = text(p.jsonBody);
      else out.body = bodyFromPairs(pairs(isObject(p.bodyParameters) ? p.bodyParameters.parameters : undefined));
      if (contentType === 'form-urlencoded' || contentType === 'multipart-form-data') ctx.warn(`${ctx.node.name}: the ${contentType} body is sent as JSON in Landflow.`);
    }
    const response = isObject(options.response) && isObject(options.response.response) ? options.response.response : {};
    if (response.fullResponse) lfOptions.fullResponse = true;
    if (isObject(options.pagination)) ctx.warn(`${ctx.node.name}: pagination isn't supported; only the first page is requested.`);
  }
  if (options.timeout !== undefined) lfOptions.timeoutMs = num(options.timeout, 30_000);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(String(out.method))) {
    ctx.warn(`${ctx.node.name}: the ${text(out.method)} method isn't available; GET was used.`);
    out.method = 'GET';
  }
  const auth = str(p.authentication);
  if (auth && auth !== 'none') ctx.warn(`${ctx.node.name}: authentication (${auth}) isn't converted; add an Authorization header.`);
  if (Object.keys(lfOptions).length) out.options = lfOptions;
  return { parameters: out };
};

const SET_TYPES: Record<string, string> = { string: 'string', number: 'number', boolean: 'boolean', object: 'json', array: 'json', json: 'json' };

const set: Converter = (p, ctx) => {
  let includeOtherFields: boolean;
  if ('includeOtherFields' in p) includeOtherFields = Boolean(p.includeOtherFields);
  else if ('include' in p) includeOtherFields = p.include !== 'none';
  else if ('keepOnlySet' in p) includeOtherFields = !p.keepOnlySet;
  else includeOtherFields = ctx.version < 3.3;
  if (includeOtherFields && (p.include === 'selected' || p.include === 'except')) {
    ctx.warn(`${ctx.node.name}: keeping only “${p.include}” other fields isn't supported; all other fields are kept.`);
  }
  if (p.mode === 'raw') {
    return { parameters: { mode: 'json', json: typeof p.jsonOutput === 'string' ? p.jsonOutput : JSON.stringify(p.jsonOutput ?? {}, null, 2), includeOtherFields } };
  }
  const values: Array<{ name: string; type: string; value: string }> = [];
  if (isObject(p.assignments)) {
    for (const a of list(p.assignments.assignments)) values.push({ name: text(a.name), type: SET_TYPES[str(a.type) ?? 'string'] ?? 'string', value: text(a.value) });
  } else if (isObject(p.fields) && Array.isArray(p.fields.values)) {
    for (const f of list(p.fields.values)) {
      const key = str(f.type) ?? 'stringValue';
      values.push({ name: text(f.name), type: SET_TYPES[key.replace(/Value$/, '')] ?? 'string', value: text(f[key]) });
    }
  } else if (isObject(p.values)) {
    for (const [type, entries] of Object.entries(p.values)) {
      for (const e of list(entries)) values.push({ name: text(e.name), type: SET_TYPES[type] ?? 'string', value: text(e.value) });
    }
  }
  return { parameters: { mode: 'manual', fields: { values }, includeOtherFields } };
};

function checkCode(source: string, ctx: Ctx) {
  const unsupported = /\$\(|\$node\b|\$items\(|\$env\b|require\(|\$getWorkflowStaticData|this\.helpers/.exec(source);
  if (unsupported) ctx.warn(`${ctx.node.name}: the code uses ${unsupported[0].replace('(', '()')}, which Landflow's Code node doesn't provide. Check the code.`);
}

const commentOut = (source: string) => source.split('\n').map((line) => `// ${line}`).join('\n');

const code: Converter = (p, ctx) => {
  const language = str(p.language) ?? 'javaScript';
  if (language !== 'javaScript') {
    ctx.warn(`${ctx.node.name}: Python code isn't supported; the node was disabled with the code commented out.`);
    return {
      parameters: { mode: 'all', code: `// Python code imported from n8n: rewrite it in JavaScript.\n${commentOut(text(p.pythonCode))}\nreturn items;` },
      disabled: true,
      notes: 'Imported from n8n with Python code, which Landflow does not run. Rewrite it in JavaScript, then enable the node.',
    };
  }
  const source = text(p.jsCode);
  checkCode(source, ctx);
  if (p.mode === 'runOnceForEachItem') {
    // n8n's per-item code reads `$input.item`; Landflow's gives `$json`.
    const shim = /\$input\b/.test(source) ? 'const $input = { item: { json: $json } };\n' : '';
    return { parameters: { mode: 'each', codeEach: shim + source } };
  }
  return { parameters: { mode: 'all', code: source } };
};

/** Legacy Function (all items, `items`) and Function Item (`item`) nodes. */
const legacyFunction =
  (perItem: boolean): Converter =>
  (p, ctx) => {
    const source = text(p.functionCode);
    checkCode(source, ctx);
    return { parameters: perItem ? { mode: 'each', codeEach: `const item = $json;\n${source}` } : { mode: 'all', code: source } };
  };

const switchNode: Converter = (p, ctx) => {
  const options = isObject(p.options) ? p.options : {};
  if (p.mode === 'expression') {
    if (num(p.numberOutputs, 4) > SWITCH_OUTPUTS) ctx.warn(`${ctx.node.name}: Landflow's Switch has ${SWITCH_OUTPUTS} outputs; connections from the others were dropped.`);
    return { parameters: { mode: 'expression', output: p.output ?? 0 }, outputMap: (i) => (i < SWITCH_OUTPUTS ? i : undefined) };
  }
  if (ctx.version >= 3) {
    const rules = isObject(p.rules) ? list(p.rules.values) : [];
    if (rules.length > SWITCH_OUTPUTS) ctx.warn(`${ctx.node.name}: Landflow's Switch has ${SWITCH_OUTPUTS} rule outputs; rules ${SWITCH_OUTPUTS + 1}–${rules.length} were dropped.`);
    const values = rules.slice(0, SWITCH_OUTPUTS).map((rule) => {
      const converted = isObject(rule.conditions) ? filterConditions(rule.conditions, ctx) : { condition: [], combinator: 'and' as const };
      return { conditions: { condition: converted.condition }, combinator: converted.combinator };
    });
    let fallback = 'none';
    if (options.fallbackOutput === 'extra') fallback = 'extra';
    else if (options.fallbackOutput !== undefined && options.fallbackOutput !== 'none') {
      ctx.warn(`${ctx.node.name}: sending unmatched items to output ${text(options.fallbackOutput)} isn't supported; they are dropped. Use the Fallback output.`);
    }
    const count = rules.length;
    return {
      parameters: {
        mode: 'rules',
        rules: { values },
        options: { fallbackOutput: fallback, ...(options.allMatchingOutputs !== undefined && { allMatchingOutputs: Boolean(options.allMatchingOutputs) }) },
      },
      outputMap: (i) => (i < count ? (i < SWITCH_OUTPUTS ? i : undefined) : i === count && fallback === 'extra' ? SWITCH_OUTPUTS : undefined),
    };
  }
  // Switch v1/v2: one value compared by each rule, which names its output.
  const dataType = str(p.dataType) ?? 'number';
  const values: Array<{ conditions: { condition: LfCondition[] }; combinator: 'and' }> = [];
  for (const rule of isObject(p.rules) ? list(p.rules.rules) : []) {
    const output = num(rule.output, values.length);
    if (output >= SWITCH_OUTPUTS || values[output]) {
      ctx.warn(`${ctx.node.name}: a rule for output ${output} couldn't be converted.`);
      continue;
    }
    values[output] = {
      conditions: { condition: [condition(p.value1 ?? '', str(rule.operation) ?? (dataType === 'number' ? 'smaller' : 'equal'), rule.value2 ?? '', dataType, LEGACY_OPS, ctx)] },
      combinator: 'and',
    };
  }
  // Gaps get a rule that never matches, so rule i still routes to output i.
  for (let i = 0; i < values.length; i++) values[i] ??= { conditions: { condition: [{ left: '', operator: 'isNotEmpty', right: '' }] }, combinator: 'and' };
  if (num(p.fallbackOutput, -1) >= 0) ctx.warn(`${ctx.node.name}: the fallback to output ${text(p.fallbackOutput)} isn't supported; unmatched items are dropped.`);
  return { parameters: { mode: 'rules', rules: { values }, options: { fallbackOutput: 'none' } }, outputMap: (i) => (i < SWITCH_OUTPUTS ? i : undefined) };
};

const merge: Converter = (p, ctx) => {
  const mode = str(p.mode) ?? 'append';
  const combineBy = str(p.combineBy) ?? str(p.combinationMode);
  const byPosition = mode === 'combineByPosition' || mode === 'mergeByIndex' || (mode === 'combine' && (combineBy === 'combineByPosition' || combineBy === 'mergeByPosition'));
  const byField = mode === 'combineByFields' || mode === 'mergeByKey' || (mode === 'combine' && (combineBy === 'combineByFields' || combineBy === 'mergeByFields' || combineBy === undefined));
  if (mode === 'append') return { parameters: { mode: 'append' } };
  if (byPosition) return { parameters: { mode: 'position' } };
  if (byField) {
    let field = str(p.fieldsToMatchString)?.split(',')[0]?.trim();
    const pair = (isObject(p.mergeByFields) ? list(p.mergeByFields.values)[0] : undefined) ?? (isObject(p.fieldsToMatch) ? list(p.fieldsToMatch.values)[0] : undefined);
    field ??= str(pair?.field1) ?? str(p.propertyName1);
    const other = str(pair?.field2) ?? str(p.propertyName2);
    if (other && field && other !== field) ctx.warn(`${ctx.node.name}: Landflow matches the same field on both inputs; “${field}” was used for both.`);
    return { parameters: { mode: 'field', field: field ?? 'id' } };
  }
  ctx.warn(`${ctx.node.name}: the merge mode “${mode}${combineBy ? ` ${combineBy}` : ''}” isn't available; it now appends the inputs.`);
  return { parameters: { mode: 'append' } };
};

const sort: Converter = (p, ctx) => {
  if (p.type && p.type !== 'simple') ctx.warn(`${ctx.node.name}: “${text(p.type)}” sorting isn't available; it sorts by a field.`);
  const fields = isObject(p.sortFieldsUi) ? list(p.sortFieldsUi.sortField) : [];
  if (fields.length > 1) ctx.warn(`${ctx.node.name}: Landflow sorts by one field; “${text(fields[0].fieldName)}” was kept.`);
  return { parameters: { field: text(fields[0]?.fieldName) || 'value', order: fields[0]?.order === 'descending' ? 'desc' : 'asc' } };
};

const limit: Converter = (p) => ({ parameters: { maxItems: Math.max(1, num(p.maxItems, 1)), keep: p.keep === 'lastItems' ? 'last' : 'first' } });

const wait: Converter = (p, ctx) => {
  const resume = str(p.resume) ?? 'timeInterval';
  if (resume !== 'timeInterval') ctx.warn(`${ctx.node.name}: resuming on “${resume}” needs the new Wait node; check its settings.`);
  let seconds = Math.max(0, num(p.amount, 1)) * (UNIT_SECONDS[str(p.unit) ?? 'hours'] ?? 3600);
  if (seconds > 300) {
    ctx.warn(`${ctx.node.name}: waits of more than 5 minutes need the new Wait node; it waits 300 seconds for now.`);
    seconds = 300;
  }
  // The original n8n fields stay for Wait v2, which uses n8n's names.
  return { parameters: { ...p, seconds } };
};

const stopAndError: Converter = (p) => ({
  parameters: { message: p.errorType === 'errorObject' ? text(p.errorObject) : text(p.errorMessage) || 'Something went wrong' },
});

const workflowTrigger: Converter = (p, ctx) => {
  const types: Record<string, string> = { string: 'string', number: 'number', boolean: 'boolean' };
  const fields = (isObject(p.workflowInputs) ? list(p.workflowInputs.values) : []).map((v) => ({
    name: text(v.name),
    type: types[str(v.type) ?? 'string'] ?? 'json',
    description: '',
    required: false,
  }));
  if (p.inputSource === 'jsonExample') ctx.warn(`${ctx.node.name}: inputs defined by a JSON example weren't converted; add them as arguments.`);
  return { parameters: { inputs: { fields } } };
};

// ---------------------------------------------------------------------------
// AI converters
// ---------------------------------------------------------------------------

const CHAT_INPUT = '{{ $json.chatInput }}';

const agent: Converter = (p, ctx) => {
  const options = isObject(p.options) ? p.options : {};
  const prompt = p.promptType === 'define' || (p.promptType === undefined && ctx.version < 1.1 && typeof p.text === 'string') ? text(p.text) : CHAT_INPUT;
  const lfOptions: Params = {};
  if (options.maxIterations !== undefined) lfOptions.maxIterations = clamp(num(options.maxIterations, 8), [1, 30]);
  if (options.returnIntermediateSteps !== undefined) lfOptions.returnIntermediateSteps = Boolean(options.returnIntermediateSteps);
  if (p.hasOutputParser) ctx.warn(`${ctx.node.name}: output parsers aren't imported; the agent returns plain text.`);
  return { parameters: { prompt, ...(options.systemMessage !== undefined && { systemMessage: options.systemMessage }), options: lfOptions } };
};

const chainLlm: Converter = (p, ctx) => {
  let prompt: unknown = CHAT_INPUT;
  if (p.promptType === 'define') prompt = p.text ?? '';
  else if (p.promptType === undefined && typeof p.prompt === 'string') prompt = p.prompt;
  else if (p.promptType === undefined && ctx.version < 1.4 && typeof p.text === 'string') prompt = p.text;
  const messages = isObject(p.messages) ? list(p.messages.messageValues) : [];
  const system = messages.find((m) => (m.type ?? 'SystemMessagePromptTemplate') === 'SystemMessagePromptTemplate');
  if (messages.length > (system ? 1 : 0)) ctx.warn(`${ctx.node.name}: only the system message was imported; other chat messages were dropped.`);
  if (p.hasOutputParser) ctx.warn(`${ctx.node.name}: set the JSON schema under “Require Specific Output Format”; n8n's output parser node isn't imported.`);
  return { parameters: { prompt, ...(system && { systemMessage: system.message ?? '' }), ...(p.hasOutputParser !== undefined && { hasOutputParser: Boolean(p.hasOutputParser) }) } };
};

/** A JSON schema guessed from an example object (n8n's "Generate From JSON Example"). */
function schemaOf(value: unknown): Params {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaOf(value[0]) : {} };
  if (isObject(value)) return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, schemaOf(v)])) };
  return { type: value === null ? 'string' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string' };
}

const informationExtractor: Converter = (p, ctx) => {
  const { jsonSchemaExample, ...rest } = p;
  if (p.schemaType !== 'fromJson') return { parameters: rest };
  try {
    const example = typeof jsonSchemaExample === 'string' ? JSON.parse(jsonSchemaExample) : jsonSchemaExample;
    ctx.warn(`${ctx.node.name}: the JSON schema was generated from n8n's example. Check it.`);
    return { parameters: { ...rest, schemaType: 'manual', inputSchema: JSON.stringify(schemaOf(example), null, 2) } };
  } catch {
    ctx.warn(`${ctx.node.name}: the JSON example couldn't be read; define the attributes again.`);
    return { parameters: { ...rest, schemaType: 'fromAttributes' } };
  }
};

const textClassifier: Converter = (p, ctx) => {
  const count = isObject(p.categories) ? list(p.categories.categories).length : 0;
  const other = isObject(p.options) && p.options.fallback === 'other';
  if (count > CLASSIFIER_OUTPUTS) ctx.warn(`${ctx.node.name}: Landflow's Text Classifier has ${CLASSIFIER_OUTPUTS} category outputs; connections from the others were dropped.`);
  return { parameters: p, outputMap: (i) => (i < count ? (i < CLASSIFIER_OUTPUTS ? i : undefined) : i === count && other ? CLASSIFIER_OUTPUTS : undefined) };
};

const pick = (source: unknown, keys: string[]) => (isObject(source) ? Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])) : {});

const openAiChatModel: Converter = (p, ctx) => {
  if (isObject(p.options) && p.options.baseURL) ctx.warn(`${ctx.node.name}: set the base URL (${text(p.options.baseURL)}) on the OpenAI API credential.`);
  return { parameters: { model: text(p.model) || 'gpt-5-mini', options: pick(p.options, ['temperature', 'maxTokens', 'responseFormat']) } };
};

/** OpenAI-compatible providers run on the OpenAI Chat Model with a credential pointing at their base URL. */
const compatibleModel =
  (provider: string): Converter =>
  (p, ctx) => {
    ctx.warn(`${ctx.node.name}: ${provider} runs on the OpenAI Chat Model; use an OpenAI API credential with ${provider}'s base URL.`);
    return { parameters: { model: text(p.model), options: pick(p.options, ['temperature', 'maxTokens']) } };
  };

const anthropicChatModel: Converter = (p, ctx) => {
  const model = text(p.model);
  const known = ctx.descriptor('core.anthropicChatModel')?.properties.find((d) => d.name === 'model')?.options;
  if (model && known && !known.some((o) => o.value === model)) ctx.warn(`${ctx.node.name}: the model “${model}” isn't in Landflow's list; it was kept as typed.`);
  const options = isObject(p.options) ? p.options : {};
  return { parameters: { ...(model && { model }), ...(options.maxTokensToSample !== undefined && { maxTokens: num(options.maxTokensToSample, 16_000) }) } };
};

const ollamaChatModel: Converter = (p) => {
  const options = isObject(p.options) ? p.options : {};
  return { parameters: { ...(p.model !== undefined && { model: text(p.model) }), ...(options.temperature !== undefined && { temperature: num(options.temperature, 0.2) }) } };
};

const simpleMemory: Converter = (p, ctx) => {
  if (p.sessionIdType === 'customKey') ctx.warn(`${ctx.node.name}: set the agent's “Session Key” option to ${text(p.sessionKey)}; memory keys live on the agent in Landflow.`);
  return { parameters: { turns: clamp(num(p.contextWindowLength, 5), [1, 100]) } };
};

const chatTrigger: Converter = (p, ctx) => {
  if (p.public) ctx.warn(`${ctx.node.name}: the public chat page isn't available yet; chat from the editor's chat panel.`);
  return { parameters: {} };
};

const toolHttpRequest: Converter = (p) => ({ parameters: { method: str(p.method) ?? 'GET', url: p.url ?? '' } });

// ---------------------------------------------------------------------------
// The type map
// ---------------------------------------------------------------------------

function plugin(id: string, names: string[], warnings: Record<string, string> = {}): Record<string, Mapping> {
  return Object.fromEntries(names.map((name) => [`${B}${name}`, { to: `${id}.${name}`, ...(warnings[name] && { warning: warnings[name] }) }]));
}

const POLLS = 'Landflow polls for new events instead of registering a webhook';

/** n8n node type → Landflow mapping. `n8n-nodes-base.<x>Tool` uses the entry of `<x>`. */
export const N8N_TYPE_MAP: Record<string, Mapping> = {
  [`${B}manualTrigger`]: { to: 'core.manualTrigger', convert: empty },
  [`${B}webhook`]: { to: 'core.webhook', convert: webhook },
  [`${B}scheduleTrigger`]: { to: 'core.schedule', convert: scheduleTrigger },
  [`${B}cron`]: { to: 'core.schedule', convert: cron },
  [`${B}interval`]: { to: 'core.schedule', convert: interval },
  [`${B}httpRequest`]: { to: 'core.httpRequest', convert: httpRequest },
  [`${B}set`]: { to: 'core.set', convert: set },
  [`${B}code`]: { to: 'core.code', convert: code },
  [`${B}function`]: { to: 'core.code', convert: legacyFunction(false) },
  [`${B}functionItem`]: { to: 'core.code', convert: legacyFunction(true) },
  [`${B}if`]: { to: 'core.if', convert: conditionsNode },
  [`${B}filter`]: { to: 'core.filter', convert: conditionsNode },
  [`${B}switch`]: { to: 'core.switch', convert: switchNode },
  [`${B}merge`]: { to: 'core.merge', convert: merge },
  [`${B}sort`]: { to: 'core.sort', convert: sort },
  [`${B}limit`]: { to: 'core.limit', convert: limit },
  [`${B}splitOut`]: { to: 'core.splitOut' },
  [`${B}aggregate`]: { to: 'core.aggregate' },
  [`${B}removeDuplicates`]: { to: 'core.removeDuplicates' },
  [`${B}summarize`]: { to: 'core.summarize' },
  [`${B}renameKeys`]: { to: 'core.renameKeys' },
  [`${B}dateTime`]: { to: 'core.dateTime' },
  [`${B}wait`]: { to: 'core.wait', convert: wait },
  [`${B}noOp`]: { to: 'core.noOp', convert: empty },
  [`${B}stopAndError`]: { to: 'core.stopAndError', convert: stopAndError },
  [`${B}executeWorkflowTrigger`]: { to: 'core.workflowTrigger', convert: workflowTrigger },
  [`${B}errorTrigger`]: { to: 'core.errorTrigger', registered: true },
  [`${B}executeWorkflow`]: { to: 'core.executeWorkflow', registered: true, warning: 'the sub-workflow id comes from n8n: select the workflow again' },
  [`${B}respondToWebhook`]: { to: 'core.respondToWebhook', registered: true },
  [`${B}splitInBatches`]: { to: ['core.splitInBatches', 'core.loopOverItems'], registered: true },
  [`${B}formTrigger`]: { to: 'core.formTrigger', registered: true },
  [`${B}form`]: { to: 'core.form', registered: true },
  ...plugin('messaging', ['telegram', 'telegramTrigger', 'slack', 'discord', 'whatsApp', 'emailSend'], { telegramTrigger: POLLS }),
  ...plugin('productivity', ['notion', 'airtable', 'github', 'githubTrigger', 'jira', 'hubspot', 'rssFeedRead', 'rssFeedReadTrigger'], { githubTrigger: POLLS }),
  ...plugin('google', ['googleSheets', 'googleSheetsTrigger', 'gmail', 'gmailTrigger', 'googleDrive', 'googleCalendar', 'googleDocs']),
  ...plugin('databases', ['postgres', 'mySql', 'redis', 'postgresTrigger'], { postgresTrigger: POLLS }),
  [`${L}agent`]: { to: 'core.aiAgent', convert: agent },
  [`${L}chainLlm`]: { to: 'core.chainLlm', convert: chainLlm },
  [`${L}textClassifier`]: { to: 'core.textClassifier', convert: textClassifier },
  [`${L}informationExtractor`]: { to: 'core.informationExtractor', convert: informationExtractor },
  [`${L}openAi`]: { to: 'core.openAi' },
  [`${L}lmChatOpenAi`]: { to: 'core.openAiChatModel', convert: openAiChatModel },
  [`${L}lmChatAnthropic`]: { to: 'core.anthropicChatModel', convert: anthropicChatModel },
  [`${L}lmChatOllama`]: { to: 'core.ollamaChatModel', convert: ollamaChatModel },
  [`${L}lmOllama`]: { to: 'core.ollamaChatModel', convert: ollamaChatModel },
  [`${L}lmChatOpenRouter`]: { to: 'core.openAiChatModel', convert: compatibleModel('OpenRouter') },
  [`${L}lmChatDeepSeek`]: { to: 'core.openAiChatModel', convert: compatibleModel('DeepSeek') },
  [`${L}lmChatGroq`]: { to: 'core.openAiChatModel', convert: compatibleModel('Groq') },
  [`${L}lmChatMistralCloud`]: { to: 'core.openAiChatModel', convert: compatibleModel('Mistral') },
  [`${L}lmChatXAiGrok`]: { to: 'core.openAiChatModel', convert: compatibleModel('xAI') },
  [`${L}memoryBufferWindow`]: { to: 'core.simpleMemory', convert: simpleMemory },
  [`${L}toolCalculator`]: { to: 'core.calculatorTool', convert: empty },
  [`${L}toolHttpRequest`]: { to: 'core.httpRequest', convert: toolHttpRequest },
  [`${L}chatTrigger`]: { to: 'core.chatTrigger', convert: chatTrigger },
  [`${L}manualChatTrigger`]: { to: 'core.chatTrigger', convert: chatTrigger },
};

/** The mapping of an n8n type, including `<x>Tool` variants (the node used as an agent tool). */
export function mappingFor(type: string): { mapping: Mapping; asTool: boolean } | undefined {
  if (N8N_TYPE_MAP[type]) return { mapping: N8N_TYPE_MAP[type], asTool: false };
  if (type.startsWith(B) && type.endsWith('Tool') && N8N_TYPE_MAP[type.slice(0, -4)]) return { mapping: N8N_TYPE_MAP[type.slice(0, -4)], asTool: true };
  return undefined;
}

// ---------------------------------------------------------------------------
// n8n workflow → Landflow
// ---------------------------------------------------------------------------

interface Built {
  node: WorkflowNode;
  placeholder: boolean;
  descriptor?: Pick<NodeDescriptor, 'inputs' | 'outputs' | 'usableAsTool'>;
  outputMap?: (index: number) => number | undefined;
}

const PLACEHOLDER_PORTS = { inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }] };

/** n8n's "poll times" → the poll interval Landflow's polling triggers take, in seconds. */
function pollInterval(pollTimes: unknown): number | undefined {
  const first = isObject(pollTimes) ? list(pollTimes.item)[0] : undefined;
  if (!first) return undefined;
  const mode = str(first.mode) ?? 'everyMinute';
  if (mode === 'everyX') return Math.max(1, num(first.value, 1)) * (UNIT_SECONDS[str(first.unit) ?? 'minutes'] ?? 60);
  return { everyMinute: 60, everyHour: 3600, everyDay: 86_400, everyWeek: 604_800, everyMonth: 2_592_000 }[mode] ?? 3600;
}

/** Resource/operation values the Landflow node doesn't offer (static option lists only). */
function checkOptions(name: string, parameters: Params, descriptor: NodeDescriptor, warn: (message: string) => void) {
  for (const key of ['resource', 'operation']) {
    const value = parameters[key];
    if (value === undefined) continue;
    const properties = descriptor.properties.filter((d) => d.name === key && d.type === 'options' && !d.typeOptions?.loadOptionsMethod && isPropertyVisible(d, parameters));
    if (properties.length && !properties.some((d) => d.options?.some((o) => o.value === value))) {
      warn(`${name}: the ${key} “${text(value)}” isn't available in Landflow's ${descriptor.displayName} node. Pick another one.`);
    }
  }
}

function placeholderNotes(raw: N8nNode) {
  let parameters = JSON.stringify(raw.parameters ?? {});
  if (parameters.length > 1500) parameters = `${parameters.slice(0, 1500)}…`;
  return `Placeholder for the n8n node ${raw.type} (v${raw.typeVersion ?? 1}), which Landflow doesn't have. Original parameters: ${parameters}`;
}

function uniqueName(base: string, taken: Set<string>) {
  let name = base.trim() || 'Node';
  if (taken.has(name)) {
    let i = 1;
    while (taken.has(`${name}${i}`)) i++;
    name = `${name}${i}`;
  }
  taken.add(name);
  return name;
}

function convertNode(raw: N8nNode, name: string, options: ImportOptions, report: ImportReport, warn: (m: string) => void): Built {
  const id = `n_${nanoid(8)}`;
  const version = num(raw.typeVersion, 1);
  const position: [number, number] = Array.isArray(raw.position) ? [num(raw.position[0], 0), num(raw.position[1], 0)] : [0, 0];
  const descriptorOf = (type: string) => options.resolveType?.(type);
  const found = mappingFor(raw.type);
  let target: string | undefined;
  if (found) {
    const candidates = Array.isArray(found.mapping.to) ? found.mapping.to : [found.mapping.to];
    target = found.mapping.registered ? candidates.find((t) => descriptorOf(t)) : (candidates.find((t) => descriptorOf(t)) ?? candidates[0]);
  }

  const base: Omit<WorkflowNode, 'type' | 'typeVersion' | 'parameters'> = { id, name, position };
  if (!found || !target) {
    report.placeholders.push({ name, type: raw.type });
    return {
      node: { ...base, type: 'core.noOp', typeVersion: 1, parameters: {}, disabled: true, notes: placeholderNotes(raw) },
      placeholder: true,
      descriptor: PLACEHOLDER_PORTS,
    };
  }

  const descriptor = descriptorOf(target);
  const ctx: Ctx = { node: raw, version, warn, descriptor: descriptorOf };
  const converted = convertValue(raw.parameters ?? {}) as Params;
  const convert: Converter = found.mapping.convert ?? ((p) => ({ parameters: p }));
  const result = convert(converted, ctx);
  let parameters = result.parameters;
  if (found.mapping.warning) warn(`${name}: ${found.mapping.warning}.`);

  // Fixes every node gets.
  if (parameters.pollTimes !== undefined) {
    const { pollTimes, ...rest } = parameters;
    const seconds = pollInterval(pollTimes);
    parameters = seconds ? { ...rest, pollInterval: seconds } : rest;
  }
  let notes = result.notes ?? (typeof raw.notes === 'string' && raw.notes ? raw.notes : undefined);
  // A tool's description (n8n's `<x>Tool` nodes) is what Landflow reads from the node's notes.
  const toolDescription = converted.toolDescription ?? parameters.toolDescription;
  if (!notes && typeof toolDescription === 'string' && toolDescription) notes = toolDescription;
  if (descriptor) {
    checkOptions(name, parameters, descriptor, warn);
    parameters = withPropertyDefaults(descriptor.properties, parameters);
  }

  const node: WorkflowNode = { ...base, type: target, typeVersion: descriptor ? defaultVersionOf(descriptor) : 1, parameters };
  if (result.disabled ?? raw.disabled) node.disabled = true;
  if (notes) node.notes = notes;
  if (raw.onError === 'continueRegularOutput' || raw.onError === 'continueErrorOutput' || raw.continueOnFail) node.onError = 'continue';
  else if (raw.onError === 'stopWorkflow') node.onError = 'stop';
  if (raw.onError === 'continueErrorOutput') warn(`${name}: n8n's separate error output isn't available; errors continue down the main output.`);
  if (raw.retryOnFail) node.retryOnFail = true;
  if (raw.maxTries !== undefined) node.maxTries = clamp(Math.round(num(raw.maxTries, 3)), LIMITS.maxTries);
  if (raw.waitBetweenTries !== undefined) node.waitBetweenTriesMs = clamp(Math.round(num(raw.waitBetweenTries, 1000)), LIMITS.waitMs);
  if (raw.alwaysOutputData) node.alwaysOutputData = true;
  if (raw.executeOnce) node.executeOnce = true;
  report.mapped.push({ name, from: raw.type, to: target });
  return { node, placeholder: false, descriptor, outputMap: result.outputMap };
}

function stickyFrom(raw: N8nNode): StickyNote {
  const p = isObject(raw.parameters) ? raw.parameters : {};
  const color = Math.round(num(p.color, 1));
  return {
    id: `s_${nanoid(8)}`,
    content: text(p.content).slice(0, LIMITS.stickyContent),
    position: Array.isArray(raw.position) ? [num(raw.position[0], 0), num(raw.position[1], 0)] : [0, 0],
    width: clamp(num(p.width, 240), LIMITS.sticky),
    height: clamp(num(p.height, 160), LIMITS.sticky),
    color: color >= 1 && color <= 6 ? color : 0,
  };
}

function settingsFrom(raw: unknown, warn: (m: string) => void): WorkflowSettings | undefined {
  if (!isObject(raw)) return undefined;
  const settings: WorkflowSettings = {};
  const timezone = str(raw.timezone);
  if (timezone && timezone !== 'DEFAULT' && timezone.length <= 64) settings.timezone = timezone;
  if (str(raw.errorWorkflow)) warn('Settings: the error workflow refers to an n8n workflow id; choose it again in the workflow settings.');
  const timeout = num(raw.executionTimeout, -1);
  if (timeout > 0) settings.timeoutSeconds = clamp(Math.round(timeout), LIMITS.timeout);
  const saved = (value: unknown) => (value === 'none' ? false : value === 'all' ? true : undefined);
  const success = saved(raw.saveDataSuccessExecution);
  const failed = saved(raw.saveDataErrorExecution);
  if (success !== undefined) settings.saveSuccessfulExecutions = success;
  if (failed !== undefined) settings.saveFailedExecutions = failed;
  if (typeof raw.saveManualExecutions === 'boolean') settings.saveManualExecutions = raw.saveManualExecutions;
  if (raw.callerPolicy === 'any' || raw.callerPolicy === 'none') settings.callerPolicy = raw.callerPolicy;
  else if (raw.callerPolicy === 'workflowsFromAList') {
    settings.callerPolicy = 'list';
    settings.callerIds = (str(raw.callerIds) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    warn('Settings: the workflows allowed to call this one are n8n workflow ids; choose them again in the workflow settings.');
  }
  return Object.keys(settings).length ? settings : undefined;
}

function tagsFrom(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags = [...new Set(raw.map((t) => (isObject(t) ? str(t.name) : str(t))).filter((t): t is string => Boolean(t)))];
  return tags.length ? tags : undefined;
}

/** Convert an n8n workflow (or n8n clipboard JSON) to a Landflow workflow document. */
export function convertN8nWorkflow(doc: Params, options: ImportOptions = {}): ImportResult {
  const report: ImportReport = { format: 'n8n', mapped: [], placeholders: [], stickyNotes: 0, connections: 0, warnings: [] };
  const warn = (message: string) => report.warnings.push(message);
  const rawNodes = list(doc.nodes).filter((n): n is Params & N8nNode => typeof n.type === 'string' && typeof n.name === 'string');
  const stickyType = `${B}stickyNote`;

  const stickyNotes = rawNodes.filter((n) => n.type === stickyType).map(stickyFrom);
  const stickyNames = new Set(rawNodes.filter((n) => n.type === stickyType).map((n) => n.name));
  report.stickyNotes = stickyNotes.length;

  const taken = new Set<string>();
  const byName = new Map<string, Built>();
  for (const raw of rawNodes.filter((n) => n.type !== stickyType)) {
    if (raw.credentials && isObject(raw.credentials)) {
      for (const type of Object.keys(raw.credentials)) warn(`${raw.name}: credential ${type} dropped — pick a saved credential in the node.`);
    }
    const name = uniqueName(raw.name, taken);
    if (name !== raw.name) warn(`${raw.name}: renamed to “${name}” (the name was already used).`);
    if (!byName.has(raw.name)) byName.set(raw.name, convertNode(raw, name, options, report, warn));
  }

  // Connections: { [sourceName]: { [type]: [ [ { node, type, index } ] per output ] } }
  const connections: WorkflowConnection[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<WorkflowConnection, 'id'>) => {
    const key = `${c.type}|${c.source}|${c.sourceIndex}|${c.target}|${c.targetIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    connections.push({ id: `e_${nanoid(8)}`, ...c });
  };
  const hasInput = (built: Built, type: string) => !built.descriptor || built.descriptor.inputs.some((p) => p.type === type);
  const hasOutput = (built: Built, type: string) =>
    !built.descriptor || built.descriptor.outputs.some((p) => p.type === type) || (type === 'ai_tool' && Boolean(built.descriptor.usableAsTool));
  const mainCount = (ports: Array<{ type: string }>) => ports.filter((p) => p.type === 'main').length;

  for (const [sourceName, byType] of Object.entries(isObject(doc.connections) ? doc.connections : {})) {
    if (!isObject(byType)) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((targets, outputIndex) => {
        for (const t of list(targets)) {
          const targetName = text(t.node);
          const source = byName.get(sourceName);
          const target = byName.get(targetName);
          const label = `${sourceName} → ${targetName}`;
          if (!source || !target) {
            if (!stickyNames.has(sourceName) && !stickyNames.has(targetName)) warn(`Connection ${label} dropped: a node is missing.`);
            continue;
          }
          if (type === 'main') {
            const sourceIndex = source.outputMap ? source.outputMap(outputIndex) : outputIndex;
            let targetIndex = Math.max(0, num(t.index, 0));
            if (sourceIndex === undefined || (source.placeholder && sourceIndex > 0)) {
              warn(`Connection ${label} dropped: output ${outputIndex + 1} of “${sourceName}” has no Landflow equivalent.`);
              continue;
            }
            if (target.placeholder && targetIndex > 0) {
              warn(`Connection ${label} now goes to the placeholder's only input.`);
              targetIndex = 0;
            }
            if (source.descriptor && sourceIndex >= mainCount(source.descriptor.outputs)) {
              warn(`Connection ${label} dropped: “${sourceName}” has no output ${sourceIndex + 1} in Landflow.`);
              continue;
            }
            if (target.descriptor && targetIndex >= mainCount(target.descriptor.inputs)) {
              warn(`Connection ${label} dropped: “${targetName}” has no input ${targetIndex + 1} in Landflow.`);
              continue;
            }
            add({ type: 'main', source: source.node.id, sourceIndex, target: target.node.id, targetIndex });
          } else if (AI_TYPES.has(type)) {
            if (source.placeholder || target.placeholder) {
              warn(`Connection ${label} (${type}) dropped: placeholders can't be sub-nodes.`);
              continue;
            }
            if (!hasOutput(source, type) || !hasInput(target, type)) {
              warn(`Connection ${label} (${type}) dropped: the Landflow nodes can't be connected that way.`);
              continue;
            }
            add({ type: type as ConnectionType, source: source.node.id, sourceIndex: 0, target: target.node.id, targetIndex: 0 });
          } else {
            warn(`Connection ${label} (${type}) dropped: Landflow has no ${type.replace(/^ai_/, '')} sub-nodes yet.`);
          }
        }
      });
    }
  }
  report.connections = connections.length;

  // Pin data is keyed by node name in n8n.
  const pinData: Record<string, Array<{ json: Record<string, unknown> }>> = {};
  for (const [name, entries] of Object.entries(isObject(doc.pinData) ? doc.pinData : {})) {
    const built = byName.get(name);
    if (!built || built.placeholder || !Array.isArray(entries)) continue;
    pinData[built.node.id] = entries.filter(isObject).map((e) => ({ json: isObject(e.json) ? e.json : e }));
  }

  const settings = settingsFrom(doc.settings, warn);
  const tags = tagsFrom(doc.tags);
  const nodes = [...byName.values()].map((b) => b.node);
  report.warnings = [...new Set(report.warnings)];
  return {
    workflow: {
      name: str(doc.name)?.trim() || 'Imported workflow',
      nodes,
      connections,
      ...(Object.keys(pinData).length && { pinData: pinData as Workflow['pinData'] }),
      ...(settings && { settings }),
      ...(stickyNotes.length && { stickyNotes }),
      ...(tags && { tags }),
    },
    report,
  };
}

// ---------------------------------------------------------------------------
// Landflow JSON
// ---------------------------------------------------------------------------

/** A Landflow export (or a GET /api/workflows/:id response): ids kept, server-owned fields dropped. */
export function convertLandflowWorkflow(doc: Params): ImportResult {
  const report: ImportReport = { format: 'landflow', mapped: [], placeholders: [], stickyNotes: 0, connections: 0, warnings: [] };
  const taken = new Set<string>();
  const ids = new Set<string>();
  const nodes: WorkflowNode[] = list(doc.nodes).map((raw, i) => {
    if (typeof raw.type !== 'string' || !Array.isArray(raw.position)) throw new Error(`Node ${i + 1} needs a "type" and a "position" [x, y]`);
    const id = str(raw.id) && /^[\w-]+$/.test(String(raw.id)) && !ids.has(String(raw.id)) ? String(raw.id) : `n_${nanoid(8)}`;
    ids.add(id);
    const original = text(raw.name) || raw.type;
    const name = uniqueName(original, taken);
    if (name !== original) report.warnings.push(`${original}: renamed to “${name}” (the name was already used).`);
    report.mapped.push({ name, from: raw.type, to: raw.type });
    return {
      ...(raw as unknown as WorkflowNode),
      id,
      name,
      typeVersion: Math.max(1, Math.round(num(raw.typeVersion, 1))),
      position: [num(raw.position[0], 0), num(raw.position[1], 0)],
      parameters: isObject(raw.parameters) ? raw.parameters : {},
    };
  });
  const connections: WorkflowConnection[] = [];
  for (const raw of list(doc.connections)) {
    const source = str(raw.source);
    const target = str(raw.target);
    if (!source || !target || !ids.has(source) || !ids.has(target)) {
      report.warnings.push(`A connection to a missing node was dropped.`);
      continue;
    }
    connections.push({
      id: str(raw.id) ?? `e_${nanoid(8)}`,
      type: (str(raw.type) ?? 'main') as ConnectionType,
      source,
      sourceIndex: Math.max(0, num(raw.sourceIndex, 0)),
      target,
      targetIndex: Math.max(0, num(raw.targetIndex, 0)),
    });
  }
  const stickyNotes = list(doc.stickyNotes).map((s) => ({
    id: str(s.id) ?? `s_${nanoid(8)}`,
    content: text(s.content).slice(0, LIMITS.stickyContent),
    position: (Array.isArray(s.position) ? [num(s.position[0], 0), num(s.position[1], 0)] : [0, 0]) as [number, number],
    width: clamp(num(s.width, 240), LIMITS.sticky),
    height: clamp(num(s.height, 160), LIMITS.sticky),
    ...(s.color !== undefined && { color: clamp(Math.round(num(s.color, 0)), [0, 9]) }),
  }));
  report.stickyNotes = stickyNotes.length;
  report.connections = connections.length;
  report.warnings = [...new Set(report.warnings)];
  const pinData = isObject(doc.pinData) ? Object.fromEntries(Object.entries(doc.pinData).filter(([id]) => ids.has(id))) : undefined;
  return {
    workflow: {
      name: str(doc.name)?.trim() || 'Imported workflow',
      ...(typeof doc.description === 'string' && { description: doc.description }),
      nodes,
      connections,
      ...(pinData && Object.keys(pinData).length && { pinData: pinData as Workflow['pinData'] }),
      ...(isObject(doc.settings) && { settings: doc.settings as WorkflowSettings }),
      ...(stickyNotes.length && { stickyNotes }),
      ...(Array.isArray(doc.tags) && { tags: doc.tags.filter((t): t is string => typeof t === 'string') }),
    },
    report,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const N8N_TYPE = /^(n8n-nodes-|@n8n\/)/;

/** Parse and unwrap: a JSON string, `{ workflow: {...} }` or a one-element array → the workflow object. */
function unwrap(input: unknown): Params {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error(`The text isn't valid JSON: ${(error as Error).message}`);
    }
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error(value.length ? `The file holds ${value.length} workflows; import them one at a time.` : 'The file is an empty list.');
    value = value[0];
  }
  if (isObject(value) && !Array.isArray(value.nodes)) {
    if (isObject(value.workflow)) value = value.workflow;
    else if (isObject(value.data) && Array.isArray(value.data.nodes)) value = value.data;
  }
  if (!isObject(value) || !Array.isArray(value.nodes)) {
    throw new Error('This isn\'t a workflow: expected JSON with a "nodes" list (a Landflow export, an n8n workflow, or nodes copied in n8n).');
  }
  return value;
}

/**
 * Import workflow JSON. Landflow's format (connections as an array) keeps its ids; n8n's (connections keyed by node
 * name, also n8n's clipboard JSON) is converted. Throws a readable Error for anything else.
 */
export function importWorkflowJson(input: unknown, options: ImportOptions = {}): ImportResult {
  const doc = unwrap(input);
  const nodes = list(doc.nodes);
  const landflow = Array.isArray(doc.connections) || (doc.connections === undefined && nodes.every((n) => typeof n.id === 'string' && !N8N_TYPE.test(text(n.type))));
  if (landflow) return convertLandflowWorkflow(doc);
  if (doc.connections !== undefined && !isObject(doc.connections)) throw new Error('"connections" must be an object (n8n) or a list (Landflow).');
  return convertN8nWorkflow(doc, options);
}
