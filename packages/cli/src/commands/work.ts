/**
 * `landflow work …`: the daily offload for people who don't use Claude Code. `collect` reads the day's commits (and PRs
 * through `gh` when installed) in allowed repositories and summarises them on this machine, without a model and
 * without code; the entries are held for review; `review` and `send` post them to POST /api/brain/work. Nothing is sent
 * without a person's `review --send` or `send` (and `send` needs `--yes` away from a terminal).
 */
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { validateWorkEvent, type WorkEventInput } from '../work/contract';
import { seg } from '../client';
import { flag, type Command, type Context, type Io } from '../command';
import { CliError, usage } from '../errors';
import { plural, table, time } from '../output';
import { collectRepo, defaultRunner, originRepo, type Runner } from '../work/collect';
import { findEntry, readHeld, readRepos, upsert, WORK_SOURCE, writeHeld, writeRepos, type AllowedRepo, type HeldEntry } from '../work/held';
import { summarizeRepo } from '../work/summary';

/** The CLI's Io, optionally with a command runner (tests pass a fake one; the real CLI uses child_process). */
export type WorkIo = Io & { exec?: Runner };

const BATCH = 50;
type Json = Record<string, unknown>;

const runner = (ctx: Context): Runner => (ctx.io as WorkIo).exec ?? defaultRunner;
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** `today`, `yesterday` or an ISO date or time, as a `--since` value for Git. */
export function resolveSince(value: string | undefined, now = new Date()): string {
  const text = (value ?? 'today').trim();
  if (text === 'today') return localDay(now);
  if (text === 'yesterday') return localDay(new Date(now.getTime() - 86_400_000));
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(text) && Number.isFinite(Date.parse(text))) return text;
  throw usage(`--since is today, yesterday or an ISO date or time, got "${text}"`);
}

const view = (e: HeldEntry) => ({
  id: e.id,
  sourceId: e.sourceId,
  status: e.status,
  day: e.day,
  title: e.event.title,
  repo: e.event.repo ?? null,
  branch: e.event.branch ?? null,
  commits: e.event.commits ?? 0,
  areas: e.event.areas ?? [],
  prs: e.event.prs ?? [],
  heldAt: e.heldAt,
  sentAt: e.sentAt ?? null,
  serverId: e.serverId ?? null,
  error: e.error ?? null,
});

const entryTable = (entries: HeldEntry[], empty: string) =>
  table(entries, [
    { label: 'id', value: (e) => e.id },
    { label: 'status', value: (e) => e.status },
    { label: 'day', value: (e) => e.day },
    { label: 'repo', value: (e) => e.event.repo, max: 30 },
    { label: 'what', value: (e) => e.event.title, max: 80 },
    { label: 'error', value: (e) => e.error, max: 40 },
  ], empty);

const configFile = (ctx: Context) => ctx.connection.configPath;

function entriesFor(entries: HeldEntry[], ref: string, statuses: HeldEntry['status'][] = ['held']): HeldEntry[] {
  if (ref === 'all') return entries.filter((e) => statuses.includes(e.status));
  const found = findEntry(entries, ref);
  if (!found) throw new CliError('not_found', `No entry "${ref}": see landflow work review`);
  return [found];
}

/** Post these entries in batches of 50 and record what the host saved and refused. Returns the entries now sent. */
async function sendEntries(ctx: Context, all: HeldEntry[], toSend: HeldEntry[]): Promise<{ entries: HeldEntry[]; sent: HeldEntry[]; refused: HeldEntry[] }> {
  let entries = all;
  const sent: HeldEntry[] = [];
  const refused: HeldEntry[] = [];
  const now = new Date();
  for (let i = 0; i < toSend.length; i += BATCH) {
    const batch = toSend.slice(i, i + BATCH);
    const events: WorkEventInput[] = [];
    const local: HeldEntry[] = [];
    for (const entry of batch) {
      const checked = validateWorkEvent(entry.event);
      if (!checked.ok) {
        entries = entries.map((e) => (e.sourceId === entry.sourceId ? { ...e, error: checked.errors.join('; ') } : e));
        refused.push(entries.find((e) => e.sourceId === entry.sourceId) as HeldEntry);
      } else {
        events.push({ ...checked.value, visibility: 'private' });
        local.push(entry);
      }
    }
    if (!events.length) continue;
    const answer = await ctx.client.post<{ saved?: Array<{ sourceId: string; id: string }>; rejected?: Array<{ sourceId: string; reason: string }> }>('/api/brain/work', { events });
    const saved = new Map((answer.saved ?? []).map((s) => [s.sourceId, s.id]));
    const rejected = new Map((answer.rejected ?? []).map((r) => [r.sourceId, r.reason]));
    entries = entries.map((e) => {
      if (!local.some((l) => l.sourceId === e.sourceId)) return e;
      if (saved.has(e.sourceId)) {
        const { error: _error, ...rest } = e;
        const next: HeldEntry = { ...rest, status: 'sent', sentAt: now.toISOString(), serverId: saved.get(e.sourceId) as string };
        sent.push(next);
        return next;
      }
      const next = { ...e, error: rejected.get(e.sourceId) ?? 'The host did not save it' };
      refused.push(next);
      return next;
    });
    writeHeld(configFile(ctx), entries, now);
  }
  entries = writeHeld(configFile(ctx), entries, now);
  return { entries, sent, refused };
}

