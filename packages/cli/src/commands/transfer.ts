/** `import` (Landflow or n8n JSON) and `export` (workflows as Git sync files). */
import { resolve } from 'node:path';
import { flag, type Command } from '../command';
import { CliError, usage } from '../errors';
import { plural } from '../output';
import { attachCredentialIds, findFolder, findWorkflow, readJson, workflowSummary, type WorkflowSummary } from '../shared';
import { isManagedPath, isSafePath, WORKFLOW_SUFFIX, writeSyncDir, type SyncFiles } from '../sync/files';

type Json = Record<string, unknown>;

interface ImportReport {
  format: string;
  mapped?: unknown[];
  placeholders?: Array<{ name: string; type: string }>;
  stickyNotes?: number;
  connections?: number;
  warnings?: string[];
}

/** The workflows a file holds: one document, `{ workflow }`, n8n's `{ workflows: [...] }`, or an array of them. */
function documentsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { workflows?: unknown }).workflows) && !('nodes' in raw)) return (raw as { workflows: unknown[] }).workflows;
  return [raw];
}

export const importCommand: Command = {
  name: 'import',
  summary: 'Create workflows from Landflow or n8n workflow JSON files (or - for stdin)',
  usage: '<file|->... [--name <name>] [--folder <id|name>]',
  details:
    'A file may hold one workflow or an array of them (n8n’s export:workflow --all). n8n nodes are converted; nodes without a Landflow\n' +
    'equivalent become disabled placeholders (listed in the report). Credential references by name and type (as `export` writes\n' +
    'them) are matched to this host’s credentials.',
  flags: { name: flag.string('Name the workflow (one workflow only)', 'name'), folder: flag.string('Put the workflows in this folder', 'id|name') },
  args: { min: 1 },
  async run(ctx) {
    const folderId = ctx.flags.folder ? await findFolder(ctx.client, String(ctx.flags.folder)) : undefined;
    const sources: Array<{ file: string; doc: unknown }> = [];
    for (const file of ctx.args) for (const doc of documentsOf(await readJson(ctx, file))) sources.push({ file, doc });
    if (ctx.flags.name && sources.length > 1) throw usage('--name names one workflow, and the files hold several');
    const imported: Array<{ file: string; workflow: WorkflowSummary; report: { format: string; placeholders: Array<{ name: string; type: string }>; warnings: string[] } }> = [];
    for (const { file, doc } of sources) {
      if (!doc || typeof doc !== 'object') throw new CliError('io', `${file} doesn't hold a workflow object`);
      const inner = ((doc as Json).workflow && typeof (doc as Json).workflow === 'object' ? (doc as Json).workflow : doc) as Json;
      const warnings = await attachCredentialIds(ctx.client, inner);
      const { workflow, report } = await ctx.client.post<{ workflow: Json; report: ImportReport }>('/api/workflows/import', {
        data: doc,
        ...(ctx.flags.name ? { name: ctx.flags.name } : {}),
        ...(folderId && { folderId }),
      });
      imported.push({
        file,
        workflow: workflowSummary(workflow),
        report: { format: String(report?.format ?? 'landflow'), placeholders: report?.placeholders ?? [], warnings: [...(report?.warnings ?? []), ...warnings] },
      });
    }
    return {
      data: { imported },
      human: () =>
        imported
          .map(({ file, workflow, report }) => {
            const notes = [...report.placeholders.map((p) => `  placeholder: ${p.name} (${p.type} has no Landflow equivalent)`), ...report.warnings.map((w) => `  warning: ${w}`)];
            return [`Imported ${workflow.id} “${workflow.name}” from ${file} (${report.format}, ${plural(workflow.nodeCount, 'node')})`, ...notes].join('\n');
          })
          .join('\n'),
    };
  },
};

interface ExportResult {
  format: string;
  files: Array<{ path: string; content: string }>;
}

export const exportCommand: Command = {
  name: 'export',
  summary: 'Export workflows as Git sync files: print one, or write them (or --all) into a directory',
  usage: '<workflow>... | --all  [--dir <path>]',
  details:
    'Without --dir the workflow documents are printed (one document, or an array with several): `landflow import` reads them back. Credentials appear as { name, type }, never their data.\nWith --dir the files are written in the sync layout; --all --dir makes the directory match the instance like `sync pull`, without its local-edit checks.',
  flags: {
    all: flag.boolean('Every workflow'),
    dir: flag.string('Write the files into this directory', 'path', 'd'),
    values: flag.boolean('With --dir: write variable values into variables.json'),
  },
  async run(ctx) {
    if (!ctx.flags.all && !ctx.args.length) throw usage('Name the workflows to export, or use --all');
    if (ctx.flags.all && ctx.args.length) throw usage('Give workflows or --all, not both');
    const ids: string[] = [];
    for (const ref of ctx.args) ids.push(String((await findWorkflow(ctx.client, ref)).id));
    const exported = await ctx.client.get<ExportResult>('/api/sync/export', { values: Boolean(ctx.flags.values), workflow: ids.length ? ids : undefined });
    const files: SyncFiles = new Map(exported.files.filter((f) => isSafePath(f.path) && isManagedPath(f.path)).map((f) => [f.path, f.content]));
    const workflows = [...files]
      .filter(([path]) => path.endsWith(WORKFLOW_SUFFIX))
      .map(([path, content]) => {
        const document = JSON.parse(content) as Json;
        return { id: String(document.id), name: String(document.name ?? ''), path, document };
      });
    if (ctx.flags.dir) {
      const dir = resolve(ctx.io.cwd, String(ctx.flags.dir));
      const { written, removed } = writeSyncDir(dir, files, { mirror: Boolean(ctx.flags.all) });
      return {
        data: { dir, workflows: workflows.map(({ document: _d, ...w }) => w), written: written.sort(), removed: removed.sort() },
        human: () => `Exported ${plural(workflows.length, 'workflow')} to ${dir} (${plural(written.length, 'file')} written${removed.length ? `, ${removed.length} removed` : ''})`,
      };
    }
    // In the order asked for (the files come sorted by path).
    const ordered = ids.length ? ids.map((id) => workflows.find((w) => w.id === id)).filter((w): w is (typeof workflows)[number] => Boolean(w)) : workflows;
    return {
      data: { workflows: ordered },
      human: () => JSON.stringify(ordered.length === 1 && !ctx.flags.all ? ordered[0].document : ordered.map((w) => w.document), null, 2),
    };
  },
};

export const transferCommands = [importCommand, exportCommand];
