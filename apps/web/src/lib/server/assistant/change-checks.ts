/**
 * Checks that a change means what its card says (SB09, wave sb2). Each one reads the ops of a proposal against the
 * workflow before and after, and returns one line per problem, worded for the model (docs/assistant.md "The builder
 * chat"). They run on every proposal, inside or outside a scope, and never widen it. Pure: no I/O.
 */
import type { AssistantOp, DescriptorLookup, RunDigest } from '@/lib/shared/assistant-ops';
import type { Workflow } from '@/lib/shared/types';
import { parseCron } from '../agents/cron';

type Node = Workflow['nodes'][number];

export interface CheckContext {
  /** The latest message of the person, lower-cased or not. */
  latest?: string;
  /** The last run of each step, by node id. */
  runs?: Record<string, RunDigest>;
  /** The node descriptors, for output schemas. */
  lookup?: DescriptorLookup;
}

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const byRef = (wf: Workflow, ref: string): Node | undefined => wf.nodes.find((n) => n.name === ref || n.id === ref);

/** The parameters an op sets, and the step they go to. */
function parametersOf(op: AssistantOp, after: Workflow): { node: Node | undefined; name: string; parameters: Record<string, unknown> } | undefined {
  if (op.op === 'setParameters') return { node: byRef(after, op.node), name: op.node, parameters: op.parameters };
  if (op.op === 'addNode' && op.parameters) {
    const name = op.name ?? op.type;
    return { node: byRef(after, name), name, parameters: op.parameters };
  }
  return undefined;
}