/**
 * The one guard in front of every send: with no terminal it needs --yes, and a host that forbids automatic sending
 * (brain.workAutoSend) refuses it. A briefing that cannot be read refuses too, since the setting is unknown.
 */
async function guardUnattended(ctx: Context, yes: boolean) {
  if (ctx.io.interactive) return;
  if (!yes) throw usage('Refusing to send without a terminal: pass --yes');
  let briefing: { autoSend?: string };
  try {
    briefing = await ctx.client.get<{ autoSend?: string }>('/api/brain/briefing');
  } catch (caught) {
    throw new CliError('forbidden', `Refusing to send without a terminal: could not read the host's brain.workAutoSend setting (${caught instanceof Error ? caught.message : 'unknown error'})`);
  }
  if (briefing.autoSend === 'forbidden') throw new CliError('forbidden', 'This host does not allow tools to send work on their own (brain.workAutoSend): send from a terminal');
}

const sentResult = (sent: HeldEntry[], refused: HeldEntry[], extra: Json = {}) => ({
  data: { ...extra, sent: sent.map(view), refused: refused.map(view) },
  human: () =>
    [
      sent.length ? `Sent ${plural(sent.length, 'entry')}:\n${entryTable(sent, '')}` : 'Nothing was sent.',
      refused.length ? `Not accepted:\n${entryTable(refused, '')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
});

export const collect: Command = {
  name: 'work collect',
  summary: 'Collect your day’s commits and PRs in allowed repositories and hold them for review',
  usage: '[--since today|yesterday|<ISO>] [--repo <path>]…',
  details:
    'Reads commit subjects, branch names and the directories touched (never a diff or a file) from the repositories on the allow-list (landflow work repos add), and summarises them here without a model. Pull requests come from `gh` when it is installed. Entries are held on this machine: nothing is sent until you run `landflow work review --send` or `landflow work send`. Collecting a day again updates its entry.',
  flags: {
    since: flag.string('From this day on: today (default), yesterday, or an ISO date or time', 'when'),
    repo: { type: 'string', multiple: true, description: 'Only this working copy (must be on the allow-list)', placeholder: 'path' },
  },
  args: { max: 0 },
  async run(ctx) {
    const since = resolveSince(ctx.flags.since as string | undefined);
    const allowed = readRepos(configFile(ctx));
    const asked = ((ctx.flags.repo as string[] | undefined) ?? []).map((p) => resolve(ctx.io.cwd, p));
    const skipped: Array<{ path: string; reason: string }> = [];
    let chosen: AllowedRepo[] = allowed;
    if (asked.length) {
      chosen = [];
      for (const path of asked) {
        const hit = allowed.find((r) => r.path === path);
        if (hit) chosen.push(hit);
        else skipped.push({ path, reason: 'not on the allow-list: landflow work repos add <path>' });
      }
    } else if (!allowed.length) ctx.note('No repositories are allowed yet: landflow work repos add <path>');
    const run = runner(ctx);
    const now = new Date();
    let entries = readHeld(configFile(ctx));
    const touched: HeldEntry[] = [];
    const notes: string[] = [];
    for (const repo of chosen) {
      const origin = await originRepo(run, repo.path);
      if (!origin || origin !== repo.repo) {
        skipped.push({ path: repo.path, reason: origin ? `origin is now ${origin}, not ${repo.repo}: add it again` : 'no origin remote' });
        continue;
      }
      const collected = await collectRepo(run, repo.path, since);
      for (const note of collected.notes) notes.push(`${repo.repo}: ${note}`);
      for (const { day, event } of summarizeRepo(repo.repo, collected)) {
        const result = upsert(entries, event, day, now);
        entries = result.entries;
        touched.push(result.entry);
      }
    }
    writeHeld(configFile(ctx), entries, now);
    for (const note of new Set(notes)) ctx.note(note);
    return {
      data: { since, entries: touched.map(view), skipped, notes: [...new Set(notes)] },
      human: () =>
        [
          touched.length ? `Held ${plural(touched.length, 'entry')} (nothing is sent yet):\n${entryTable(touched, '')}\n\nReview and send: landflow work review` : 'No work found.',
          ...skipped.map((s) => `Skipped ${s.path}: ${s.reason}`),
        ].join('\n'),
    };
  },
};

export const review: Command = {
  name: 'work review',
  summary: 'List the held entries; send, drop or retitle them',
  usage: '[--send <id|all>] [--drop <id>] [--title <id> <text>]',
  details: 'With no option it lists what is held. --title takes the entry id and the new title as the argument. Sending is the only thing that leaves this machine.',
  flags: {
    send: flag.string('Send this entry (its id), or all held entries', 'id|all'),
    yes: flag.boolean('Send without a terminal (with --send)', 'y'),
    drop: flag.string('Drop this entry; it is never sent', 'id'),
    title: flag.string('Change this entry’s title to the text that follows', 'id'),
  },
  args: { max: 1 },
  async run(ctx) {
    let entries = readHeld(configFile(ctx));
    const now = new Date();
    if (ctx.flags.title) {
      const text = ctx.args[0]?.trim();
      if (!text) throw usage('--title <id> needs the new title as an argument');
      const [target] = entriesFor(entries, String(ctx.flags.title), ['held']);
      if (target.status === 'sent') throw new CliError('conflict', 'That entry is already sent: collect the day again to change it');
      const event = { ...target.event, title: text };
      const checked = validateWorkEvent(event);
      if (!checked.ok) throw usage(checked.errors.join('; '));
      entries = entries.map((e) => (e.sourceId === target.sourceId ? { ...e, event: checked.value, titleEdited: true } : e));
    }
    if (ctx.flags.drop) {
      const [target] = entriesFor(entries, String(ctx.flags.drop));
      entries = entries.map((e) => (e.sourceId === target.sourceId ? { ...e, status: 'dropped' as const } : e));
    } else if (ctx.args[0] && !ctx.flags.title) throw usage('Unexpected argument: landflow work review --help');
    entries = writeHeld(configFile(ctx), entries, now);
    let sent: HeldEntry[] = [];
    let refused: HeldEntry[] = [];
    if (ctx.flags.send) {
      await guardUnattended(ctx, Boolean(ctx.flags.yes));
      const targets = entriesFor(entries, String(ctx.flags.send), ['held']).filter((e) => e.status === 'held');
      ({ entries, sent, refused } = await sendEntries(ctx, entries, targets));
    }
    const held = entries.filter((e) => e.status === 'held');
    return {
      data: { entries: entries.filter((e) => e.status !== 'dropped').map(view), held: held.length, sent: sent.map(view), refused: refused.map(view) },
      human: () =>
        [ctx.flags.send ? sentResult(sent, refused).human() : '', `${plural(held.length, 'entry')} held${held.length ? `:\n${entryTable(held, '')}` : '.'}`].filter(Boolean).join('\n\n'),
    };
  },
};

export const send: Command = {
  name: 'work send',
  summary: 'Send everything held to the company brain',
  usage: '[--yes]',
  details: 'Asks first on a terminal. Without a terminal it refuses unless you pass --yes, and then only when the host allows tools to send work on their own (brain.workAutoSend).',
  flags: { yes: flag.boolean('Send without asking', 'y') },
  args: { max: 0 },
  async run(ctx) {
    const entries = readHeld(configFile(ctx));
    const held = entries.filter((e) => e.status === 'held');
    if (!held.length) return { data: { sent: [], refused: [] }, human: () => 'Nothing is held.' };
    await guardUnattended(ctx, Boolean(ctx.flags.yes));
    if (!ctx.flags.yes) {
      ctx.io.stderr(`${entryTable(held, '')}\n`);
      const answer = (await ctx.io.prompt(`Send ${plural(held.length, 'entry')} to ${ctx.connection.url}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return { data: { sent: [], refused: [], cancelled: true }, human: () => 'Cancelled. Nothing was sent.' };
    }
    const { sent, refused } = await sendEntries(ctx, entries, held);
    return sentResult(sent, refused);
  },
};

