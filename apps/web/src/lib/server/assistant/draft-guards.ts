/**
 * The first draft's guards (docs/assistant.md, "The empty canvas"): the ones the chat puts on a proposal, applied to
 * the builder's whole draft. Made-up ids, channels, tables, owners, addresses and URL hosts are cleared and listed; a
 * draft keeps one trigger and no empty Set; each step that needs a credential says so (the person picks it).
 * Pure: the route calls it after `buildFlow`.
 */
import { mergeLeft, type DraftLeft } from '@/lib/shared/draft-left';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { FlowDraft } from '../flow-builder';
import { withoutInventedIds } from './guards';

export type GuardedDraft = FlowDraft & { left?: DraftLeft[] };

export interface DraftGuardContext {
  /** What the person typed. */
  prompt: string;
  /** Everything the person or the roster gave: the prompt and the published agents' and teams' descriptions. */
  known: string;
  byType: (type: string) => NodeTypeInfo | undefined;
}

/** The words a prompt uses for each kind of trigger. */
const TRIGGER_WORDS: Record<string, RegExp> = {
  schedule: /\b(schedul\w*|every|each\s+(?:day|morning|week|month|hour)|daily|hourly|weekly|monthly|nightly|morning|cron|at \d{1,2}(?::\d\d)?\s*(?:am|pm)?)\b/i,
  webhook: /\b(webhooks?|endpoint|callback)\b|\bhttp (?:call|request|post)s?\b/i,
  chat: /\bchat\b/i,
  manual: /\b(manual(?:ly)?|by hand|button|click)\b/i,
};

function names(info: NodeTypeInfo | undefined, prompt: string): boolean {
  if (!info) return false;
  const { triggerSource } = info.descriptor;
  if (triggerSource && TRIGGER_WORDS[triggerSource]?.test(prompt)) return true;
  if (/form/i.test(info.type) && /\bforms?\b/i.test(prompt)) return true;
  // An app's own trigger (poll, appWebhook): the app's name in the prompt.
  const app = info.pluginName.toLowerCase();
  return Boolean(info.pluginId !== 'core' && app.length > 2 && prompt.toLowerCase().includes(app));
}

export function guardDraft(draft: GuardedDraft, ctx: DraftGuardContext): GuardedDraft {
  const mine: DraftLeft[] = [];
  // A step of a type this workflow can't use (or doesn't exist) was already left out by the builder: say so.
  for (const line of draft.dropped) {
    const missing = /^node (.*) \(([^)]*)\)$/.exec(line);
    if (missing) mine.push({ node: missing[1], kind: 'dropped', text: `“${missing[1]}”: ${missing[2] === 'no type' ? 'a step with no type' : `a ${missing[2]} step this workflow can’t use`} was left out` });
  }
  let nodes = draft.nodes.map((n) => ({ ...n }));
  let edges = draft.edges.map((e) => [...e] as FlowDraft['edges'][number]);
  let pinData = draft.pinData;

  // One trigger (1.6): the one the prompt names, else the first.
  const triggers = nodes.filter((n) => ctx.byType(n.type)?.descriptor.kind === 'trigger');
  if (triggers.length > 1) {
    const keep = triggers.find((n) => names(ctx.byType(n.type), ctx.prompt)) ?? triggers[0];
    for (const gone of triggers.filter((n) => n !== keep)) {
      const targets = edges.filter(([from, , , type]) => from === gone.key && type === 'main');
      const keptFeeds = edges.some(([from, , , type]) => from === keep.key && type === 'main');
      if (!keptFeeds) for (const [, to, output] of targets) edges.push([keep.key, to, output, 'main']);
      edges = edges.filter(([from, to]) => from !== gone.key && to !== gone.key);
      nodes = nodes.filter((n) => n !== gone);
      if (pinData?.[gone.key]) {
        const { [gone.key]: items, ...rest } = pinData;
        pinData = { [keep.key]: items, ...rest };
      }
      mine.push({ node: gone.name, kind: 'dropped', text: `“${gone.name}”: a flow starts from one trigger, so it was left out and “${keep.name}” kept` });
    }
  }

  // No empty Set (1.6): nothing to set and no step reads it.
  for (const set of nodes.filter((n) => n.type === 'core.set')) {
    const p = set.parameters ?? {};
    const fields = (p.fields as { values?: unknown[] } | undefined)?.values;
    if ((p.mode ?? 'manual') !== 'manual' || (Array.isArray(fields) && fields.length) || (fields !== undefined && !Array.isArray(fields))) continue;
    const readsIt = nodes.some((n) => n !== set && n.parameters && JSON.stringify(n.parameters).includes('{{') && JSON.stringify(n.parameters).includes(set.name));
    if (readsIt) continue;
    const into = edges.filter(([, to, , type]) => to === set.key && type === 'main');
    const out = edges.filter(([from, , , type]) => from === set.key && type === 'main');
    edges = edges.filter(([from, to]) => from !== set.key && to !== set.key);
    for (const [from, , output] of into) for (const [, to] of out) if (!edges.some(([f, t, o, ty]) => f === from && t === to && o === output && ty === 'main')) edges.push([from, to, output, 'main']);
    nodes = nodes.filter((n) => n !== set);
    mine.push({ node: set.name, kind: 'dropped', text: `“${set.name}”: it set no fields and nothing reads it, so it was left out` });
  }

  // Made-up values (1.3), as the chat reads a proposal.
  nodes = nodes.map((n) => {
    if (!n.parameters || !Object.keys(n.parameters).length) return n;
    const typeText = () => JSON.stringify(ctx.byType(n.type)?.descriptor.properties ?? []);
    const { ops, values } = withoutInventedIds([{ op: 'addNode', type: n.type, name: n.name, parameters: n.parameters }], ctx.known, typeText);
    const cleared = (ops as Array<{ parameters: Record<string, unknown> }>)[0].parameters;
    for (const [field, value] of Object.entries(n.parameters)) {
      if (field in cleared) continue;
      const shown = typeof value === 'string' ? ` “${value.length > 40 ? `${value.slice(0, 40)}…` : value}”` : '';
      const url = /url$/i.test(field);
      mine.push({ node: n.name, field, kind: 'made-up', text: `“${n.name}”: ${field}${shown} was made up: ${url ? 'give the address' : `pick the ${field}`}` });
    }
    return values.length ? { ...n, parameters: cleared } : n;
  });

  // Credentials: the person picks one; a draft never holds one.
  for (const n of nodes) {
    const info = ctx.byType(n.type);
    if (!info?.descriptor.credentials?.some((c) => c.required !== false)) continue;
    mine.push({ node: n.name, field: 'credential', kind: 'credential', text: `“${n.name}” needs a ${info.pluginName} credential: pick one` });
  }

  return { ...draft, nodes, edges, pinData, left: mergeLeft(draft.left, mine) };
}
