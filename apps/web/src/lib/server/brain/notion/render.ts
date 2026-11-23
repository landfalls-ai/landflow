/**
 * What Landflow writes into Notion, as pure functions of the local objects (docs/features/notion-brain.md#what-landflow-writes):
 * the Markdown region of a page, of Home and of Log, and each row's properties. Nothing here calls Notion or writes a row.
 *
 * The region is main's own Markdown (`pageMarkdown`, `indexMarkdown`, `logMarkdown`) after the rules of
 * backbone/contracts/nb/README.md §3a, so the Brain page's Source view and Notion say the same thing: frontmatter, heading
 * and the description quote are dropped (the row's properties hold them); links become page mentions where the page has a row
 * and plain names where it has none; the person who did a work item is never written; ledger text and a person known only by
 * email pass `redact()` again (never a whole body, never the brain's own text); `<` and `>` in text are escaped; suggestions
 * are titles with a link back. The fixtures in test/fixtures/notion-render pin the result byte for byte.
 */
import { createHash } from 'node:crypto';
import type { BrainEntity, BrainFact } from '../../../shared/brain';
import type { WikiHome, WikiPage, WorkItem } from '../../../shared/brain-wiki';
import { indexMarkdown, logMarkdown, pageMarkdown } from '../../../shared/brain-files';
import { DATABASES, HOW_THIS_WORKS, LANDFLOW_ID, FACT_SOURCES, type DatabaseKind } from '../../../shared/notion-brain';
import type { Practice, PracticeVersion } from '../../../shared/practices';
import type { TeamNote } from '../../../shared/notebook';
import { agentTeamStore } from '../../agent-teams/store';
import { publicUrl } from '../../config/urls';
import { database } from '../../db';
import { fitMarkdown, richText } from '../../notion/text';
import { versionsOf, getVersion } from '../../practices/store';
import { resourceIdsIn } from '../../projects/store';
import { redact } from '../../usage/ledger';
import type { UsageScope } from '../../usage/query';
import { entityKeysIn, entityKey } from '../entities';
import { wikiHome, wikiPage } from '../wiki';
import type { LinkDatabase } from './sync';
import type { LinkRow } from './links';

// ---------------------------------------------------------------------------------------------------- the rules

export interface RenderContext {
  /** The Notion page id of a local page (`<type>/<id>`) that has a row of this link; undefined: it has none. */
  mapped: (ref: string) => string | undefined;
  /** LANDFLOW_PUBLIC_URL, without a trailing slash. */
  publicUrl: string;
}

/** README §3a rule 5: `<` and `>` in a text value get a backslash, so Notion never reads a tag in it. */
export const escapeText = (text: string): string => text.replace(/[<>]/g, (c) => `\\${c}`);

/** The same for a Markdown body a person wrote (a practice's rules): quotes at a line start and fenced code stay as they are. */
export function escapeBody(markdown: string): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const quote = /^(\s*(?:>\s?)+)(.*)$/.exec(line);
      return quote ? `${quote[1]}${escapeText(quote[2])}` : escapeText(line);
    })
    .join('\n');
}

const EMAIL = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const clean = (text: string | undefined): string | undefined => (text === undefined ? undefined : escapeText(text));
/** A ledger text: through `redact()` once more, then escaped. */
const ledger = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const redacted = redact(text);
  return redacted === undefined ? undefined : escapeText(redacted);
};
/** A name the wiki derived from an email (a person with no page): `<email>`. */
const personName = (name: string): string => (EMAIL.test(name.trim()) ? escapeText(redact(name) ?? name) : escapeText(name));

const mentionTag = (id: string, label: string) => `<mention-page url="https://www.notion.so/${id.replace(/-/g, '')}">${label}</mention-page>`;

/** README §3a rule 2: `[[type/id|Label]]` and `[[type/id]]` become a mention of the page's row, or the plain label. */
function rewriteLinks(markdown: string, names: Map<string, string>, ctx: RenderContext): string {
  return markdown.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_all, ref: string, label?: string) => {
    const text = label ?? names.get(ref) ?? ref.split('/')[1] ?? ref;
    const id = ctx.mapped(ref);
    return id ? mentionTag(id, text) : text;
  });
}

const workOf = (item: WorkItem): WorkItem => {
  const { actor: _actor, ...rest } = item;
  return {
    ...rest,
    ...(item.title !== undefined && { title: ledger(item.title) ?? item.kind }),
    ...(item.summary !== undefined && ledger(item.summary) !== undefined && { summary: ledger(item.summary) }),
    ...(item.source && { source: escapeText(item.source) }),
    ...(item.team && { team: escapeText(item.team) }),
    ...(item.customer && { customer: escapeText(item.customer) }),
  };
};