export const status: Command = {
  name: 'work status',
  summary: 'What was sent to the brain, with ids',
  usage: '',
  args: { max: 0 },
  async run(ctx) {
    const entries = readHeld(configFile(ctx));
    const sent = entries.filter((e) => e.status === 'sent').sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
    const held = entries.filter((e) => e.status === 'held').length;
    return {
      data: { held, sent: sent.map(view) },
      human: () =>
        [
          sent.length
            ? table(sent, [
                { label: 'id', value: (e) => e.id },
                { label: 'source id', value: (e) => e.sourceId, max: 50 },
                { label: 'sent', value: (e) => time(e.sentAt) },
                { label: 'brain id', value: (e) => e.serverId },
                { label: 'what', value: (e) => e.event.title, max: 60 },
              ])
            : 'Nothing was sent yet.',
          `${plural(held, 'entry')} held.`,
        ].join('\n'),
    };
  },
};

export const forget: Command = {
  name: 'work forget',
  summary: 'Delete a sent entry from the brain and from this machine',
  usage: '<sourceId>',
  args: { min: 1, max: 1 },
  async run(ctx) {
    const sourceId = ctx.args[0];
    const entries = readHeld(configFile(ctx));
    const local = entries.find((e) => e.sourceId === sourceId || e.id === sourceId);
    const target = local?.sourceId ?? sourceId;
    let deleted = true;
    try {
      await ctx.client.delete(`/api/brain/work/${seg(target)}?source=${WORK_SOURCE}`);
    } catch (caught) {
      if (!(caught instanceof CliError && caught.code === 'not_found')) throw caught;
      deleted = false;
    }
    if (!deleted && !local) throw new CliError('not_found', `No work "${sourceId}" here or in the brain`);
    writeHeld(configFile(ctx), entries.filter((e) => e.sourceId !== target));
    return { data: { sourceId: target, deletedOnHost: deleted, deletedLocally: Boolean(local) }, human: () => `Forgot ${target}${deleted ? '' : ' (the brain had no such row)'}.` };
  },
};

