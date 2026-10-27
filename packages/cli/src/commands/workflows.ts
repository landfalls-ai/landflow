/** `workflows list/get/create/update/delete/activate/deactivate/publish/unpublish/schedules/unschedule`, and `publish`/`unpublish` as short forms. */
import { seg } from '../client';
import { flag, type Command, type Context } from '../command';
import { CliError, usage } from '../errors';
import { fields, table, time } from '../output';
import { attachCredentialIds, findFolder, findWorkflow, readJson, workflowSummary, type WorkflowSummary } from '../shared';

type Json = Record<string, unknown>;

const summaryTable = (rows: WorkflowSummary[]) =>
  table(
    rows,
    [
      { label: 'id', value: (w) => w.id },
      { label: 'name', value: (w) => w.name, max: 48 },
      { label: 'active', value: (w) => w.active },
      { label: 'nodes', value: (w) => w.nodeCount, align: 'right' },
      { label: 'tags', value: (w) => w.tags.join(', '), max: 30 },
      { label: 'updated', value: (w) => time(w.updatedAt) },
    ],
    'No workflows.',
  );

/** Server-managed fields a document from a file must not carry into a save. */
const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: Json) => rest;

/** The workflow JSON a `--file` names; a bare object or `{ workflow }`. */
async function workflowFromFile(ctx: Context, path: string): Promise<Json> {
  const raw = await readJson(ctx, path);
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) && 'workflow' in raw ? (raw as { workflow: unknown }).workflow : raw;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw usage(`${path} must hold a workflow object`);
  return doc as Json;
}

export const list: Command = {
  name: 'workflows list',
  summary: 'List workflows',
  usage: '[--search <text>] [--tag <tag>] [--folder <id|name>] [--active|--inactive]',
  flags: {
    search: flag.string('Only names containing this text', 'text'),
    tag: flag.string('Only workflows with this tag', 'tag'),
    folder: flag.string('Only workflows in this folder', 'id|name'),
    active: flag.boolean('Only active workflows'),
    inactive: flag.boolean('Only inactive workflows'),
  },
  args: { max: 0 },
  async run(ctx) {
    const { workflows } = await ctx.client.get<{ workflows: Json[] }>('/api/workflows');
    const folderId = ctx.flags.folder ? await findFolder(ctx.client, String(ctx.flags.folder)) : undefined;
    const search = String(ctx.flags.search ?? '').toLowerCase();
    const rows = workflows
      .map(workflowSummary)
      .filter((w) => !search || w.name.toLowerCase().includes(search))
      .filter((w) => !ctx.flags.tag || w.tags.includes(String(ctx.flags.tag)))
      .filter((w) => !folderId || w.folderId === folderId)
      .filter((w) => (ctx.flags.active ? w.active : ctx.flags.inactive ? !w.active : true))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { data: { workflows: rows }, human: () => summaryTable(rows) };
  },
};

export const get: Command = {
  name: 'workflows get',
  summary: 'Show a workflow (by id or name); --json prints the whole document',
  usage: '<workflow>',
  args: { min: 1, max: 1 },
  async run(ctx) {
    const workflow = await findWorkflow(ctx.client, ctx.args[0]);
    const summary = workflowSummary(workflow);
    const nodes = (workflow.nodes as Json[] | undefined) ?? [];
    return {
      data: { workflow },
      human: () =>
        [
          fields([
            ['ID', summary.id],
            ['Name', summary.name],
            ['Active', summary.active],
            ['Folder', summary.folderId],
            ['Tags', summary.tags.join(', ')],
            ['Updated', time(summary.updatedAt)],
          ]),
          table(
            nodes,
            [
              { label: 'node', value: (n) => String(n.name), max: 40 },
              { label: 'type', value: (n) => String(n.type) },
              { label: 'disabled', value: (n) => Boolean(n.disabled) },
            ],
            'No nodes.',
          ),
        ].join('\n\n'),
    };
  },
};