const trimEnd = (text: string) => text.replace(/\s+$/, '');
const calloutOf = (text: string) => `<callout>\n\t${text}\n</callout>`;

/** The brain page's body before the first Home is written (the copy makes the page with it). */
export const introRegion = (): string => calloutOf(HOW_THIS_WORKS);
/** Log's body before its first write. */
export const LOG_PLACEHOLDER = '_Landflow is copying the brain to this page._';

// ---------------------------------------------------------------------------------------------------- regions

/** An entity page's region: pageMarkdown from `## Summary` on, under the rules above. */
export function pageRegion(page: WikiPage, ctx: RenderContext): string {
  const entity: BrainEntity = { ...page.entity, name: escapeText(page.entity.name) };
  const ref = entityKey(page.entity);
  const prepared: WikiPage = {
    ...page,
    entity,
    ...(page.summary && { summary: { ...page.summary, text: escapeText(page.summary.text), links: page.summary.links.map((l) => ({ ...l, name: escapeText(l.name) })) } }),
    work: page.work.map(workOf),
    people: page.people.map((p) => ({ ...p, name: p.ref ? escapeText(p.name) : personName(p.name), ...(p.team && { team: escapeText(p.team) }) })),
    related: page.related.map((r) => ({ ...r, name: escapeText(r.name) })),
    facts: page.facts.map((f) => ({ ...f, statement: escapeText(f.statement) })),
    // README §3a rule 6: a suggestion is its title with a link back; the why, the evidence and the buttons stay in Landflow.
    proposals: page.proposals.map((p) => ({ ...p, title: escapeText(p.title), why: `[Open in Landflow](${ctx.publicUrl}/brain/${ref})` })),
    mentionedIn: page.mentionedIn.map((m) => ({ ...m, name: escapeText(m.name) })),
  };
  const names = new Map<string, string>([[ref, entity.name]]);
  for (const r of prepared.related) names.set(r.ref, r.name);
  for (const p of prepared.people) if (p.ref) names.set(p.ref, p.name);
  for (const l of prepared.summary?.links ?? []) names.set(l.ref, l.name);
  const lines = pageMarkdown(prepared).split('\n');
  const from = lines.indexOf('## Summary');
  return fitMarkdown(trimEnd(rewriteLinks(lines.slice(from < 0 ? 0 : from).join('\n'), names, ctx)));
}

const homeOf = (home: WikiHome): WikiHome => ({
  ...home,
  entries: home.entries.map((e) => ({ ...e, name: escapeText(e.name) })),
  shared: home.shared.map((s) => ({ ...s, name: escapeText(s.name), teams: s.teams.map((t) => ({ ...t, team: escapeText(t.team), people: t.people.map(personName) })) })),
  teams: home.teams.map((t) => ({ ...t, team: escapeText(t.team), top: t.top.map((p) => ({ ...p, name: escapeText(p.name) })) })),
  proposals: home.proposals.map((p) => ({ ...p, title: escapeText(p.title), target: { ...p.target, ...(p.target.name && { name: escapeText(p.target.name) }) } })),
  recent: home.recent.map(workOf),
  health: {
    noOwner: home.health.noOwner.map((p) => ({ ...p, name: escapeText(p.name) })),
    quiet: home.health.quiet.map((p) => ({ ...p, name: escapeText(p.name) })),
    staleSummaries: home.health.staleSummaries.map((p) => ({ ...p, name: escapeText(p.name) })),
  },
});

const namesOfHome = (home: WikiHome) => new Map(home.entries.map((e) => [`${e.type}/${e.id}`, e.name]));
const afterHeading = (markdown: string, heading: string) => {
  const lines = markdown.split('\n');
  const at = lines.indexOf(heading);
  return lines.slice(at < 0 ? 0 : at + 2).join('\n');
};

/** Home (the brain page's body): the callout, then indexMarkdown from its counts line. */
export function homeRegion(home: WikiHome, ctx: RenderContext): string {
  const prepared = homeOf(home);
  const body = rewriteLinks(trimEnd(afterHeading(indexMarkdown(prepared), '# Brain')), namesOfHome(prepared), ctx);
  return fitMarkdown(`${calloutOf(HOW_THIS_WORKS)}\n\n${body}`.replace(/\s+$/, ''));
}

/** Log: logMarkdown without its "# Log" heading, under the same rules. */
export function logRegion(home: WikiHome, ctx: RenderContext): string {
  const prepared = homeOf(home);
  return fitMarkdown(trimEnd(rewriteLinks(afterHeading(logMarkdown(prepared), '# Log'), namesOfHome(prepared), ctx)));
}

