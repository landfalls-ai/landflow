/**
 * What the model reads for each kind of tag (docs/assistant.md#tagging-with-): one digest per kind, at most
 * `MENTION_LIMITS.perRefBytes` each, every line through `redact()` (emails, tokens, ids and long numbers masked). A
 * digest is built only for what the caller may open; `digestFor` answers undefined for a ref that is missing or not
 * theirs, and the two look the same to the caller. No credential value, ever: a credential gives its name, type, where
 * it is used and whether it is connected.
 */
import { MENTION_LIMITS, type MentionRef, type MentionType } from '../../shared/mentions';
import { agentBrief } from '../../shared/agent-brief';
import { nodeDocs, workflowOutline } from '../assistant/research';
import { agentStore } from '../agents/store';
import { agentTeamStore } from '../agent-teams/store';
import { getUser, listUsers } from '../auth/users';
import { canEntity, getEntity, listEntities } from '../brain/entities';
import { scopeForActor } from '../brain/scope';
import { wikiPage } from '../brain/wiki';
import { credentials } from '../credentials/vault';
import { dataTables } from '../datatables';
import { digestOf } from '../journal/runs-query';
import { registry } from '../plugins/registry';
import { visibleIds, type Actor } from '../projects/access';
import { store } from '../store';
import { getTemplate, templateAccess } from '../templates';
import { REMOTE_PREFIX } from '../templates/remote';
import { redact } from '../usage/ledger';

/** What a digest is called and says. */
export interface Digest {
  /** The name as redacted, for the block's heading. */
  name: string;
  /** The caller's own resource name as it is, for the "read" chip. */
  label: string;
  body: string;
}

export interface DigestOptions {
  /** A data table's first rows go in only when asked. */
  samples?: boolean;
}

// ---- small helpers ------------------------------------------------------------------------------------------------

/** `text` cut to at most `max` bytes of UTF-8, on a character boundary, with an ellipsis when it was cut. */
export function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const room = Math.max(0, max - 3);
  let out = '';
  let size = 0;
  for (const char of text) {
    const next = Buffer.byteLength(char);
    if (size + next > room) break;
    out += char;
    size += next;
  }
  return `${out}…`;
}

/** Every line through `redact()` (which collapses spaces and clips a line to 300 characters), the indent kept. */
export function redactLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const clean = redact(line);
      return clean ? `${' '.repeat(Math.min(indent, 4))}${clean}` : '';
    })
    .filter((line) => line !== '')
    .join('\n');
}

const finish = (name: string, lines: Array<string | number | undefined | false | null>): Digest => ({
  name: redact(name) ?? name.slice(0, 80),
  label: name.replace(/\s+/g, ' ').trim().slice(0, 80),
  body: clipBytes(redactLines(lines.filter((l): l is string => typeof l === 'string' && l !== '').join('\n')), MENTION_LIMITS.perRefBytes),
});

const clip = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const SECRET_KEY = /pass(word)?|secret|token|api.?key|authorization|credential|private/i;

/** `value` with every nested key that looks like a secret hidden. */
function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  // A `{ name: 'X-Api-Key', value }` pair hides its value by the name.
  const rec = value as Record<string, unknown>;
  if (typeof rec.name === 'string' && SECRET_KEY.test(rec.name) && 'value' in rec) return { ...rec, value: '<hidden>' };
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '<hidden>' : maskSecrets(v, depth + 1)]));
}

/** A node's parameters with long values clipped and anything that looks like a secret left out. */
export function parameterLines(parameters: Record<string, unknown>, limit = 12): string[] {
  return Object.entries(parameters)
    .slice(0, limit)
    .map(([key, value]) => `  ${key}: ${SECRET_KEY.test(key) ? '<hidden>' : clip(maskSecrets(value), 90)}`);
}

const when = (iso: string | undefined) => (iso ? `${iso.slice(0, 10).slice(5)} ${iso.slice(11, 16)} UTC` : '');
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
/** A count with thousands separators: redact() masks any bare run of 4+ digits, and a digest's own numbers must survive it. */
const count = (n: number) => n.toLocaleString('en-US');

/** Whether `actor` may open one resource: the same check the search ran, so a tag found there resolves here. */
function sees(actor: Actor, kind: Parameters<typeof visibleIds>[1], id: string): boolean {
  const visible = visibleIds(actor, kind, [id]);
  return !visible || visible.has(id);
}

// ---- one digest per kind ------------------------------------------------------------------------------------------

function workflow(actor: Actor, ref: MentionRef): Digest | undefined {
  const found = store.getWorkflow(ref.id);
  if (!found || !sees(actor, 'workflow', ref.id)) return undefined;
  return finish(found.name, [workflowOutline(found)]);
}

