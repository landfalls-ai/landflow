/**
 * What differs between two agent configs, in words (docs/assistant.md "Changing an agent"): the lines of
 * `AgentCard.changes` that Spotlight shows under a revised card or an existing agent's change card. Pure, no import: the
 * browser and the design route read the same words. An empty list is "no change": the card offers nothing to apply.
 */
type Config = Record<string, unknown>;
type Tool = Record<string, unknown>;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A tool as the card names it: its own name, else its node type, else its kind. */
function toolName(tool: Tool): string {
  return str(tool.name) || str(tool.nodeType) || str(tool.type) || 'tool';
}

/** A tool's name as a person reads it: the architect's `get_alert_details` is “Get Alert Details”; a name with spaces or capitals is the person's own. */
const shown = (name: string): string => (/^[a-z0-9_]+$/.test(name) ? name.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : name);

const operationOf = (tool: Tool): string => str(record(tool.parameters).operation);

/** `provider/model` of an agent's model. */
function modelOf(config: Config): string {
  const model = record(config.model);
  return str(model.model) ? `${str(model.provider) ? `${str(model.provider)}/` : ''}${str(model.model)}` : '';
}

const WHERE: Record<string, string> = { input: 'messages', output: 'answers', toolResult: 'tool results' };
const CHECKS: Record<string, string> = { pii: 'personal data', secrets: 'secrets', keywords: 'listed words', urls: 'links', jailbreak: 'prompt injection', topical: 'off-topic requests', nsfw: 'unsafe content', grounded: 'unsupported answers' };

/** The guardrails that are on, as "<check> in <where>" with their action: compared as sets, so a reorder is no change. */
function guardrailSet(config: Config): Map<string, string> {
  const out = new Map<string, string>();
  const rules = record(config.guardrails);
  for (const place of Object.keys(WHERE)) {
    const rule = record(rules[place]);
    if (!rule.enabled) continue;
    const verb = rule.action === 'block' ? 'blocking' : 'masking';
    const checks = record(rule.checks);
    for (const check of Object.keys(CHECKS)) if (checks[check]) out.set(`${check}:${place}`, `${verb} ${CHECKS[check]} in ${WHERE[place]}`);
  }
  return out;
}

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** How many lines of `after` are not in `before` plus how many of `before` are not in `after`. */
function linesChanged(before: string, after: string): number {
  const a = lines(before);
  const b = lines(after);
  return a.filter((l) => !b.includes(l)).length + b.filter((l) => !a.includes(l)).length;
}

/** What `after` changes from `before`, one line each; empty when nothing the card shows changed. */
export function agentChanges(before: Config, after: Config): string[] {
  const out: string[] = [];
  const was = (Array.isArray(before.tools) ? before.tools : []).map(record).filter((t) => t.type !== 'knowledge');
  const now = (Array.isArray(after.tools) ? after.tools : []).map(record).filter((t) => t.type !== 'knowledge');
  const byName = (tools: Tool[]) => new Map(tools.map((t) => [toolName(t), t] as const));
  const had = byName(was);
  const has = byName(now);
  for (const [name] of has) if (!had.has(name)) out.push(`Adds the tool ${shown(name)}`);
  for (const [name] of had) if (!has.has(name)) out.push(`Removes the tool ${shown(name)}`);
  for (const [name, tool] of has) {
    const old = had.get(name);
    if (!old) continue;
    if (operationOf(old) !== operationOf(tool)) out.push(`${shown(name)}: ${operationOf(old) || 'no operation'} becomes ${operationOf(tool) || 'no operation'}`);
    if (Boolean(old.requireApproval) !== Boolean(tool.requireApproval)) out.push(tool.requireApproval ? `${shown(name)} now asks first` : `${shown(name)} no longer asks first`);
  }
  const knowledge = (config: Config) => (Array.isArray(config.tools) ? config.tools : []).map(record).filter((t) => t.type === 'knowledge').map((t) => str(t.collection) || str(t.name)).sort().join(', ');
  if (knowledge(before) !== knowledge(after)) out.push(knowledge(after) ? `Knowledge base: ${knowledge(after)}` : 'Removes its knowledge base');
  if (modelOf(before) !== modelOf(after) && modelOf(after)) out.push(`Model: ${modelOf(before) || 'none'} becomes ${modelOf(after)}`);
  if (str(before.name) !== str(after.name) && str(after.name)) out.push(`Renames it to ${str(after.name)}`);
  if (str(before.description) !== str(after.description)) out.push('Description changed');
  const old = guardrailSet(before);
  const next = guardrailSet(after);
  for (const [key, words] of next) if (!old.has(key)) out.push(`Guardrail on: ${words}`);
  for (const [key, words] of old) if (!next.has(key)) out.push(`Guardrail off: ${words}`);
  if (str(before.instructions) !== str(after.instructions)) {
    const n = linesChanged(str(before.instructions), str(after.instructions));
    out.push(`Instructions rewritten (${n} line${n === 1 ? '' : 's'} changed)`);
  }
  return out;
}