/** A practice's region: its summary as a quote, then the version's rules; while a newer draft from Notion waits, a callout first. */
export function practiceRegion(version: PracticeVersion | undefined, waiting: PracticeVersion | undefined): string {
  const parts: string[] = [];
  if (waiting) parts.push(calloutOf(`Your change is draft v${waiting.version}, waiting for approval in Landflow`));
  if (version) {
    if (version.summary) parts.push(`> ${escapeText(version.summary.replace(/\s+/g, ' ').trim())}`);
    if (version.body.trim()) parts.push(escapeBody(version.body.trim()));
  } else parts.push('_No version yet._');
  return fitMarkdown(parts.join('\n\n'));
}

// ---------------------------------------------------------------------------------------------------- properties

/** A row as it will be written: the properties by name in two groups (who owns them), the region when the row has a body. */
export interface Rendered {
  kind: DatabaseKind;
  key: string;
  /** Written at create, and again only when their value changed in Landflow. */
  person: Record<string, unknown>;
  /** Landflow's: written whenever their value changed. */
  landflow: Record<string, unknown>;
  region?: string;
}

const text = (value: string) => ({ rich_text: richText(value) });
const title = (value: string) => ({ title: richText(value) });
const select = (value: string | undefined) => (value ? { select: { name: value.replace(/,/g, ' ').slice(0, 100) } } : { select: null });
const multi = (values: string[]) => ({ multi_select: [...new Set(values.map((v) => v.replace(/,/g, ' ').trim().slice(0, 100)).filter(Boolean))].slice(0, 100).map((name) => ({ name })) });
const day = (iso: string | undefined) => (iso ? { date: { start: iso } } : { date: null });

export const hashOf = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12);

/** The three parts of an item's `pushed_hash`: person-owned properties, Landflow-owned properties, the region. */
export interface PushedHash {
  person: string;
  landflow: string;
  body: string;
}
export const hashesOf = (r: Rendered): PushedHash => ({ person: hashOf(r.person), landflow: hashOf(r.landflow), body: r.region === undefined ? '' : hashOf(r.region) });
export const packHash = (h: PushedHash): string => `${h.person}.${h.landflow}.${h.body}`;
export function unpackHash(value: string | null | undefined): PushedHash | undefined {
  const parts = (value ?? '').split('.');
  return parts.length === 3 ? { person: parts[0], landflow: parts[1], body: parts[2] } : undefined;
}

/** Properties by name → by id (what the link's `databases` stored); a property the data source lost is left out. */
export function propertiesById(db: LinkDatabase, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const id = db.properties[name];
    if (id) out[id] = value;
  }
  return out;
}

/** What a session reads once: the project's scope (members' view, no person), its home, and the page mapping. */
export interface RenderSession {
  link: LinkRow;
  ctx: RenderContext;
  scope: UsageScope;
  home(): WikiHome;
}

/** The scope a project's members read through, for nobody in particular: org or ownerless work of the project's flows and agents only. */
export function projectScope(projectId: string): UsageScope {
  const scope: UsageScope = {
    workflows: new Set(resourceIdsIn(projectId, 'workflow')),
    agents: new Set(resourceIdsIn(projectId, 'agent')),
    entities: entityKeysIn(projectId),
    system: true,
  };
  // The rule that keeps private and team-only work out: no viewer and no teammate scope, so the ledger returns shared work only.
  if (scope.viewerId !== undefined || scope.teamOf !== undefined || !scope.system) throw new Error('A Notion brain scope must hold no person');
  return scope;
}

export function sessionFor(link: LinkRow, ctx: Partial<RenderContext> = {}): RenderSession {
  let cached: WikiHome | undefined;
  const scope = projectScope(link.project_id);
  const mapped = ctx.mapped ?? ((ref: string) => database().get<{ notion_id: string }>("SELECT notion_id FROM notion_brain_items WHERE link_id = ? AND kind = 'entity' AND local_key = ?", link.id, ref)?.notion_id);
  return {
    link,
    ctx: { mapped, publicUrl: ctx.publicUrl ?? publicUrl() },
    scope,
    home: () => (cached ??= wikiHome(scope, undefined)),
  };
}

const attributeLines = (attrs: BrainEntity['attrs']) =>
  Object.entries(attrs)
    .slice(0, 20)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n');