function node(actor: Actor, ref: MentionRef): Digest | undefined {
  const workflowId = ref.workflowId;
  const found = workflowId ? store.getWorkflow(workflowId) : undefined;
  const target = found?.nodes.find((n) => n.id === ref.id);
  if (!found || !target || !workflowId || !sees(actor, 'workflow', workflowId)) return undefined;
  const credentialNames = Object.values(target.credentials ?? {}).map((c) => c.name);
  return finish(target.name, [
    `Node “${target.name}” in workflow “${found.name}”: ${target.type}${target.disabled ? ' (disabled)' : ''}.`,
    'Parameters:',
    ...parameterLines(target.parameters),
    credentialNames.length && `Uses credentials: ${credentialNames.join(', ')} (values are never shown).`,
  ]);
}

async function run(actor: Actor, ref: MentionRef): Promise<Digest | undefined> {
  const record = await store.loadExecution(ref.id);
  if (!record || !sees(actor, 'workflow', record.workflowId)) return undefined;
  const digest = await digestOf(ref.id);
  return finish(`${record.workflowName} run`, [
    `Run of “${record.workflowName}”: ${record.status}, ${record.mode}, started ${when(record.startedAt)}, ${seconds(record.durationMs)}.`,
    record.error && `Error: ${record.error.message}${record.error.nodeName ? ` (at “${record.error.nodeName}”)` : ''}`,
    digest && `${count(digest.steps)} steps, ${count(digest.failedSteps)} failed; ${count(digest.modelCalls)} model calls, ${count(digest.tokensIn + digest.tokensOut)} tokens${digest.costUsd ? `, about $${digest.costUsd.toFixed(2)}` : ''}.`,
    digest?.failedChecks.length && `Failed checks: ${digest.failedChecks.slice(0, 5).join('; ')}.`,
    digest?.actors.length && `Who took part: ${digest.actors.slice(0, 6).map((a) => `${a.name} (${a.type})`).join(', ')}.`,
  ]);
}

function agent(actor: Actor, ref: MentionRef): Digest | undefined {
  const found = agentStore.get(ref.id);
  if (!found || !sees(actor, 'agent', ref.id)) return undefined;
  const nameOf = (id: string) => agentStore.get(id)?.name;
  const brief = agentBrief(found, nameOf);
  if (!brief) return finish(found.name, [`Agent “${found.name}” (not published yet).`, found.description && `Does: ${found.description}`]);
  return finish(brief.name, [
    `Agent “${brief.name}”, version ${brief.version}${brief.team ? `, team ${brief.team}` : ''}.`,
    brief.description && `Does: ${brief.description}`,
    brief.role && `Role: ${brief.role}.`,
    brief.skills.length && `Skills: ${brief.skills.join('; ')}.`,
    brief.tools.length && `Tools: ${brief.tools.join(', ')}.`,
  ]);
}

function team(actor: Actor, ref: MentionRef): Digest | undefined {
  const found = agentTeamStore.get(ref.id);
  if (!found || !sees(actor, 'agentTeam', ref.id)) return undefined;
  const config = found.published ?? found.draft;
  const lead = config.members.find((m) => !m.reportsTo);
  const budget = (tokens?: number) => (tokens ? `, budget ${count(tokens)} tokens` : '');
  return finish(config.name, [
    `Team “${config.name}”${found.published ? `, version ${found.published.version}` : ' (not published yet)'}.`,
    config.goal && `Goal: ${config.goal}`,
    lead && `Lead: ${lead.title}${budget(lead.budgetTokens)}.`,
    `Members (${config.members.length}):`,
    ...config.members.slice(0, 10).map((m) => `  ${m.title}${m.role ? `: ${clip(m.role, 80)}` : ''}${budget(m.budgetTokens)}`),
  ]);
}

function dataTable(actor: Actor, ref: MentionRef, options: DigestOptions): Digest | undefined {
  if (!sees(actor, 'dataTable', ref.id)) return undefined;
  const table = dataTables().storage.getTable(ref.id);
  if (!table) return undefined;
  const page = dataTables().listRows(ref.id, { limit: options.samples ? 5 : 0 });
  const columns = table.columns.slice(0, 20).map((c) => `${c.name} (${c.type})`);
  return finish(table.name, [
    `Data table “${table.name}”: ${count(page.total)} row${page.total === 1 ? '' : 's'}.`,
    `Columns: ${columns.join(', ') || 'none'}.`,
    options.samples && page.rows.length ? 'Sample rows:' : undefined,
    ...(options.samples ? page.rows.map((row) => `  ${clip(Object.fromEntries(table.columns.map((c) => [c.name, row[c.name]])), 200)}`) : []),
  ]);
}

async function template(actor: Actor, ref: MentionRef): Promise<Digest | undefined> {
  // Saved and built-in templates only, like the search: a remote id is refused before any lookup (no outbound request).
  if (ref.id.startsWith(REMOTE_PREFIX)) return undefined;
  const found = await getTemplate(ref.id, actor);
  if (!found || found.source === 'remote' || !templateAccess(actor, found).read) return undefined;
  return finish(found.name, [
    `Template “${found.name}” (${found.source === 'local' ? 'saved' : 'built in'}), ${found.nodeCount} nodes.`,
    found.description && `Does: ${found.description}`,
    found.nodeTypes.length && `Node types: ${found.nodeTypes.slice(0, 12).join(', ')}.`,
    found.credentials.length && `Needs credentials: ${found.credentials.map((c) => c.name).slice(0, 6).join(', ')}.`,
  ]);
}