/** Every string inside a value, with the path it sits at. */
function strings(value: unknown, path: string[] = []): Array<{ path: string[]; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, String(i)]));
  const o = record(value);
  return o ? Object.entries(o).flatMap(([k, v]) => strings(v, [...path, k])) : [];
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const ASKED_CONTINUE = /\b(continue|carry on|keep going|ignore|swallow|skip|don'?t (stop|fail|abort)|on error|on failure)\b/;
const ASKED_DISABLE = /\b(disable|turn (it )?off|switch (it )?off|bypass|skip|pause|deactivate)\b/;

/** What a retry change gets wrong: tries out of range or a wait too long, a contradiction, a setting nobody asked for. Reads the ops as proposed. */
export function retryProblems(ops: AssistantOp[], before: Workflow, _after: Workflow, context: CheckContext = {}): string[] {
  const latest = (context.latest ?? '').toLowerCase();
  const out: string[] = [];
  for (const op of ops) {
    if (op.op !== 'setNodeSettings') continue;
    const s = op.settings as Record<string, unknown>;
    const name = `“${op.node}”`;
    const tries = s.maxTries;
    if (tries !== undefined && (typeof tries !== 'number' || !Number.isInteger(tries) || tries > 10 || tries < 1)) out.push(`${name} maxTries ${JSON.stringify(tries)} is not a whole number from 1 to 10`);
    const wait = s.waitBetweenTriesMs;
    if (typeof wait === 'number' && wait > 60_000) out.push(`${name} waitBetweenTriesMs ${wait} is above the 60000 the engine waits at most`);
    if (s.retryOnFail === false && typeof tries === 'number' && tries > 1) out.push(`${name} has retryOnFail false and maxTries ${tries}: retry is either on with its tries, or off`);
    const was = byRef(before, op.node);
    if (s.onError === 'continue' && was?.onError !== 'continue' && !ASKED_CONTINUE.test(latest)) out.push(`${name} is set to continue on error, which the request did not ask for: the failure would be hidden`);
    if (s.disabled === true && !was?.disabled && !ASKED_DISABLE.test(latest)) out.push(`${name} is turned off, which the request did not ask for`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expressions against what the step receives
// ---------------------------------------------------------------------------

/** A JSON schema's field tree, or undefined when it names none. */
const schemaProps = (schema: unknown): Record<string, unknown> | undefined => record(record(schema)?.properties);

/** What one source (a run sample, pinned items, a schema) says about the fields at `path`: the names there, or undefined when unknown. */
function fieldsAt(sources: { samples: unknown[]; schemas: unknown[] }, path: string[]): string[] | undefined {
  const names = new Set<string>();
  let known = false;
  for (const sample of sources.samples) {
    let value: unknown = sample;
    for (const key of path) value = record(value)?.[key];
    const o = record(value);
    if (o) {
      known = true;
      for (const k of Object.keys(o)) names.add(k);
      if ('…' in o) return undefined;
    } else if (path.length === 0) return undefined;
  }
  for (const schema of sources.schemas) {
    let value: unknown = schema;
    for (const key of path) value = record(schemaProps(value)?.[key]);
    const props = schemaProps(value);
    if (props) {
      known = true;
      for (const k of Object.keys(props)) names.add(k);
    }
  }
  return known ? [...names] : undefined;
}

/** The samples and schemas that say what `node` outputs. */
function outputSources(node: Node, after: Workflow, context: CheckContext): { samples: unknown[]; schemas: unknown[] } {
  const samples: unknown[] = [];
  const schemas: unknown[] = [];
  for (const port of context.runs?.[node.id]?.outputs ?? []) samples.push(...port.sample);
  for (const item of after.pinData?.[node.id] ?? []) samples.push(item.json);
  const descriptor = context.lookup?.(node.type);
  if (descriptor) {
    const operation = String(node.parameters.operation ?? '');
    const option = descriptor.properties.filter((p) => p.name === 'operation').flatMap((p) => ('options' in p && Array.isArray(p.options) ? p.options : [])).find((o) => (o as { value?: unknown }).value === operation) as { outputSchema?: unknown } | undefined;
    const schema = option?.outputSchema ?? descriptor.outputSchema;
    if (schema) schemas.push(schema);
  }
  return { samples, schemas };
}

const JSON_READ = /\$json((?:\.[A-Za-z_$][\w$]*)+)/g;
const NODE_READ = /\$\(\s*['"]([^'"]+)['"]\s*\)\.(?:item|first\(\)|last\(\)|itemMatching\(\s*\d+\s*\))\.json((?:\.[A-Za-z_$][\w$]*)+)/g;

/**
 * The `$json.<path>` and `$('Name').item.json.<path>` reads of the expressions these ops write that name a field the
 * step's input (or the named step) does not have, by its last run, its pinned data and its output schema. A source with
 * none of the three is not checked.
 */
export function expressionMisses(ops: AssistantOp[], before: Workflow, after: Workflow, context: CheckContext = {}): string[] {
  const out: string[] = [];
  for (const op of ops) {
    const set = parametersOf(op, after);
    if (!set?.node) continue;
    const { node } = set;
    const was = op.op === 'setParameters' ? JSON.stringify(byRef(before, set.name)?.parameters ?? {}) : '';
    const texts = strings(set.parameters).filter((s) => s.text.includes('{{') && !was.includes(JSON.stringify(s.text).slice(1, -1)));
    if (!texts.length) continue;

    // What the step receives: the steps feeding it; where none says, its own last input.
    const feeders = after.connections.filter((c) => c.type === 'main' && c.target === node.id).map((c) => after.nodes.find((n) => n.id === c.source)).filter((n): n is Node => Boolean(n));
    const input = { samples: [] as unknown[], schemas: [] as unknown[] };
    let inputKnown = feeders.length > 0;
    for (const feeder of feeders) {
      const source = outputSources(feeder, after, context);
      if (!source.samples.length && !source.schemas.length) inputKnown = false;
      input.samples.push(...source.samples);
      input.schemas.push(...source.schemas);
    }
    if (!inputKnown) {
      input.samples.length = 0;
      input.schemas.length = 0;
      for (const port of context.runs?.[node.id]?.inputs ?? []) input.samples.push(...port.sample);
      inputKnown = input.samples.length > 0;
    }

    for (const { text } of texts) {
      for (const expression of text.match(/\{\{[\s\S]*?\}\}/g) ?? []) {
        for (const m of expression.matchAll(JSON_READ)) {
          if (!inputKnown) continue;
          const miss = missing(input, m[1].slice(1).split('.'));
          if (miss) out.push(`“${node.name}” reads $json${m[1]}, which its input has no field of (it has: ${miss.have.join(', ')})`);
        }
        for (const m of expression.matchAll(NODE_READ)) {
          const named = after.nodes.find((n) => n.name === m[1]);
          if (!named) continue;
          const source = outputSources(named, after, context);
          const miss = missing(source, m[2].slice(1).split('.'));
          if (miss) out.push(`“${node.name}” reads $('${m[1]}').item.json${m[2]}, which “${m[1]}” has no field of (it has: ${miss.have.join(', ')})`);
        }
      }
    }
  }
  return [...new Set(out)];
}

/** The fields the source has at the deepest known level, when `path` leaves them. */
function missing(sources: { samples: unknown[]; schemas: unknown[] }, path: string[]): { have: string[] } | undefined {
  for (let depth = 0; depth < path.length; depth++) {
    const have = fieldsAt(sources, path.slice(0, depth));
    if (!have) return undefined;
    if (!have.length) return undefined;
    if (!have.includes(path[depth])) return { have: have.slice(0, 12) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const NAMES_A_DAY = /\b(week ?days?|work ?days?|business days?|week ?ends?|mon(day)?s?|tue(s|sday)?s?|wed(nesday)?s?|thu(r|rs|rsday)?s?|fri(day)?s?|sat(urday)?s?|sun(day)?s?)\b/;
const SAYS_EVERY = /\b(every|each) (day|morning|evening|night|afternoon)\b|\bdaily\b/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "1-5" → "Mon–Fri"; whatever it cannot expand comes back as it was. */
function daysOf(field: string): string {
  try {
    const days = new Set<number>();
    for (const part of field.toLowerCase().split(',')) {
      const [range, step] = part.split('/');
      const num = (t: string) => {
        const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === t);
        return i >= 0 ? i : Number(t);
      };
      const [a, b] = range === '*' ? [0, 6] : range.split('-').map(num);
      for (let d = a; d <= (b ?? (step ? 6 : a)); d += Number(step ?? 1)) days.add(d % 7);
    }
    const list = [...days].sort((x, y) => x - y);
    if (list.length === 5 && list.join() === '1,2,3,4,5') return 'Mon–Fri';
    return list.map((d) => DAY_NAMES[d]).join(', ');
  } catch {
    return field;
  }
}

/** The cron expressions a schedule rule in these parameters sets. */
function cronsIn(parameters: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (record(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === 'expression' && typeof v === 'string') out.push(v);
        else walk(v);
      }
    }
  };
  walk(parameters);
  return out;
}

/** A schedule that does not parse, or that limits the days when the request named none. */
export function cronProblems(ops: AssistantOp[], before: Workflow, after: Workflow, context: CheckContext = {}): string[] {
  const latest = (context.latest ?? '').toLowerCase();
  const out: string[] = [];
  for (const op of ops) {
    const set = parametersOf(op, after);
    if (!set) continue;
    const type = set.node?.type ?? (op.op === 'addNode' ? op.type : '');
    if (!/schedule/i.test(type)) continue;
    const was = cronsIn(byRef(before, set.name)?.parameters ?? {});
    for (const expression of cronsIn(set.parameters)) {
      if (expression.includes('{{')) continue;
      try {
        parseCron(expression);
      } catch (e) {
        out.push(`“${set.name}” schedule “${expression}” does not work: ${(e as Error).message}`);
        continue;
      }
      const fields = expression.trim().split(/\s+/);
      const dow = fields[fields.length - 1];
      if (dow === '*' || NAMES_A_DAY.test(latest)) continue;
      const kept = was.some((w) => w.trim().split(/\s+/).pop() === dow);
      if (kept && !SAYS_EVERY.test(latest)) continue;
      out.push(`“${set.name}” schedule “${expression}” runs only on ${daysOf(dow)}; the request named no days (use * for the day of the week to run every day)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

const CREDENTIAL_AUTH = new Set(['genericCredentialType', 'predefinedCredentialType']);

/** The header rows a step's parameters carry: `{ header: [{ name, value }] }`. */
function headerRows(parameters: Record<string, unknown>): Array<{ name: string; value: string }> {
  const rows = record(parameters.headers)?.header;
  return Array.isArray(rows) ? rows.flatMap((r) => (record(r) && typeof record(r)?.name === 'string' ? [{ name: String(record(r)?.name), value: String(record(r)?.value ?? '') }] : [])) : [];
}

/**
 * `only: 'data'`: an Authorization header read from the data (`$json`, `$('…')`): a token is a credential the person
 * picks, never a field. `only: 'credential'`: a hand-written Authorization header on a step that already authenticates
 * with a credential (the engine lets the hand-written one win, so the credential is silently unused).
 */
export function authHeaderProblems(ops: AssistantOp[], before: Workflow, after: Workflow, _context: CheckContext = {}, only?: 'data' | 'credential'): string[] {
  const out: string[] = [];
  for (const op of ops) {
    const set = parametersOf(op, after);
    if (!set?.node) continue;
    const node = set.node;
    const was = headerRows(byRef(before, set.name)?.parameters ?? {});
    const rows = headerRows(node.parameters).filter((r) => /^authorization$/i.test(r.name) && !was.some((w) => w.name === r.name && w.value === r.value));
    if (!rows.length) continue;
    if (only !== 'credential' && rows.some((r) => /\$json|\$\(/.test(r.value))) out.push(`“${node.name}” builds its Authorization header from the data: use a credential (the person picks it), not a header read from the data`);
    const credentialed = CREDENTIAL_AUTH.has(String(node.parameters.authentication ?? '')) || Object.keys(node.credentials ?? {}).length > 0;
    if (only !== 'data' && credentialed) out.push(`“${node.name}” has a credential and a hand-written Authorization header: the header wins, so the credential is not used`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

const URL_KEYS = /^(url|uri|baseurl|endpoint|webhookurl|host|hostname|server)$/i;
const TARGET_KEYS = /^(channel|channelid|channelname|chatid|to|tomail|toemail|cc|bcc|email|recipient|recipients|address|table|tablename|tableid|datatableid|database|bucket|topic|queue)$/i;

function hostOf(value: string): string | undefined {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Where a step sends to, changed on an existing step: a URL's host or port, a channel, an address or a table. A host
 * that blocks an address is not a reason to move the destination (the httpbin incident, lesson 21): suggestions that
 * do it keep their words and lose their ops. One line per change.
 */
export function destinationChanges(ops: AssistantOp[], workflow: Workflow): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.op !== 'setParameters') continue;
    const node = byRef(workflow, op.node);
    if (!node) continue;
    const walk = (now: unknown, then: unknown, key: string) => {
      const o = record(now);
      if (o) {
        const prior = record(then);
        for (const [k, v] of Object.entries(o)) walk(v, prior?.[k], k);
        return;
      }
      if (typeof now !== 'string' || typeof then !== 'string' || !then.trim() || now === then) return;
      if (URL_KEYS.test(key)) {
        const [a, b] = [hostOf(then), hostOf(now)];
        if (a && b && a !== b && !now.includes('{{') && !then.includes('{{')) out.push(`“${node.name}” ${key}: ${a} → ${b}`);
      } else if (TARGET_KEYS.test(key) && now.trim().toLowerCase() !== then.trim().toLowerCase()) out.push(`“${node.name}” ${key}: ${then} → ${now}`);
    };
    walk(op.parameters, node.parameters, '');
  }
  return out;
}
