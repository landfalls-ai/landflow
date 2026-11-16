/**
 * The first draft's guards (docs/assistant.md, "The empty canvas"): the ones the chat puts on a proposal, applied to
 * the builder's whole draft. Made-up ids, channels, tables, owners, addresses and URL hosts are cleared and listed; a
 * draft keeps one trigger and no empty Set; each step that needs a credential says so (the person picks it).
 * Pure: the route calls it after `buildFlow`.
 */
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { mergeLeft, type DraftLeft } from '@/lib/shared/draft-left';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { pinsOnTrigger, type FlowDraft } from '../flow-builder';
import { withoutInventedIds } from './guards';

export type GuardedDraft = FlowDraft & { left?: DraftLeft[] };

export interface DraftGuardContext {
  /** What the person typed. */
  prompt: string;
  /** Everything the person or the roster gave: the prompt and the published agents' and teams' descriptions. */
  known: string;
  byType: (type: string) => NodeTypeInfo | undefined;
  /** A credential type's display name ("Slack API") by its name; without it the name itself is said. */
  credentialName?: (name: string) => string | undefined;
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
  /** Names of steps this guard removed: what the builder said was left for them goes too. */
  const removed = new Set<string>();
  // A step of a type this workflow can't use (or doesn't exist) was already left out by the builder: say so.
  for (const line of draft.dropped) {
    const missing = /^node (.*) \(([^)]*)\)$/.exec(line);
    if (missing) mine.push({ node: missing[1], kind: 'dropped', text: `“${missing[1]}”: ${missing[2] === 'no type' ? 'a step with no type' : `a ${missing[2]} step that could not be used`} was left out` });
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
      // Every target the kept trigger doesn't already feed is wired to it, so no step is left unreachable.
      for (const [, to, output] of targets) {
        if (!edges.some(([f, t, , ty]) => f === keep.key && t === to && ty === 'main')) edges.push([keep.key, to, output, 'main']);
      }
      edges = edges.filter(([from, to]) => from !== gone.key && to !== gone.key);
      nodes = nodes.filter((n) => n !== gone);
      if (pinData?.[gone.key]) {
        // The pin moves to the kept trigger only where a pin on that trigger is what the builder would have made: a schedule's
        // own item is only a time, and the dropped trigger's sample (a webhook's body) would not be what it puts out.
        const { [gone.key]: items, ...rest } = pinData;
        pinData = pinsOnTrigger(keep.type, ctx.byType(keep.type)) ? { [keep.key]: items, ...rest } : rest;
      }
      removed.add(gone.name);
      mine.push({ node: gone.name, kind: 'dropped', text: `“${gone.name}”: a flow starts from one trigger, so it was left out and “${keep.name}” kept` });
    }
  }

  // No empty Set (1.6): nothing to set and no step reads it.
  for (const set of nodes.filter((n) => n.type === 'core.set')) {
    // A Set with no `fields` at all counts as empty too (the editor would add a default "greeting" field, which is junk
    // nobody asked for), so it is removed like one with an empty list.
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
    removed.add(set.name);
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
    if (!info) continue;
    // As the chat's credentialWarnings: a slot counts when it is required and shown for this step's parameters.
    const parameters = withPropertyDefaults(info.descriptor.properties, n.parameters ?? {});
    for (const c of info.descriptor.credentials ?? []) {
      if (!c.required || !isPropertyVisible(c, parameters)) continue;
      const label = ctx.credentialName?.(c.name) ?? c.name;
      mine.push({ node: n.name, field: 'credential', kind: 'credential', text: `“${n.name}” needs a ${label} credential: pick one` });
    }
  }

  return { ...draft, nodes, edges, pinData, left: mergeLeft(draft.left?.filter((l) => !removed.has(l.node)), mine) };
}
