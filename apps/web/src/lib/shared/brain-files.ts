/**
 * The Brain workbench's files (docs/second-brain.md#the-brain-page): the second brain laid out as a repository of
 * Markdown files. `index.md` is the briefing, `log.md` the latest work, and every entity is a file in its type's folder
 * (people in their department's). Each file's Markdown is made from what the routes return, so the Source view shows
 * the page as an LLM wiki keeps it: frontmatter, the summary with `[[type/id|Name]]` links and `[n]` references, then the
 * work, people, related pages and facts. Pure: no runtime imports besides the wiki's own helpers.
 */
import type { EntityType } from './brain';
import { hintId, type WikiEntry, type WikiHome, type WikiPage, type WorkItem } from './brain-wiki';

/** A file: `index`, `log`, or an entity's `<type>/<id>`. */
export type FileRef = string;
export const INDEX: FileRef = 'index';
export const LOG: FileRef = 'log';
/** What Landflow knows (the brain's status, facts and detectors), opened as a file of its own. */
export const SETTINGS: FileRef = 'settings';

/** The address of a file. */
export const urlOf = (ref: FileRef) => (ref === INDEX ? '/brain' : `/brain/${ref}`);

/** The file a `/brain/...` path opens: index.md for anything it doesn't know. */
export function refOfPath(path: string[] | undefined): FileRef {
  if (!path?.length) return INDEX;
  if (path.length >= 2) return `${path[0]}/${decodeURIComponent(path[1])}`;
  return path[0] === LOG || path[0] === SETTINGS ? path[0] : INDEX;
}

export const FOLDERS: Array<{ type: EntityType; folder: string }> = [
  { type: 'initiative', folder: 'initiatives' },
  { type: 'customer', folder: 'customers' },
  { type: 'person', folder: 'people' },
  { type: 'system', folder: 'systems' },
];

/** Why a file needs a person, as the Problems panel says it. */
export type FileProblem = 'no owner' | 'quiet for 30 days' | 'summary behind its work';

export interface TreeFile {
  kind: 'file';
  ref: FileRef;
  /** The file name (`kestrel-bank.md`). */
  name: string;
  /** The page's own name ("Kestrel Bank"). */
  title: string;
  type?: EntityType;
  /** Work naming it this week. */
  week: number;
  /** Two or more teams worked on it this week. */
  shared: boolean;
  problems: FileProblem[];
}

export interface TreeFolder {
  kind: 'folder';
  /** `customers`, `people/R&D`. */
  path: string;
  name: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

export interface BrainTree {
  nodes: TreeNode[];
  /** Every file by ref. */
  files: Map<FileRef, TreeFile>;
  /** Each file's path from the root (`['customers', 'kestrel-bank.md']`). */
  paths: Map<FileRef, string[]>;
}

const NO_DEPARTMENT = 'no department';

/** "Kestrel Bank" → `kestrel-bank.md`; the id when the name gives nothing. */
export const fileNameOf = (entry: Pick<WikiEntry, 'name' | 'id'>) => `${hintId(entry.name) || hintId(entry.id) || 'page'}.md`;

export function brainTree(home: Pick<WikiHome, 'entries' | 'shared' | 'health'>): BrainTree {
  const shared = new Set(home.shared.map((s) => s.ref));
  const problems = new Map<string, FileProblem[]>();
  const flag = (list: Array<{ ref: string }>, problem: FileProblem) => list.forEach((p) => problems.set(p.ref, [...(problems.get(p.ref) ?? []), problem]));
  flag(home.health.noOwner, 'no owner');
  flag(home.health.quiet, 'quiet for 30 days');
  flag(home.health.staleSummaries, 'summary behind its work');

  const files = new Map<FileRef, TreeFile>();
  const paths = new Map<FileRef, string[]>();
  const root: TreeNode[] = [];
  const top = (ref: FileRef, name: string, title: string) => {
    const file: TreeFile = { kind: 'file', ref, name, title, week: 0, shared: false, problems: [] };
    files.set(ref, file);
    paths.set(ref, [name]);
    return file;
  };

  for (const { type, folder } of FOLDERS) {
    const entries = home.entries.filter((e) => e.type === type);
    if (!entries.length) continue;
    const folderNode: TreeFolder = { kind: 'folder', path: folder, name: folder, children: [] };
    const subfolders = new Map<string, TreeFolder>();
    const taken = new Map<string, Set<string>>();
    for (const entry of entries) {
      const ref = `${entry.type}/${entry.id}`;
      const sub = type === 'person' ? (entry.department ?? NO_DEPARTMENT) : undefined;
      const parent = sub ? (subfolders.get(sub) ?? subfolders.set(sub, { kind: 'folder', path: `${folder}/${sub}`, name: sub, children: [] }).get(sub)!) : folderNode;
      const names = taken.get(parent.path) ?? taken.set(parent.path, new Set()).get(parent.path)!;
      let name = fileNameOf(entry);
      if (names.has(name)) name = `${name.slice(0, -3)}-${hintId(entry.id)}.md`;
      names.add(name);
      const file: TreeFile = { kind: 'file', ref, name, title: entry.name, type, week: entry.week, shared: shared.has(ref), problems: problems.get(ref) ?? [] };
      files.set(ref, file);
      paths.set(ref, sub ? [folder, sub, name] : [folder, name]);
      parent.children.push(file);
    }
    // The no-department folder last; the rest by name.
    folderNode.children.push(...[...subfolders.values()].sort((a, b) => Number(a.name === NO_DEPARTMENT) - Number(b.name === NO_DEPARTMENT) || a.name.localeCompare(b.name)));
    sortNodes(folderNode);
    root.push(folderNode);
  }
  root.push(top(INDEX, 'index.md', 'Brain'), top(LOG, 'log.md', 'Log'));
  return { nodes: root, files, paths };
}

function sortNodes(folder: TreeFolder) {
  const subfolders = folder.children.filter((c): c is TreeFolder => c.kind === 'folder');
  const leaves = folder.children.filter((c): c is TreeFile => c.kind === 'file').sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of subfolders) sortNodes(sub);
  folder.children = [...subfolders, ...leaves];
}

