/**
 * Spotlight's suggestion bubbles in the editor (docs/assistant.md): what to offer while the box is empty, and how to
 * complete what is being typed (a sentence, an `@` node on the canvas, or a node type the workflow may use). Pure and
 * model-free, so the bubbles change with every key.
 */

export interface SpotlightNode {
  id: string;
  name: string;
  type: string;
  trigger: boolean;
  /** An AI Agent (or any node with a chat-model port). */
  agent: boolean;
  /** For an agent: a chat model is connected. */
  hasModel: boolean;
  /** Has a connection out: a main one, or to an agent as its model, memory or a tool. */
  outgoing: boolean;
  /** Its last run failed. */
  failed: boolean;
  /** Horizontal position: the right-most node without a connection out is where the flow ends. */
  x: number;
}

export interface SpotlightType {
  type: string;
  displayName: string;
  plugin: string;
  trigger: boolean;
  keywords: string[];
}

export interface SpotlightContext {
  nodes: SpotlightNode[];
  /** The node types this workflow may use: online, and not blocked by governance. */
  types: SpotlightType[];
  selectedId?: string;
  /** How Spotlight's last test session ended: what to offer next follows from it. */
  outcome?: 'needs' | 'passed' | 'stopped';
}

export type Mention = { kind: 'node'; id: string; label: string } | { kind: 'type'; type: string; label: string };

export interface Bubble {
  id: string;
  label: string;
  /** A muted second part: the plugin of a node type, "on the canvas" for a node. */
  hint?: string;
  kind: 'ask' | 'node' | 'type';
  /** The whole box after choosing it. */
  text: string;
  /** Where the caret goes in `text` after choosing it. */
  caret: number;
  /** A complete question or request: choosing it sends it. Otherwise it fills the box to finish. */
  send?: boolean;
  mention?: Mention;
}

const has = (ctx: SpotlightContext, type: string) => ctx.types.some((t) => t.type === type);
const quote = (name: string) => `“${name}”`;

/** The bubble that starts a test-and-fix session instead of asking something. */
export const TEST_BUBBLE = 'test';

const ask = (id: string, label: string, send = true): Bubble => ({ id, label, kind: 'ask', text: label, caret: label.length, send });

/** Where the flow ends: the right-most node with nothing connected out (an agent's tools connect to the agent). */
function lastNode(ctx: SpotlightContext): SpotlightNode | undefined {
  return ctx.nodes.filter((n) => !n.outgoing).sort((a, b) => b.x - a.x)[0];
}

/** Every sentence Spotlight offers for this canvas, most useful first. */
function phrases(ctx: SpotlightContext): Bubble[] {
  if (!ctx.nodes.length) {
    const out: Bubble[] = [];
    if (has(ctx, 'core.webhook')) out.push(ask('start-webhook', 'When a webhook is called, ', false));
    if (has(ctx, 'core.schedule')) out.push(ask('start-schedule', 'Every morning at 9, ', false));
    if (has(ctx, 'core.chatTrigger') && has(ctx, 'core.aiAgent')) out.push(ask('start-chat', 'Answer chat messages with an AI agent'));
    if (has(ctx, 'core.httpRequest')) out.push(ask('start-api', 'Fetch a JSON API and keep the items where ', false));
    return out;
  }
  const out: Bubble[] = [];
  const failed = ctx.nodes.find((n) => n.failed);
  if (failed) out.push(ask(`why-${failed.id}`, `Why did ${quote(failed.name)} fail?`));
  const agent = ctx.nodes.find((n) => n.agent && !n.hasModel);
  if (agent) out.push(ask(`model-${agent.id}`, `Connect a chat model to ${quote(agent.name)}`));
  const last0 = lastNode(ctx);
  if (ctx.outcome === 'passed' && last0) out.push(ask(`harden-${last0.id}`, `Add error handling to ${quote(last0.name)}`));
  if (ctx.outcome === 'stopped' && failed) out.push(ask(`another-${failed.id}`, `Try another way to fix ${quote(failed.name)}`));
  const selected = ctx.nodes.find((n) => n.id === ctx.selectedId);
  if (selected) out.push(ask(`explain-${selected.id}`, `Explain ${quote(selected.name)}`));
  if (!ctx.nodes.some((n) => n.trigger)) out.push(ask('trigger', 'Add a trigger that starts this workflow'));
  // Not a question: Spotlight runs the workflow and, while a run fails, fixes it (see testUntilItRuns). Not while it
  // waits for the person (a credential, a yes), nor right after a pass.
  else if (!ctx.outcome) out.push({ ...ask(TEST_BUBBLE, 'Test it and fix what fails'), send: false });
  const last = selected && !selected.outgoing ? selected : lastNode(ctx);
  if (last) out.push(ask(`after-${last.id}`, `After ${quote(last.name)}, `, false));
  out.push(ask('explain', 'What does this workflow do?'));
  return out;
}