export const repos: Command = {
  name: 'work repos',
  summary: 'The repositories landflow work may read: add, remove, list',
  usage: 'add [<path>] | remove <path> | list',
  details: 'A repository is allowed by the path of its working copy; its `origin` names it (owner/name). `add` with no path allows the current directory.',
  args: { min: 1, max: 2 },
  async run(ctx) {
    const [action, rawPath] = ctx.args;
    const file = configFile(ctx);
    const repos = readRepos(file);
    if (action === 'list') {
      if (rawPath) throw usage('landflow work repos list takes no path');
      return { data: { repos }, human: () => table(repos, [{ label: 'repo', value: (r) => r.repo }, { label: 'path', value: (r) => r.path }], 'No repositories are allowed yet: landflow work repos add <path>') };
    }
    if (action !== 'add' && action !== 'remove') throw usage('landflow work repos add [<path>] | remove <path> | list');
    if (action === 'remove' && !rawPath) throw usage('landflow work repos remove <path>');
    const path = rawPath ? (isAbsolute(rawPath) ? resolve(rawPath) : resolve(ctx.io.cwd, rawPath)) : ctx.io.cwd;
    if (action === 'remove') {
      const next = repos.filter((r) => r.path !== path && r.repo !== rawPath);
      if (next.length === repos.length) throw new CliError('not_found', `${rawPath} isn't on the allow-list`);
      writeRepos(file, next);
      return { data: { repos: next }, human: () => `Removed ${rawPath}.` };
    }
    try {
      if (!statSync(path).isDirectory()) throw new Error();
    } catch {
      throw usage(`${path} is not a directory`);
    }
    const repo = await originRepo(runner(ctx), path);
    if (!repo) throw usage(`${path} has no git origin remote that names owner/name`);
    const next = [...repos.filter((r) => r.path !== path), { path, repo }].sort((a, b) => a.path.localeCompare(b.path));
    writeRepos(file, next);
    return { data: { repos: next, added: { path, repo } }, human: () => `Allowed ${repo} at ${path}.` };
  },
};

export const workCommands: Command[] = [collect, review, send, status, forget, repos];
