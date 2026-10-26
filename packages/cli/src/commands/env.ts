/**
 * `env status/promote/pull` — environments (LANDFLOW_ENVIRONMENT on the host): see which environment a host is and
 * whether it is protected, promote its Git branch to another environment's branch (all workflows or some, with a
 * diff preview and conflict detection, the definitions of the credentials they use and the rows of opted-in data
 * tables), and pull the host's own branch with its publish-on-pull choice. Conflicts exit 5 (`conflict`) with the
 * preview in `error.details`, like `source-control pull`; with four-eyes on, a promotion is a request for another
 * person's approval: exit 8 (`approval_pending`) with the request in `error.details.request`.
 */
import { flag, type Command } from '../command';
import { CliError, usage } from '../errors';
import { fields, plural, table } from '../output';

interface EnvironmentView {
  name?: string;
  protected: boolean;
  protectedSource: 'env' | 'settings' | 'none';
  branch?: string;
  environments: Array<{ name: string; branch: string; current: boolean }>;
  publishOnPull: 'file' | 'all' | 'none';
  credentialMap: Array<{ type: string; name: string; credentialId: string; credentialName?: string }>;
  sourceControl: boolean;
}

interface PromotionEntry {
  id: string;
  name: string;
  path?: string;
  targetPath?: string;
  status: 'added' | 'modified' | 'unchanged' | 'deleted';
  conflict?: string;
  diff?: string;
  fields?: string[];
}

interface PromotionResult {
  dryRun: boolean;
  from: { environment: string; branch: string; commit: string };
  to: { environment: string; branch: string; commit?: string };
  entries: PromotionEntry[];
  conflicts: number;
  files: Array<{ status: string; path: string; diff?: string }>;
  credentials?: Array<{ name: string; type: string; status: string; secretFields: string[]; mapped: string[] }>;
  tables?: Array<{ id: string; name: string; path: string; rows: number; status: string }>;
  promoted: boolean;
  commit?: string;
  warnings: string[];
  error?: string;
  /** Four-eyes: 202, a request instead of a promotion. */
  approvalRequired?: boolean;
  request?: { id: string; source: string; target: string; status: string };
}

interface PullChange {
  kind: string;
  action: string;
  id: string;
  name: string;
  path?: string;
  fields?: string[];
  conflict?: string;
  skipped?: string;
}

interface PullResult {
  dryRun: boolean;
  applied: boolean;
  appliedCount: number;
  changes: PullChange[];
  conflicts: number;
  warnings: string[];
  errors: string[];
  hashes?: Record<string, string>;
  commit: string;
  branch: string;
  error?: string;
}

const PUBLISH = ['file', 'all', 'none'];

export const envStatus: Command = {
  name: 'env status',
  summary: 'The host’s environment, whether it is protected, and the environments’ branches',
  args: { max: 0 },
  async run(ctx) {
    const view = await ctx.client.get<EnvironmentView>('/api/environment');
    return {
      data: { environment: view },
      human: () =>
        view.name
          ? [
              fields([
                ['Environment', view.name],
                ['Protected', view.protected ? `yes${view.protectedSource === 'env' ? ' (LANDFLOW_ENVIRONMENT_PROTECTED)' : ''}: workflows change only by pull or promotion` : 'no'],
                ['Branch', view.branch ?? (view.sourceControl ? '' : 'source control is not set up')],
                ['On pull', view.publishOnPull],
                ['Credential mappings', String(view.credentialMap.length)],
              ]),
              table(view.environments, [
                { label: 'environment', value: (e) => `${e.name}${e.current ? ' (this host)' : ''}` },
                { label: 'branch', value: (e) => e.branch },
              ]),
            ].join('\n\n')
          : 'This host has no environment (LANDFLOW_ENVIRONMENT is not set).',
    };
  },
};

const statusOf = (e: PromotionEntry) => (e.conflict ? 'conflict' : e.status);