/** What to offer while the box is empty: at most `limit`, so the canvas stays quiet. */
export function idleBubbles(ctx: SpotlightContext, limit = 3): Bubble[] {
  return phrases(ctx).slice(0, limit);
}

/** The `@` mention being typed at the caret: from the `@` to the caret, spaces allowed while a node name still fits. */
export function mentionAt(text: string, caret: number, names: string[]): { start: number; query: string } | undefined {
  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0 || (start > 0 && !/\s/.test(text[start - 1]))) return undefined;
  const query = text.slice(start + 1, caret);
  if (query.length > 60 || /\n/.test(query)) return undefined;
  if (/\s/.test(query) && !names.some((n) => n.toLowerCase().startsWith(query.toLowerCase()))) return undefined;
  return { start, query };
}

/** The word being typed at the caret. */
export function wordAt(text: string, caret: number): { start: number; word: string } {
  const before = text.slice(0, caret);
  const match = /[\p{L}\p{N}_-]+$/u.exec(before);
  return match ? { start: caret - match[0].length, word: match[0] } : { start: caret, word: '' };
}

const splice = (text: string, start: number, end: number, insert: string) => {
  const rest = text.slice(end);
  const glue = rest.startsWith(' ') ? '' : ' ';
  const out = `${text.slice(0, start)}${insert}${glue}${rest}`;
  return { text: out, caret: start + insert.length + glue.length };
};

function rank(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 4;
  if (n.startsWith(q)) return 3;
  if (n.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2;
  return n.includes(q) ? 1 : 0;
}

/** Bubbles that finish what is in the box at `caret`: whole sentences first, then `@` nodes and node types. */
export function completeBubbles(text: string, caret: number, ctx: SpotlightContext, limit = 4): Bubble[] {
  const out: Bubble[] = [];
  const mention = mentionAt(text, caret, ctx.nodes.map((n) => n.name));
  if (mention) {
    return ctx.nodes
      .map((n) => ({ n, score: mention.query ? rank(n.name, mention.query) : 1 }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.n.name.localeCompare(b.n.name))
      .slice(0, limit)
      .map(({ n }) => {
        const label = `@${n.name}`;
        const next = splice(text, mention.start, caret, label);
        return { id: `node-${n.id}`, label, hint: 'on the canvas', kind: 'node' as const, ...next, mention: { kind: 'node' as const, id: n.id, label } };
      });
  }

  // A sentence that starts with what was typed.
  const typed = text.trimStart().toLowerCase();
  const sentences = typed.length >= 2 && caret === text.length ? phrases(ctx).filter((p) => p.text.toLowerCase().startsWith(typed) && p.text.length > typed.length) : [];
  out.push(...sentences.slice(0, 2));

  const { start, word } = wordAt(text, caret);
  if (word.length >= 2) {
    const types = ctx.types
      .map((t) => ({ t, score: Math.max(rank(t.displayName, word) * 2, ...t.keywords.map((k) => rank(k, word)), rank(t.plugin, word)) }))
      .filter((m) => m.score >= 2)
      .sort((a, b) => b.score - a.score || a.t.displayName.localeCompare(b.t.displayName))
      .slice(0, 2);
    // After the selected node (the one just added, after an Apply), else where the flow ends.
    const last = ctx.nodes.find((n) => n.id === ctx.selectedId) ?? lastNode(ctx);
    for (const { t } of types) {
      // "slack" with a flow already there: offer the whole step too.
      if (last && !t.trigger && typed === word.toLowerCase()) {
        const label = `Add ${t.displayName} after ${quote(last.name)}`;
        out.push({ id: `add-${t.type}`, label, kind: 'ask', text: label, caret: label.length, send: true, mention: { kind: 'type', type: t.type, label: t.displayName } });
      }
      const next = splice(text, start, caret, t.displayName);
      out.push({ id: `type-${t.type}`, label: t.displayName, hint: t.plugin, kind: 'type', ...next, mention: { kind: 'type', type: t.type, label: t.displayName } });
    }
    const node = ctx.nodes.find((n) => rank(n.name, word) >= 3);
    if (node) {
      const label = `@${node.name}`;
      out.push({ id: `node-${node.id}`, label, hint: 'on the canvas', kind: 'node', ...splice(text, start, caret, label), mention: { kind: 'node', id: node.id, label } });
    }
  }
  const seen = new Set<string>();
  return out.filter((b) => !seen.has(b.text) && seen.add(b.text)).slice(0, limit);
}

/** The mentions still in the message: a chosen bubble whose text was deleted afterwards no longer counts. */
export function liveMentions(text: string, mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = m.kind === 'node' ? `n:${m.id}` : `t:${m.type}`;
    if (seen.has(key) || !text.includes(m.label)) return false;
    seen.add(key);
    return true;
  });
}