export const create: Command = {
  name: 'workflows create',
  summary: 'Create a workflow from a JSON file (Landflow format; use `import` for n8n)',
  usage: '--file <path|-> [--name <name>] [--folder <id|name>]',
  flags: { file: flag.string('Workflow JSON file, or - for stdin', 'path|-', 'f'), name: flag.string('Override the name', 'name'), folder: flag.string('Put it in this folder', 'id|name') },
  args: { max: 0 },
  async run(ctx) {
    if (!ctx.flags.file) throw usage('Give the workflow with --file <path> (or --file - for stdin)');
    const doc = strip(await workflowFromFile(ctx, String(ctx.flags.file)));
    const warnings = await attachCredentialIds(ctx.client, doc);
    if (ctx.flags.name) doc.name = ctx.flags.name;
    if (ctx.flags.folder) doc.folderId = await findFolder(ctx.client, String(ctx.flags.folder));
    const { workflow } = await ctx.client.post<{ workflow: Json }>('/api/workflows', doc);
    warnings.forEach((w) => ctx.note(`warning: ${w}`));
    return { data: { workflow, warnings }, human: () => `Created ${workflow.id} “${workflow.name}”` };
  },
};

export const update: Command = {
  name: 'workflows update',
  summary: 'Replace a workflow’s content from a JSON file, or rename it',
  usage: '<workflow> [--file <path|->] [--name <name>]',
  details: 'Fields in the file replace the saved ones; fields it leaves out are kept. Saving an active workflow makes a draft: publish it to go live.',
  flags: { file: flag.string('Workflow JSON file, or - for stdin', 'path|-', 'f'), name: flag.string('New name', 'name') },
  args: { min: 1, max: 1 },
  async run(ctx) {
    if (!ctx.flags.file && !ctx.flags.name) throw usage('Give --file and/or --name');
    const existing = await findWorkflow(ctx.client, ctx.args[0]);
    const doc = ctx.flags.file ? strip(await workflowFromFile(ctx, String(ctx.flags.file))) : {};
    const warnings = await attachCredentialIds(ctx.client, doc);
    const next = { ...strip(existing), ...doc, id: existing.id, ...(ctx.flags.name ? { name: ctx.flags.name } : {}) };
    const { workflow } = await ctx.client.put<{ workflow: Json }>(`/api/workflows/${seg(String(existing.id))}`, next);
    warnings.forEach((w) => ctx.note(`warning: ${w}`));
    return { data: { workflow, warnings }, human: () => `Updated ${workflow.id} “${workflow.name}”` };
  },
};