/** An entity's row: Name, Type, Description, Owner and Attributes are the person's; the rest Landflow's. */
export function renderEntity(entity: BrainEntity, session: RenderSession, options: { body?: boolean } = {}): Rendered {
  const ref = entityKey(entity);
  const page = wikiPage(entity, session.scope, undefined, false);
  const home = session.home();
  const needs = [...home.health.noOwner, ...home.health.quiet, ...home.health.staleSummaries].some((p) => p.ref === ref);
  const last = page.work[0]?.at;
  return {
    kind: 'pages',
    key: ref,
    person: {
      Name: title(entity.name),
      Type: select(entity.type),
      Description: text(entity.description ?? ''),
      Owner: text(entity.ownerName ?? entity.owner ?? ''),
      Attributes: text(attributeLines(entity.attrs)),
    },
    landflow: {
      Teams: multi(page.teams.map((t) => t.team)),
      Sources: multi(page.work.map((w) => w.source).filter((s): s is string => Boolean(s))),
      'Last work': day(last),
      'Needs a person': { checkbox: needs },
      [LANDFLOW_ID]: text(ref),
      'Open in Landflow': { url: `${session.ctx.publicUrl}/brain/${ref}` },
    },
    ...(options.body !== false && { region: pageRegion(page, session.ctx) }),
  };
}

/** A fact's row (no body). Study facts are Landflow's; a person's (an `entity:…:fact_…` id) are the person's. */
export function renderFact(fact: BrainFact, session: RenderSession): Rendered {
  const about = fact.subjectType === 'entity' ? session.ctx.mapped(fact.subjectId) : undefined;
  const person = fact.id.includes(':fact_');
  return {
    kind: 'facts',
    key: fact.id,
    person: { Statement: title(fact.statement), Kind: select(fact.kind), ...(about && { About: { relation: [{ id: about }] } }) },
    landflow: {
      Subject: text(fact.subjectType === 'entity' ? '' : (fact.subjectName ?? fact.subjectId)),
      Status: select(fact.status),
      Confidence: { number: fact.confidence },
      Source: select(person ? FACT_SOURCES.person : FACT_SOURCES.landflow),
      'Last seen': day(fact.lastSeen),
      [LANDFLOW_ID]: text(fact.id),
    },
  };
}

/** A practice's row: every property is Landflow's; the body is the approved version's rules (the latest version while none is approved). */
export function renderPractice(practice: Practice): Rendered {
  const versions = versionsOf(practice.id);
  const approved = practice.approvedVersion !== undefined ? getVersion(practice.id, practice.approvedVersion) : undefined;
  const shown = approved ?? versions[0];
  const waiting = versions.find((v) => v.source === 'notion' && !v.approvedAt && !v.rejectedAt && (practice.approvedVersion === undefined || v.version > practice.approvedVersion));
  return {
    kind: 'practices',
    key: practice.id,
    person: {},
    landflow: {
      Title: title(shown?.title ?? practice.title),
      Handle: text(practice.handle),
      Level: select(practice.level),
      Strength: select(shown?.strength ?? practice.strength),
      Status: select(practice.status),
      Version: { number: shown?.version ?? practice.approvedVersion ?? 0 },
      Topics: multi(shown?.topics ?? practice.topics),
      Repos: text((shown?.repos ?? practice.repos).join('\n')),
      Paths: text((shown?.paths ?? practice.paths).join('\n')),
      [LANDFLOW_ID]: text(practice.id),
    },
    region: practiceRegion(shown, waiting),
  };
}

/** A note's row (no body): the text and kind are the person's (a person adds notes in Notion); status and taint are Landflow's. */
export function renderNote(note: TeamNote): Rendered {
  const found = agentTeamStore.get(note.teamId);
  const team = (found?.published ?? found?.draft)?.name ?? note.teamId;
  return {
    kind: 'notebook',
    key: note.id,
    person: { Text: title(note.text), Kind: select(note.kind), Team: text(team) },
    landflow: { Status: select(note.status), Tainted: { checkbox: note.tainted }, From: text(note.author), [LANDFLOW_ID]: text(note.id) },
  };
}

/** The schema `createDatabase` sends for one of the four databases (relations point at the Pages data source). */
export function databaseSchema(kind: DatabaseKind, pagesDataSourceId: string | undefined): Record<string, import('../../notion/port').NotionPropertySchema> {
  const out: Record<string, import('../../notion/port').NotionPropertySchema> = {};
  for (const spec of DATABASES[kind].properties) {
    const options = (spec.options ?? []).map((name) => ({ name }));
    switch (spec.type) {
      case 'title':
        out[spec.name] = { title: {} };
        break;
      case 'rich_text':
        out[spec.name] = { rich_text: {} };
        break;
      case 'select':
        out[spec.name] = { select: { options } };
        break;
      case 'multi_select':
        out[spec.name] = { multi_select: { options } };
        break;
      case 'number':
        out[spec.name] = { number: { format: 'number' } };
        break;
      case 'checkbox':
        out[spec.name] = { checkbox: {} };
        break;
      case 'date':
        out[spec.name] = { date: {} };
        break;
      case 'url':
        out[spec.name] = { url: {} };
        break;
      case 'relation':
        if (pagesDataSourceId) out[spec.name] = { relation: { data_source_id: pagesDataSourceId, type: 'single_property', single_property: {} } };
        break;
    }
  }
  return out;
}