function nodeType(ref: MentionRef): Digest | undefined {
  const info = registry.nodeTypes().find((t) => t.type === ref.id);
  return info && finish(info.descriptor.displayName, [nodeDocs(info)]);
}

function plugin(ref: MentionRef): Digest | undefined {
  const found = registry.list().find((p) => p.id === ref.id);
  if (!found) return undefined;
  return finish(found.info.name, [
    `Plugin “${found.info.name}” (${found.id}): ${found.status}, ${found.transport}.`,
    found.info.description && clip(found.info.description, 200),
    `Nodes: ${found.nodes.slice(0, 12).map((n) => n.displayName).join(', ') || 'none'}.`,
    found.lastError && `Last error: ${found.lastError}`,
  ]);
}

function brainPage(actor: Actor, ref: MentionRef): Digest | undefined {
  const [type, ...rest] = ref.id.split('/');
  const entity = type && rest.length ? getEntity(type, rest.join('/')) : undefined;
  if (!entity || !canEntity(actor, entity, 'read')) return undefined;
  const user = getUser(actor.id);
  const page = wikiPage(entity, scopeForActor(actor), user ? { id: user.id, email: user.email } : { id: actor.id }, false);
  return finish(entity.name, [
    `Brain page “${entity.name}” (${entity.type}).`,
    entity.description && `About: ${clip(entity.description, 200)}`,
    page.summary?.text && `Summary: ${clip(page.summary.text, 500)}`,
    page.facts.length ? 'Facts:' : undefined,
    ...page.facts.slice(0, 5).map((f) => `  - ${clip(f.statement, 140)}`),
    page.work.length ? 'Latest work:' : undefined,
    ...page.work.slice(0, 5).map((w) => `  - ${when(w.at)} ${clip(w.title ?? w.summary ?? w.kind, 120)}`),
  ]);
}

function person(actor: Actor, ref: MentionRef): Digest | undefined {
  const user = listUsers().find((u) => u.id === ref.id && !u.disabledAt);
  if (!user) return undefined;
  // Their brain page (matched by email, else name), when there is one the caller may read.
  const email = user.email.toLowerCase();
  const entity = (() => {
    const people = listEntities({ type: 'person', limit: 5000 });
    return people.find((e) => String(e.attrs.email ?? '').toLowerCase() === email) ?? people.find((e) => e.name.toLowerCase() === user.name.toLowerCase());
  })();
  const readable = entity && canEntity(actor, entity, 'read') ? entity : undefined;
  const summary = readable ? wikiPage(readable, scopeForActor(actor), { id: user.id, email: user.email }, false).summary?.text : undefined;
  const team = readable?.attrs.team ? String(readable.attrs.team) : undefined;
  return finish(user.name || user.email.split('@')[0], [
    `Person “${user.name}”, role ${user.role}.`,
    team && `Team: ${team}.`,
    summary && `Brain page: ${clip(summary, 500)}`,
  ]);
}

function credential(actor: Actor, ref: MentionRef): Digest | undefined {
  if (!sees(actor, 'credential', ref.id)) return undefined;
  const found = credentials.list().find((c) => c.id === ref.id);
  if (!found) return undefined;
  // Only the workflows the caller may open are named as users.
  const visible = visibleIds(actor, 'workflow', found.usedBy.map((u) => u.workflowId));
  const usedBy = found.usedBy.filter((u) => !visible || visible.has(u.workflowId));
  return finish(found.name, [
    `Credential “${found.name}”, type ${found.type}. Its value is never shared.`,
    usedBy.length ? `Used by: ${usedBy.slice(0, 8).map((u) => `“${u.workflowName}”`).join(', ')}.` : 'Not used by a workflow you can open.',
    found.oauth2 && `Connection: ${found.oauth2.connected ? (found.oauth2.expired ? 'expired' : 'connected') : 'not connected'}.`,
  ]);
}

/** The digest of one tag, or undefined when it is missing or the caller may not open it. */
export async function digestFor(actor: Actor, ref: MentionRef, options: DigestOptions = {}): Promise<Digest | undefined> {
  const type: MentionType = ref.type;
  switch (type) {
    case 'workflow': return workflow(actor, ref);
    case 'node': return node(actor, ref);
    case 'run': return run(actor, ref);
    case 'agent': return agent(actor, ref);
    case 'team': return team(actor, ref);
    case 'dataTable': return dataTable(actor, ref, options);
    case 'template': return template(actor, ref);
    case 'nodeType': return nodeType(ref);
    case 'plugin': return plugin(ref);
    case 'brainPage': return brainPage(actor, ref);
    case 'person': return person(actor, ref);
    case 'credential': return credential(actor, ref);
  }
}