/** A heading's anchor in the Preview, the same from the Markdown's heading text: "Mentioned in" → `sec-mentioned-in`. */
export const sectionId = (title: string) => `sec-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

export interface OutlineItem {
  title: string;
  id: string;
  /** 1-based line in the Markdown. */
  line: number;
}

/** The `##` headings of a file's Markdown, for the Outline. */
export function outlineOf(markdown: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  markdown.split('\n').forEach((line, i) => {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) out.push({ title: match[1].trim(), id: sectionId(match[1].trim()), line: i + 1 });
  });
  return out;
}

const day = (iso: string) => iso.slice(0, 10);
const yamlValue = (value: string) => (/^[\w .@/&-]+$/.test(value) && !/^\s|\s$/.test(value) ? value : JSON.stringify(value));
const yamlList = (values: string[]) => `[${values.map(yamlValue).join(', ')}]`;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const link = (ref: string, name: string) => `[[${ref}|${name.replace(/[[\]|]/g, '')}]]`;

/** The heading a page's people section has: a person works with people, the rest have people. */
export const peopleTitle = (type: EntityType) => (type === 'person' ? 'Works with' : 'People');

/** One work item as a list line: day, source and kind, the title (linked to the original), who, team and pages. */
export function workMarkdown(item: WorkItem, names: Map<string, string>): string {
  const title = oneLine(item.title ?? item.kind);
  const parts = [`${day(item.at)} · ${item.source ?? 'work'} · ${item.kind.replace(/^work\./, '')}`, item.url ? `[${title.replace(/[[\]]/g, '')}](${item.url})` : title];
  const pages = item.refs.map((ref) => link(ref, names.get(ref) ?? ref.split('/')[1]));
  if (!item.refs.some((r) => r.startsWith('person/')) && item.actor) pages.unshift(item.actor);
  if (pages.length) parts.push(pages.join(' '));
  if (item.team) parts.push(`team ${item.team}`);
  return `${parts.join(' — ')}${item.summary ? `\n   > ${oneLine(item.summary)}` : ''}`;
}