export const remove: Command = {
  name: 'workflows delete',
  summary: 'Delete a workflow (asks first unless --yes)',
  usage: '<workflow> [--yes]',
  flags: { yes: flag.boolean('Don’t ask', 'y') },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const workflow = await findWorkflow(ctx.client, ctx.args[0]);
    if (!ctx.flags.yes) {
      if (!ctx.io.interactive) throw usage('Deleting needs --yes when not run interactively');
      const answer = await ctx.io.prompt(`Delete “${workflow.name}” (${workflow.id})? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('usage', 'Not deleted');
    }
    await ctx.client.delete(`/api/workflows/${seg(String(workflow.id))}`);
    const deleted = { id: String(workflow.id), name: String(workflow.name) };
    return { data: { deleted }, human: () => `Deleted ${deleted.id} “${deleted.name}”` };
  },
};

/**
 * Four-eyes publishing (the host answers 202 with `approvalRequired`): nothing changed yet, a request waits for someone
 * else's approval. Reported as `approval_pending` (exit 8) with the request in `details.request`.
 */
function assertNotPending(result: Json, what: string, workflow: Json) {
  if (result.approvalRequired !== true) return;
  const request = (result.request ?? {}) as Json;
  throw new CliError('approval_pending', `${what} “${workflow.name}” needs approval: request ${String(request.id ?? '')} is waiting for another person (Settings → Governance)`, {
    status: 202,
    details: { workflowId: String(workflow.id), request },
  });
}

/** Turn a workflow on or off: publish/unpublish when the host has draft and publish, else the `active` flag. */
async function setActive(ctx: Context, active: boolean) {
  const existing = await findWorkflow(ctx.client, ctx.args[0]);
  const id = seg(String(existing.id));
  try {
    assertNotPending(await ctx.client.post<Json>(`/api/workflows/${id}/${active ? 'publish' : 'unpublish'}`, {}), active ? 'Activating' : 'Deactivating', existing);
  } catch (caught) {
    if (!(caught instanceof CliError) || caught.code !== 'not_supported') throw caught;
    await ctx.client.put(`/api/workflows/${id}`, { ...strip(existing), active });
  }
  const workflow = workflowSummary((await ctx.client.get<{ workflow: Json }>(`/api/workflows/${id}`)).workflow);
  return { data: { workflow }, human: () => `${workflow.active ? 'Activated' : 'Deactivated'} ${workflow.id} “${workflow.name}”` };
}

export const activate: Command = {
  name: 'workflows activate',
  summary: 'Turn a workflow’s triggers on (publishes the saved draft on hosts with draft and publish)',
  usage: '<workflow>',
  args: { min: 1, max: 1 },
  run: (ctx) => setActive(ctx, true),
};

export const deactivate: Command = {
  name: 'workflows deactivate',
  summary: 'Turn a workflow’s triggers off (unpublishes it)',
  usage: '<workflow>',
  args: { min: 1, max: 1 },
  run: (ctx) => setActive(ctx, false),
};

const publicationOf = (result: Json) => {
  const published = result.published as Json | undefined;
  return {
    published: published ? { versionId: String(published.versionId), versionNumber: (published.versionNumber as number | undefined) ?? null, publishedAt: String(published.publishedAt) } : null,
    unpublishedChanges: Boolean(result.unpublishedChanges),
    triggerErrors: (result.triggerErrors as unknown[] | undefined) ?? [],
  };
};

/**
 * `--at`: a time to publish at: ISO 8601 (`2026-11-02T09:00:00Z`, or local time without a zone) or relative (`+30m`,
 * `+2h`, `+1d`). Returns the ISO instant.
 */
export function parseAt(text: string, now = Date.now()): string {
  const relative = /^\+(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(text.trim());
  const at = relative ? new Date(now + Number(relative[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2].toLowerCase() as 's' | 'm' | 'h' | 'd']) : new Date(text.trim());
  if (Number.isNaN(at.getTime())) throw usage(`--at “${text}” is not a time: use ISO 8601 (2026-11-02T09:00:00Z) or +30m, +2h, +1d`);
  if (at.getTime() <= now) throw usage('--at has to be in the future');
  return at.toISOString();
}

interface ScheduledView {
  id: string;
  action: string;
  versionNumber?: number;
  runAt: string;
  status: string;
  requestId?: string;
  note?: string;
  result?: string;
}

const scheduleLine = (s: ScheduledView) => `${s.id}  ${s.action}${s.versionNumber ? ` v${s.versionNumber}` : ''}  ${time(s.runAt)}  ${s.status}${s.status === 'awaiting_approval' && s.requestId ? ` (request ${s.requestId})` : ''}`;

const AT_FLAG = flag.string('Schedule it for this time instead (ISO 8601, or +30m, +2h, +1d); four-eyes publishing: it waits for approval first', 'time');

function publishCommand(name: string): Command {
  return {
    name,
    summary: 'Publish the saved draft, or a version (--version), so production triggers run it; --at schedules it',
    usage: '<workflow> [--version <versionId>] [--note <text>] [--at <time>]',
    flags: { version: flag.string('Publish this version instead of the draft (a rollback)', 'versionId'), note: flag.string('A note for the publish timeline', 'text'), at: AT_FLAG },
    args: { min: 1, max: 1 },
    run: runPublish,
  };
}

async function runPublish(ctx: Context) {
  const workflow = await findWorkflow(ctx.client, ctx.args[0]);
  const body = { ...(ctx.flags.version ? { versionId: ctx.flags.version } : {}), ...(ctx.flags.note ? { note: ctx.flags.note } : {}) };
  if (ctx.flags.at) {
    const { scheduled } = await ctx.client.post<{ scheduled: ScheduledView }>(`/api/workflows/${seg(String(workflow.id))}/publish`, { ...body, at: parseAt(String(ctx.flags.at)) });
    return { data: { workflowId: String(workflow.id), scheduled }, human: () => `Scheduled publishing “${workflow.name}”${scheduled.versionNumber ? ` (version ${scheduled.versionNumber})` : ''} for ${time(scheduled.runAt)}${scheduled.status === 'awaiting_approval' ? `: waiting for approval first (request ${scheduled.requestId})` : ''}  [${scheduled.id}]` };
  }
  let result: Json;
  try {
    result = await ctx.client.post<Json>(`/api/workflows/${seg(String(workflow.id))}/publish`, body);
  } catch (caught) {
    if (caught instanceof CliError && caught.code === 'not_supported') throw new CliError('not_supported', 'This host has no draft and publish: use `landflow workflows activate`');
    throw caught;
  }
  assertNotPending(result, ctx.flags.version ? 'Publishing a version of' : 'Publishing', workflow);
  const publication = publicationOf(result);
  return {
    data: { workflowId: String(workflow.id), ...publication },
    human: () => `Published “${workflow.name}”${publication.published?.versionNumber ? ` at version ${publication.published.versionNumber}` : ''}`,
  };
}

export const publish = publishCommand('workflows publish');
export const publishShort = publishCommand('publish');

function unpublishCommand(name: string): Command {
  return { name, summary: 'Unpublish a workflow: production triggers stop; --at schedules it', usage: '<workflow> [--note <text>] [--at <time>]', flags: { note: flag.string('A note for the publish timeline', 'text'), at: AT_FLAG }, args: { min: 1, max: 1 }, run: runUnpublish };
}

async function runUnpublish(ctx: Context) {
  const workflow = await findWorkflow(ctx.client, ctx.args[0]);
  if (ctx.flags.at) {
    const { scheduled } = await ctx.client.post<{ scheduled: ScheduledView }>(`/api/workflows/${seg(String(workflow.id))}/unpublish`, { ...(ctx.flags.note ? { note: ctx.flags.note } : {}), at: parseAt(String(ctx.flags.at)) });
    return { data: { workflowId: String(workflow.id), scheduled }, human: () => `Scheduled unpublishing “${workflow.name}” for ${time(scheduled.runAt)}${scheduled.status === 'awaiting_approval' ? `: waiting for approval first (request ${scheduled.requestId})` : ''}  [${scheduled.id}]` };
  }
  let result: Json;
  try {
    result = await ctx.client.post<Json>(`/api/workflows/${seg(String(workflow.id))}/unpublish`, ctx.flags.note ? { note: ctx.flags.note } : {});
  } catch (caught) {
    if (caught instanceof CliError && caught.code === 'not_supported') throw new CliError('not_supported', 'This host has no draft and publish: use `landflow workflows deactivate`');
    throw caught;
  }
  assertNotPending(result, 'Unpublishing', workflow);
  return { data: { workflowId: String(workflow.id), ...publicationOf(result) }, human: () => `Unpublished “${workflow.name}”` };
}

export const unpublish = unpublishCommand('workflows unpublish');
export const unpublishShort = unpublishCommand('unpublish');

export const schedules: Command = {
  name: 'workflows schedules',
  summary: 'List a workflow’s scheduled publishes (waiting ones first)',
  usage: '<workflow>',
  args: { min: 1, max: 1 },
  async run(ctx) {
    const workflow = await findWorkflow(ctx.client, ctx.args[0]);
    const { schedules: rows } = await ctx.client.get<{ schedules: ScheduledView[] }>(`/api/workflows/${seg(String(workflow.id))}/schedules`);
    return { data: { workflowId: String(workflow.id), schedules: rows }, human: () => (rows.length ? rows.map(scheduleLine).join('\n') : 'No scheduled publishes.') };
  },
};

export const unschedule: Command = {
  name: 'workflows unschedule',
  summary: 'Cancel a scheduled publish that has not run',
  usage: '<workflow> <scheduleId>',
  args: { min: 2, max: 2 },
  async run(ctx) {
    const workflow = await findWorkflow(ctx.client, ctx.args[0]);
    const { scheduled } = await ctx.client.delete<{ scheduled: ScheduledView }>(`/api/workflows/${seg(String(workflow.id))}/schedules/${seg(ctx.args[1])}`);
    return { data: { workflowId: String(workflow.id), scheduled }, human: () => `Canceled ${scheduled.id}` };
  },
};

export const workflowCommands = [list, get, create, update, remove, activate, deactivate, publish, unpublish, publishShort, unpublishShort, schedules, unschedule];