export const envPromote: Command = {
  name: 'env promote',
  summary: 'Promote this environment’s branch to another environment’s branch (all workflows or some)',
  usage: '<environment> [--workflow <id|name>]… [--rows <table>]… [--no-credentials] [--dry-run] [--diff] [--force] [--prune] [--message <text>]',
  details:
    'Copies the workflows of this host’s branch, as pushed (run `source-control push` first), onto the target environment’s branch, keeping each workflow’s publication there, ' +
    'with the definitions of the credentials they use (name, type, non-secret fields; secret fields stay empty or take their $secrets mapping) and the rows of the data tables ' +
    'opted in on the host (or --rows). A workflow the target changed since the last promotion is a conflict: the promotion stops (exit 5) unless --force. With four-eyes on, ' +
    'the promotion waits for another person’s approval (exit 8). The target then pulls (`env pull` there).',
  flags: {
    workflow: { ...flag.string('A workflow to promote (id or name); all workflows when left out', 'id'), multiple: true, short: 'w' },
    from: flag.string('The environment to promote from (default: the host’s)', 'environment'),
    'dry-run': flag.boolean('Preview: what would change, with conflicts', 'n'),
    diff: flag.boolean('Print each workflow’s diff'),
    force: flag.boolean('Promote over conflicts', 'f'),
    prune: flag.boolean('With all workflows: remove the target’s workflows this branch doesn’t have'),
    message: flag.string('The commit message', 'text', 'm'),
    rows: { ...flag.string('A data table (id or name) whose rows go along; replaces the host’s row tables for this promotion', 'table'), multiple: true },
    'no-rows': flag.boolean('Copy no data table rows'),
    'no-credentials': flag.boolean('Leave the credentials’ definitions out'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const target = ctx.args[0];
    const workflows = (ctx.flags.workflow as string[] | undefined) ?? [];
    const rowTables = (ctx.flags.rows as string[] | undefined) ?? [];
    if (rowTables.length && ctx.flags['no-rows']) throw usage('--rows and --no-rows don’t go together');
    const dryRun = Boolean(ctx.flags['dry-run']);
    const response = await ctx.client.request<PromotionResult>('POST', '/api/environment/promote', {
      body: {
        target,
        ...(ctx.flags.from ? { source: String(ctx.flags.from) } : {}),
        ...(workflows.length && { workflows }),
        dryRun,
        force: Boolean(ctx.flags.force),
        prune: Boolean(ctx.flags.prune),
        ...(ctx.flags.message ? { message: String(ctx.flags.message) } : {}),
        ...(rowTables.length ? { rowTables } : ctx.flags['no-rows'] ? { rowTables: [] } : {}),
        ...(ctx.flags['no-credentials'] ? { credentials: false } : {}),
      },
      accept: [409],
    });
    const { error, ...result } = response.body;
    if (response.status === 409) {
      if (result.entries) throw new CliError('conflict', `${error ?? 'Conflicts'}: review with --dry-run --diff, then promote with --force`, { status: 409, details: result });
      throw new CliError('conflict', error ?? 'Conflict', { status: 409 });
    }
    if (result.approvalRequired && result.request) {
      throw new CliError('approval_pending', `Promoting to ${result.request.target} needs approval: request ${result.request.id} is waiting for another owner or admin (Settings → Environments)`, {
        status: 202,
        details: { request: result.request },
      });
    }
    return {
      data: result,
      human: () => {
        const changed = result.entries.filter((e) => e.status !== 'unchanged');
        const route = `${result.from.environment} (${result.from.branch}) → ${result.to.environment} (${result.to.branch})`;
        const head = result.promoted
          ? `Promoted ${plural(changed.length, 'workflow')} ${route}: ${result.commit?.slice(0, 7)}. Pull on ${result.to.environment} to apply.`
          : dryRun
            ? `Promoting ${route} would change ${plural(changed.length, 'workflow')}${result.conflicts ? ` (${plural(result.conflicts, 'conflict')})` : ''}`
            : `Nothing to promote ${route}`;
        const rows = table(changed, [
          { label: 'status', value: statusOf },
          { label: 'workflow', value: (e) => e.name, max: 40 },
          { label: 'path', value: (e) => e.path ?? e.targetPath, max: 60 },
          { label: 'note', value: (e) => e.conflict ?? e.fields?.join(', '), max: 60 },
        ]);
        const diffs = ctx.flags.diff ? [...changed.map((e) => e.diff ?? ''), ...result.files.map((f) => f.diff ?? '')].filter(Boolean) : [];
        const files = result.files.map((f) => `  ${f.status} ${f.path}`);
        const credentials = (result.credentials ?? []).map((c) => {
          const empty = c.secretFields.filter((f) => !c.mapped.includes(f));
          return `  ${c.status} ${c.name} (${c.type})${c.mapped.length ? `, $secrets: ${c.mapped.join(', ')}` : ''}${empty.length ? `, empty: ${empty.join(', ')}` : ''}`;
        });
        const tables = (result.tables ?? []).map((t) => `  ${t.status} ${t.name}: ${plural(t.rows, 'row')}`);
        return [
          head,
          changed.length ? rows : '',
          credentials.length ? `Credential definitions:\n${credentials.join('\n')}` : '',
          tables.length ? `Data table rows:\n${tables.join('\n')}` : '',
          ...diffs,
          files.length ? `Other files:\n${files.join('\n')}` : '',
          ...result.warnings.map((w) => `warning: ${w}`),
        ]
          .filter(Boolean)
          .join('\n\n');
      },
    };
  },
};

export const envPull: Command = {
  name: 'env pull',
  summary: 'The host pulls its environment’s branch and applies it (publication per the environment’s setting)',
  usage: '[--dry-run] [--prune] [--force] [--publish file|all|none]',
  flags: {
    'dry-run': flag.boolean('Show the plan, change nothing', 'n'),
    prune: flag.boolean('Delete what the branch has no file for'),
    force: flag.boolean('Apply changes that conflict with edits made on the instance', 'f'),
    publish: flag.string('file: publish what is active in the branch; all: publish every pulled workflow; none: drafts only (default: the environment’s setting)', 'mode'),
  },
  args: { max: 0 },
  async run(ctx) {
    const publish = ctx.flags.publish === undefined ? undefined : String(ctx.flags.publish);
    if (publish !== undefined && !PUBLISH.includes(publish)) throw usage(`--publish is one of ${PUBLISH.join(', ')}`);
    const dryRun = Boolean(ctx.flags['dry-run']);
    const response = await ctx.client.request<PullResult>('POST', '/api/environment/pull', {
      body: { dryRun, prune: Boolean(ctx.flags.prune), force: Boolean(ctx.flags.force), ...(publish && { publish }) },
      accept: [400, 409],
    });
    const { error, hashes: _hashes, ...result } = response.body;
    if (response.status === 400 && result.changes) throw new CliError('sync_failed', error ?? 'The branch’s files are invalid', { status: 400, details: result });
    if (response.status === 409 && result.changes) throw new CliError('conflict', `${error ?? 'Conflicts'}: pull with --force to overwrite them`, { status: 409, details: result });
    if (response.status !== 200) throw new CliError(response.status === 409 ? 'conflict' : 'bad_request', error ?? `Pull failed with ${response.status}`, { status: response.status });
    if (result.errors.length) throw new CliError('sync_failed', `${plural(result.errors.length, 'change')} failed: ${result.errors[0]}`, { details: result });
    return {
      data: result,
      human: () => {
        const pending = result.changes.filter((c) => !c.skipped);
        const commit = result.commit.slice(0, 7);
        const head = dryRun ? `Pulling ${commit} would make ${plural(pending.length, 'change')}` : pending.length ? `Applied ${plural(result.appliedCount, 'change')} from ${commit}` : `Up to date with ${result.branch} (${commit})`;
        const rows = table(result.changes, [
          { label: 'action', value: (c) => c.action },
          { label: 'kind', value: (c) => c.kind },
          { label: 'name', value: (c) => c.name, max: 40 },
          { label: 'note', value: (c) => c.conflict ?? (c.skipped ? 'needs --prune' : c.fields?.join(', ')), max: 60 },
        ]);
        return [head, result.changes.length ? rows : '', ...result.warnings.map((w) => `warning: ${w}`)].filter(Boolean).join('\n\n');
      },
    };
  },
};

export const envCommands = [envStatus, envPromote, envPull];