/** An entity's page as a Markdown file. */
export function pageMarkdown(page: WikiPage): string {
  const { entity } = page;
  const ref = `${entity.type}/${entity.id}`;
  const names = new Map<string, string>([[ref, entity.name]]);
  for (const r of page.related) names.set(r.ref, r.name);
  for (const p of page.people) if (p.ref) names.set(p.ref, p.name);
  for (const l of page.summary?.links ?? []) names.set(l.ref, l.name);
  const sources = [...new Set(page.work.map((w) => w.source).filter((s): s is string => Boolean(s)))];
  const front = [
    '---',
    `type: ${entity.type}`,
    `id: ${yamlValue(entity.id)}`,
    `name: ${yamlValue(entity.name)}`,
    ...((entity.ownerName ?? entity.owner) ? [`owner: ${yamlValue(entity.ownerName ?? entity.owner!)}`] : ['owner: null']),
    ...(page.teams.length ? [`teams: ${yamlList(page.teams.map((t) => t.team))}`] : []),
    ...(sources.length ? [`sources: ${yamlList(sources)}`] : []),
    ...Object.entries(entity.attrs).map(([k, v]) => `${/^[\w-]+$/.test(k) ? k : JSON.stringify(k)}: ${typeof v === 'string' ? yamlValue(v) : String(v)}`),
    `updated: ${entity.updatedAt}`,
    ...(page.summary ? [`summary: ${yamlValue(`${page.summary.model}, ${page.summary.generatedAt}${page.summary.stale ? ', behind its work' : ''}`)}`] : []),
    '---',
  ];
  const out = [...front, '', `# ${entity.name}`, ''];
  if (entity.description) out.push(`> ${oneLine(entity.description)}`, '');
  out.push('## Summary', '', page.summary ? page.summary.text.trim() : '_No summary yet._', '');
  out.push('## Work', '');
  if (page.work.length) page.work.forEach((w, i) => out.push(`${i + 1}. ${workMarkdown(w, names)}`));
  else out.push('_No work names this page yet._');
  out.push('');
  if (page.people.length) {
    out.push(`## ${peopleTitle(entity.type)}`, '');
    for (const p of page.people) out.push(`- ${p.ref ? link(p.ref, p.name) : p.name}${p.team ? ` — ${p.team}` : ''}, ${p.events} item${p.events === 1 ? '' : 's'}`);
    out.push('');
  }
  if (page.related.length) {
    out.push('## Related pages', '');
    for (const r of page.related) out.push(`- ${link(r.ref, r.name)} — ${r.shared} shared item${r.shared === 1 ? '' : 's'}`);
    out.push('');
  }
  if (page.facts.length) {
    out.push('## Facts', '');
    for (const f of page.facts) out.push(`- (${f.kind}) ${oneLine(f.statement)}`);
    out.push('');
  }
  if (page.proposals.length) {
    out.push('## Suggestions', '');
    for (const p of page.proposals) out.push(`- **${oneLine(p.title)}** — ${oneLine(p.why)}`);
    out.push('');
  }
  if (page.mentionedIn.length) {
    out.push('## Mentioned in', '');
    for (const m of page.mentionedIn) out.push(`- ${link(m.ref, m.name)}`);
    out.push('');
  }
  return out.join('\n');
}

/** `index.md`: the week's briefing. */
export function indexMarkdown(home: WikiHome): string {
  const names = new Map(home.entries.map((e) => [`${e.type}/${e.id}`, e.name]));
  const out = ['---', `pages: ${home.entries.length}`, `facts: ${home.status.facts}`, `model: ${home.model ?? 'off'}`, `window: ${home.days} days`, '---', '', '# Brain', ''];
  out.push(`${home.entries.length} pages: ${FOLDERS.map(({ type, folder }) => `${home.entries.filter((e) => e.type === type).length} ${folder}`).join(', ')}.`, '');
  out.push('## Shared across teams', '');
  if (home.shared.length)
    for (const s of home.shared) {
      out.push(`- ${link(s.ref, s.name)} — ${s.teams.length} teams, ${s.events} items`);
      for (const t of s.teams) out.push(`  - ${t.team}: ${t.events} (${t.people.join(', ') || 'unknown'})`);
    }
  else out.push('_Every page was worked on by one team this week._');
  out.push('');
  if (home.proposals.length) {
    out.push('## Suggestions', '');
    for (const p of home.proposals) out.push(`- **${oneLine(p.title)}**${p.target.name ? ` — ${p.target.name}` : ''}`);
    out.push('');
  }
  if (home.teams.length) {
    out.push('## Teams this week', '');
    for (const t of home.teams) out.push(`- **${t.team}** — ${t.events} items, ${t.people} ${t.people === 1 ? 'person' : 'people'}: ${t.top.map((p) => `${link(p.ref, names.get(p.ref) ?? p.name)} (${p.events})`).join(', ') || 'no pages'}`);
    out.push('');
  }
  const { noOwner, quiet, staleSummaries } = home.health;
  if (noOwner.length + quiet.length + staleSummaries.length) {
    out.push('## Needs a person', '');
    for (const [label, list] of [['No owner', noOwner], ['Quiet for 30 days', quiet], ['Summary behind its work', staleSummaries]] as const)
      if (list.length) out.push(`- ${label}: ${list.map((p) => link(p.ref, p.name)).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

/** `log.md`: the latest work, a heading per day. */
export function logMarkdown(home: WikiHome): string {
  const names = new Map(home.entries.map((e) => [`${e.type}/${e.id}`, e.name]));
  const out = ['# Log', '', `The latest ${home.recent.length} work items the work flows recorded, newest first.`, ''];
  for (const [date, items] of byDay(home.recent)) {
    out.push(`## ${date}`, '');
    for (const item of items) out.push(`- ${workMarkdown(item, names).replace(/^\d{4}-\d{2}-\d{2} · /, '')}`);
    out.push('');
  }
  return out.join('\n');
}

/** Work items grouped by day (UTC), newest day first, in their order. */
export function byDay(items: WorkItem[]): Array<[string, WorkItem[]]> {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) groups.set(day(item.at), [...(groups.get(day(item.at)) ?? []), item]);
  return [...groups.entries()];
}
