/**
 * Debugging a run from a laptop: `debug-bundle` (a redacted folder about one execution), `replay` (a bundle's workflow
 * with its data pinned, run on a host you name), `claude init` (the MCP config and a skill for a local Claude Code)
 * and `executions watch` (node progress until the run ends).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { seg, Client } from '../client';
import { flag, type Command, type Context } from '../command';
import { CliError, usage } from '../errors';
import { duration, table } from '../output';
import { callTool } from '../mcp';
import { makeRedactor } from '../redact';
import { attachCredentialIds, describeExecution, executionDetail, failUnlessSucceeded, type ExecutionDetail } from '../shared';
import { VERSION } from '../version';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

// ---------------------------------------------------------------------------
// debug-bundle
// ---------------------------------------------------------------------------

/** Where a bundle's files go; a name is a path under the bundle. */
interface Bundle {
  files: Map<string, unknown>;
  skipped: Array<{ what: string; reason: string }>;
}

const reasonOf = (caught: unknown) => (caught instanceof CliError ? caught.message : (caught as Error).message);

export const debugBundle: Command = {
  name: 'debug-bundle',
  summary: 'Write a redacted folder about one execution: workflow, run data, trace, node types, plugin versions and logs',
  usage: '<execution> [--out <dir>] [--force] [--trace-limit <n>] [--no-logs]',
  details:
    'Reads the execution with the REST API and the host’s MCP tools (explain_failure, get_run_trace, get_node_type, get_plugin_logs), so the host\n' +
    'redacts what it returns; the CLI then redacts everything again: credentials (a name and type remain), $vars values (found on the host and removed\n' +
    'wherever they appear), keys named like a secret, bearer tokens and API keys. Run data is still your data: read the folder before you share it.\n' +
    'Whatever the key may not read (plugin logs need an instance admin) is skipped and listed in bundle.json under "skipped".',
  flags: {
    out: flag.string('The folder to write (default ./landflow-debug-<execution>)', 'dir', 'o'),
    force: flag.boolean('Write into a folder that already has files'),
    'trace-limit': flag.number('At most this many trace events (default 2000)', 'n'),
    'no-logs': flag.boolean('Leave out plugin logs'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const id = ctx.args[0];
    const out = resolve(ctx.io.cwd, String(ctx.flags.out ?? `landflow-debug-${slug(id)}`));
    if (existsSync(out) && !ctx.flags.force && (!statSync(out).isDirectory() || readdirSync(out).length)) {
      throw new CliError('conflict', `${out} already has files: pick another --out, or pass --force to write into it`);
    }
    const bundle: Bundle = { files: new Map(), skipped: [] };
    const skip = (what: string, caught: unknown) => bundle.skipped.push({ what, reason: reasonOf(caught) });

    const { execution } = await ctx.client.get<{ execution: Json }>(`/api/executions/${seg(id)}`);
    const workflow = isObject(execution.workflow) ? execution.workflow : undefined;
    const { workflow: snapshot, runData, resumeState: _resume, ...record } = execution as Json;
    let workflowDoc = workflow;
    if (!workflowDoc) {
      try {
        workflowDoc = (await ctx.client.get<{ workflow: Json }>(`/api/workflows/${seg(String(execution.workflowId))}`)).workflow;
        bundle.skipped.push({ what: 'workflow snapshot', reason: 'the execution has none: the workflow as saved now is bundled' });
      } catch (caught) {
        skip('workflow', caught);
      }
    }
    void snapshot;

    // Values that must not appear anywhere: $vars (by name from the host) and the key this command used.
    const secrets: string[] = [];
    if (ctx.connection.apiKey) secrets.push(ctx.connection.apiKey);
    try {
      const listed = await ctx.client.get<unknown>('/api/variables');
      const rows = Array.isArray(listed) ? listed : isObject(listed) && Array.isArray(listed.variables) ? listed.variables : [];
      for (const row of rows as Json[]) if (typeof row.value === 'string') secrets.push(row.value);
    } catch (caught) {
      skip('variables (used only to scrub values)', caught);
    }

    const detail = executionDetail(execution);
    bundle.files.set('execution.json', record);
    bundle.files.set('run-data.json', runData ?? {});
    if (workflowDoc) bundle.files.set('workflow.json', workflowDoc);

    try {
      bundle.files.set('explanation.json', await callTool(ctx.client, 'explain_failure', { id }));
    } catch (caught) {
      skip('explain_failure', caught);
    }

    const limit = Math.max(1, Number(ctx.flags['trace-limit'] ?? 2000));
    try {
      const events: unknown[] = [];
      let after = 0;
      let last: Json = {};
      for (;;) {
        const page = await callTool<{ events?: Array<{ seq: number }>; last?: number; more?: boolean }>(ctx.client, 'get_run_trace', { id, after, limit: Math.min(500, limit - events.length) });
        last = page as Json;
        events.push(...(page.events ?? []));
        if (!page.more || !page.events?.length || events.length >= limit) break;
        after = page.last ?? page.events.at(-1)!.seq;
      }
      bundle.files.set('trace.json', { executionId: id, status: last.status, events, truncated: Boolean(last.more) || undefined });
    } catch (caught) {
      skip('get_run_trace', caught);
    }

    // Node types the workflow uses, and the plugins that serve them.
    const nodes = Array.isArray(workflowDoc?.nodes) ? (workflowDoc!.nodes as Json[]) : [];
    const types = [...new Set(nodes.map((n) => String(n.type ?? '')).filter(Boolean))].sort();
    const manifests: Json = {};
    for (const type of types) {
      try {
        manifests[type] = await callTool(ctx.client, 'get_node_type', { type });
      } catch (caught) {
        skip(`node type ${type}`, caught);
      }
    }
    if (types.length) bundle.files.set('node-types.json', manifests);

    let plugins: Json[] = [];
    try {
      plugins = (await ctx.client.get<{ plugins: Json[] }>('/api/plugins')).plugins ?? [];
      bundle.files.set(
        'plugins.json',
        plugins.map((p) => ({ id: p.id, name: p.name, version: p.version, language: p.language, status: p.status, source: p.source, nodeTypes: p.nodeTypes })),
      );
    } catch (caught) {
      skip('plugin versions', caught);
    }

    if (!ctx.flags['no-logs']) {
      for (const type of types.filter((t) => !t.startsWith('core.'))) {
        try {
          bundle.files.set(`plugin-logs/${slug(type)}.json`, await callTool(ctx.client, 'get_plugin_logs', { plugin: type, tail: 200 }));
        } catch (caught) {
          skip(`plugin logs for ${type}`, caught);
        }
      }
    }

    const { redact, stats } = makeRedactor(secrets);
    const manifest = redact({
      format: 'landflow-debug-bundle/v1',
      cliVersion: VERSION,
      createdAt: new Date().toISOString(),
      host: ctx.client.url,
      executionId: id,
      workflowId: detail.workflowId,
      workflowName: detail.workflowName,
      status: detail.status,
      error: detail.error,
      failedNode: failedNode(detail, workflowDoc),
      nodeTypes: types,
      files: [] as string[],
      redaction: { credentialsKept: 'name and type only', vars: 'values removed wherever they appear', secretKeys: 'replaced with [redacted]', counts: stats },
      skipped: bundle.skipped,
    });
    mkdirSync(out, { recursive: true });
    const written: string[] = [];
    for (const [name, value] of bundle.files) {
      const target = join(out, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(redact(value), null, 2)}\n`);
      written.push(name);
    }
    written.push('bundle.json', 'README.md');
    (manifest as Json).files = written.sort();
    (manifest as Json).redaction = { ...(manifest.redaction as Json), counts: { ...stats } };
    writeFileSync(join(out, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(out, 'README.md'), bundleReadme(manifest));
    const data = { dir: out, executionId: id, status: detail.status, files: written, skipped: bundle.skipped, redaction: stats };
    return {
      data,
      human: () =>
        `Wrote ${written.length} files to ${out} (${stats.keys} secret keys and ${stats.values} values redacted)\n` +
        (bundle.skipped.length ? `Skipped:\n${bundle.skipped.map((s) => `  ${s.what}: ${s.reason}`).join('\n')}\n` : '') +
        `Read it before you share it. Replay it: landflow replay ${out} --target <scratch host url>`,
    };
  },
};

/** The node an execution failed in (id and name), from the error or the run data. */
function failedNode(detail: ExecutionDetail, workflow?: Json): { id: string; name: string } | null {
  const named = detail.error?.node ? detail.nodes.find((n) => n.name === detail.error?.node) : undefined;
  const found = named ?? detail.nodes.find((n) => n.status === 'error');
  if (found) return { id: found.id, name: found.name };
  const node = (Array.isArray(workflow?.nodes) ? (workflow!.nodes as Json[]) : []).find((n) => n.name === detail.error?.node);
  return node ? { id: String(node.id), name: String(node.name) } : null;
}

const bundleReadme = (m: Json) =>
  `# Debug bundle: ${String(m.workflowName)}\n\n` +
  `Execution ${String(m.executionId)} (${String(m.status)}) from ${String(m.host)}, written by landflow ${VERSION}.\n\n` +
  `| File | What |\n|---|---|\n` +
  `| bundle.json | this bundle: host, failed node, redaction counts, what was skipped and why |\n` +
  `| workflow.json | the workflow as the execution ran it (credentials by name and type) |\n` +
  `| execution.json, run-data.json | the execution record and every node's runs, items and errors |\n` +
  `| explanation.json | the host's explain_failure: failing node, resolved parameters, sample input, upstream fields, what to check |\n` +
  `| trace.json | the Run Trace journal |\n` +
  `| node-types.json | the manifest of each node type the workflow uses |\n` +
  `| plugins.json, plugin-logs/ | plugin versions and recent plugin logs |\n\n` +
  `Credentials keep a name and type only, $vars values and secret-named keys are redacted. Run data is still your data: read it before you share the folder.\n\n` +
  `Replay on a scratch host: \`landflow replay <this folder> --target http://localhost:3180\`.\n`;

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

const readBundleFile = (dir: string, name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));

/** The ids of every node that feeds `target`, directly or not. */
function ancestors(connections: Json[], target: string): Set<string> {
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const current = queue.pop()!;
    for (const c of connections) {
      if (c.target === current && typeof c.source === 'string' && !seen.has(c.source)) {
        seen.add(c.source);
        queue.push(c.source);
      }
    }
  }
  return seen;
}

export const replay: Command = {
  name: 'replay',
  summary: 'Run a debug bundle’s workflow on a scratch host with the recorded data pinned (without --target: print the steps)',
  usage: '<bundle> [--target <url>] [--target-key <key>] [--pin upstream|trigger|none] [--keep]',
  details:
    'What this does: it creates a copy of the bundle’s workflow on the host named by --target and runs it. Nodes before the failed node are pinned to the\n' +
    'output they gave in the original run, so only the failed node and what follows it execute again; --pin trigger pins only the trigger, --pin none nothing.\n' +
    'What it does not do: start a host (give it one: a dev host on another port, own data directory), restore credentials or $vars (the bundle holds none: nodes\n' +
    'that need them fail until you add them on the scratch host), or replay side effects against fakes for you (nodes after the pins call whatever they call).\n' +
    'Without --target (or when it is the host the bundle came from, unless --same-host) nothing runs: the exact steps are printed. The copy is deleted afterwards unless --keep.',
  flags: {
    target: flag.string('The scratch host to run on', 'url'),
    'target-key': flag.string('The API key of the scratch host (else LANDFLOW_TARGET_API_KEY, else none)', 'key'),
    pin: flag.string('upstream (default: the nodes before the failed node), trigger, none', 'mode'),
    'same-host': flag.boolean('Allow --target to be the host the bundle came from'),
    keep: flag.boolean('Keep the copied workflow on the target'),
    timeout: flag.number('Give up after this many seconds (default 120)', 'seconds'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const dir = resolve(ctx.io.cwd, ctx.args[0]);
    let manifest: Json;
    let workflow: Json;
    let runData: Record<string, Array<{ status?: string; outputs?: Array<Array<{ json?: unknown }>> }>>;
    try {
      manifest = readBundleFile(dir, 'bundle.json') as Json;
      workflow = readBundleFile(dir, 'workflow.json') as Json;
      runData = readBundleFile(dir, 'run-data.json') as typeof runData;
    } catch (caught) {
      throw new CliError('io', `${dir} isn't a debug bundle (needs bundle.json, workflow.json and run-data.json): ${(caught as Error).message}`);
    }
    if (manifest.format !== 'landflow-debug-bundle/v1') throw new CliError('io', `${dir}: unknown bundle format ${String(manifest.format)}`);
    const pin = String(ctx.flags.pin ?? 'upstream');
    if (!['upstream', 'trigger', 'none'].includes(pin)) throw usage('--pin is upstream, trigger or none');

    const nodes = (workflow.nodes as Json[]) ?? [];
    const connections = (workflow.connections as Json[]) ?? [];
    const failed = isObject(manifest.failedNode) ? String(manifest.failedNode.id) : undefined;
    const incoming = new Set(connections.map((c) => c.target));
    const triggers = nodes.filter((n) => !incoming.has(n.id)).map((n) => String(n.id));
    const wanted = pin === 'none' ? new Set<string>() : pin === 'trigger' || !failed ? new Set(triggers) : ancestors(connections, failed);
    const pinData: Record<string, Array<{ json: unknown }>> = {};
    const pinned: string[] = [];
    for (const node of nodes) {
      const id = String(node.id);
      const last = runData[id]?.at(-1);
      if (!wanted.has(id) || last?.status === 'error' || !last?.outputs?.[0]) continue;
      pinData[id] = last.outputs[0].map((item) => ({ json: item?.json ?? {} }));
      pinned.push(String(node.name));
    }

    const target = typeof ctx.flags.target === 'string' ? ctx.flags.target.replace(/\/+$/, '') : undefined;
    const source = String(manifest.host ?? '').replace(/\/+$/, '');
    const steps = [
      `Start a scratch host with its own data directory, e.g. (from the Landflow repository): LANDFLOW_DATA_DIR=$(mktemp -d) PORT=3180 pnpm --filter web dev`,
      `Create the workflow there: landflow workflows create --file ${join(dir, 'workflow.json')} --name "[replay] ${String(manifest.workflowName)}" --url http://localhost:3180`,
      `Pin the recorded output of ${pinned.length ? pinned.map((n) => `“${n}”`).join(', ') : 'no node'} (the pinData of the workflow, in the editor or by putting it into the file)`,
      `Run it: landflow run "[replay] ${String(manifest.workflowName)}" --wait --url http://localhost:3180`,
      `Add the credentials and $vars the nodes need on that host: the bundle holds none (${nodes.filter((n) => isObject(n.credentials) && Object.keys(n.credentials).length).length} node(s) name a credential).`,
    ];
    if (!target || (target === source && !ctx.flags['same-host'])) {
      const why = !target ? 'No --target was given' : `--target is the host the bundle came from (${source}); pass --same-host if you mean that`;
      return {
        data: { ran: false, reason: why, pinned, steps },
        human: () => `${why}, so nothing was run. Steps:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
      };
    }

    const key = typeof ctx.flags['target-key'] === 'string' ? ctx.flags['target-key'] : ctx.io.env.LANDFLOW_TARGET_API_KEY;
    const client = new Client(target, key, ctx.io.fetch);
    const doc = { ...workflow, name: `[replay] ${String(workflow.name ?? manifest.workflowName)}`, active: false, pinData } as Json;
    delete doc.id;
    delete doc.createdAt;
    delete doc.updatedAt;
    const warnings = await attachCredentialIds(client, doc);
    const { workflow: created } = await client.post<{ workflow: Json }>('/api/workflows', doc);
    const workflowId = String(created.id);
    let execution: ExecutionDetail;
    try {
      const started = await client.post<{ executionId: string }>(`/api/workflows/${seg(workflowId)}/execute`, {});
      execution = await watchExecution({ ...ctx, client }, started.executionId, Number(ctx.flags.timeout ?? 120), () => {});
    } finally {
      if (!ctx.flags.keep) await client.delete(`/api/workflows/${seg(workflowId)}`).catch(() => undefined);
    }
    const same = execution.status === manifest.status && (execution.error?.node ?? null) === (isObject(manifest.error) ? (manifest.error.node ?? null) : null);
    const data = { ran: true, target, workflowId: ctx.flags.keep ? workflowId : null, pinned, warnings, reproduced: same, execution };
    return {
      data,
      human: () =>
        `Replayed on ${target} with ${pinned.length} node(s) pinned${pinned.length ? ` (${pinned.join(', ')})` : ''}.\n` +
        `${same ? 'Same outcome as the original run.' : `Different outcome (the original ended ${String(manifest.status)}).`}\n\n` +
        describeExecution(execution, nodeTable) +
        warnings.map((w) => `\nwarning: ${w}`).join(''),
    };
  },
};

const nodeTable = (rows: ExecutionDetail['nodes']) =>
  table(rows, [
    { label: 'node', value: (n) => n.name, max: 40 },
    { label: 'status', value: (n) => n.status },
    { label: 'runs', value: (n) => n.runs, align: 'right' },
    { label: 'items', value: (n) => n.items, align: 'right' },
    { label: 'error', value: (n) => n.error, max: 60 },
  ]);

// ---------------------------------------------------------------------------
// executions watch
// ---------------------------------------------------------------------------

const RUNNING = new Set(['running', 'queued', 'new']);

/** Poll until the execution ends or parks, calling `onChange` with a line each time a node's state changes. */
async function watchExecution(ctx: Pick<Context, 'client' | 'io'>, id: string, timeoutSeconds: number, onChange: (line: string, events: Json) => void, intervalMs = 500): Promise<ExecutionDetail> {
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  const seen = new Map<string, string>();
  let status = '';
  for (;;) {
    const read = await ctx.client.request<{ execution?: Json }>('GET', `/api/executions/${seg(id)}`, { accept: [404] });
    if (read.status === 404) throw new CliError('not_found', `Execution ${id} not found (or finished and wasn't kept)`, { status: 404 });
    const execution = executionDetail(read.body.execution ?? {});
    if (execution.status !== status) {
      status = execution.status;
      onChange(`execution ${status}`, { type: 'execution', status });
    }
    for (const node of execution.nodes) {
      const mark = `${node.status}|${node.runs}|${node.items}|${node.error ?? ''}`;
      if (seen.get(node.id) === mark) continue;
      seen.set(node.id, mark);
      onChange(`${node.name}: ${node.status}${node.runs > 1 ? ` (run ${node.runs})` : ''}, ${node.items} item${node.items === 1 ? '' : 's'}${node.error ? ` — ${node.error}` : ''}`, { type: 'node', node: node.name, status: node.status, runs: node.runs, items: node.items, error: node.error });
    }
    if (!RUNNING.has(execution.status)) return execution;
    if (Date.now() + intervalMs > deadline) throw new CliError('timeout', `Execution ${id} is still ${execution.status} after ${timeoutSeconds} s`, { details: { executionId: id, status: execution.status } });
    await ctx.io.sleep(intervalMs);
  }
}

export const watch: Command = {
  name: 'executions watch',
  summary: 'Follow an execution: print each node’s progress until it ends (exit 1 if it failed)',
  usage: '<id> [--timeout <seconds>] [--interval <ms>]',
  details: 'Polls the execution. For people, a line appears whenever a node starts, finishes or fails; with --json the one document at the end carries the same changes in "events".',
  flags: {
    timeout: flag.number('Give up after this many seconds (exit 7)', 'seconds'),
    interval: flag.number('Poll every this many milliseconds (default 500)', 'ms'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const events: Json[] = [];
    const execution = await watchExecution(
      ctx,
      ctx.args[0],
      Number(ctx.flags.timeout ?? 0),
      (line, event) => {
        events.push({ at: new Date().toISOString(), ...event });
        if (!ctx.json) ctx.io.stdout(`${line}\n`);
      },
      Math.max(50, Number(ctx.flags.interval ?? 500)),
    );
    try {
      failUnlessSucceeded(execution);
    } catch (caught) {
      if (caught instanceof CliError) throw new CliError(caught.code, caught.message, { details: { ...(caught.details as Json), events } });
      throw caught;
    }
    return { data: { execution, events }, human: () => `\n${describeExecution(execution, nodeTable)}\nTook ${duration(execution.durationMs)}.` };
  },
};

// ---------------------------------------------------------------------------
// claude init
// ---------------------------------------------------------------------------

const SKILL = (url: string, nodeTypes: string) => `---
name: landflow
description: Build, validate, run and debug Landflow workflows on ${url} through its MCP server. Use when asked to create or change a workflow, or to find out why a run failed.
---

# Landflow

The host is ${url}; its MCP server (\`landflow\` in .mcp.json) has the tools below. The API key comes from the environment (\`LANDFLOW_API_KEY\`), never from a file.

## Workflow JSON

A workflow is nodes plus connections. Through the MCP tools and \`landflow workflows create --file\`:

\`\`\`json
{
  "name": "Greeting",
  "nodes": [
    { "id": "start", "name": "Start", "type": "core.manualTrigger", "typeVersion": 1, "position": [0, 0], "parameters": {} },
    { "id": "set", "name": "Set", "type": "core.set", "typeVersion": 1, "position": [240, 0], "parameters": { "mode": "json", "json": "{\\"greeting\\": \\"hello {{ $json.who }}\\"}" } }
  ],
  "connections": [{ "id": "e1", "type": "main", "source": "start", "sourceIndex": 0, "target": "set", "targetIndex": 0 }]
}
\`\`\`

- Types are \`<plugin>.<name>\`; read a type's parameters and \`outputSchema\` with \`get_node_type\` before you write a node.
- Items are JSON objects that flow left to right; expressions go in \`{{ }}\`: \`{{ $json.title }}\`, \`{{ $('Node name').item.json.id }}\`, \`{{ $vars.name }}\`.
- Credentials are chosen in the editor, not through MCP; references hold a name and a type.
- In the MCP tools, connections name nodes (\`source\`, \`target\`) instead of ids.

## Tools

\`search_node_types\`, \`list_node_types\`, \`get_node_type\`, \`validate_workflow\` (also warns when an expression reads a field the node before it does not write), \`create_workflow\`, \`update_workflow\`, \`execute_workflow\`, \`get_execution\`.
When a run fails: \`explain_failure\` (one call), \`get_run_trace\`, \`get_plugin_logs\`, \`run_node\` (one node on a pinned input), \`retry_execution\`.
Offline: \`landflow debug-bundle <execution>\` writes a redacted folder; \`landflow replay <bundle> --target <scratch host>\` reruns it; \`landflow executions watch <id>\` follows a run.

## Node types on this host

${nodeTypes}
`;

const MCP_ENTRY = (url: string) => ({ type: 'http', url: `${url}/api/mcp`, headers: { Authorization: 'Bearer ${LANDFLOW_API_KEY}' } });

export const claudeInit: Command = {
  name: 'claude init',
  summary: 'Write .mcp.json and a Landflow skill into a project, so a local Claude Code works against the connected host',
  usage: '[--dir <path>] [--force] [--offline]',
  details:
    'Writes <dir>/.mcp.json (the host’s MCP server; the key is read from $LANDFLOW_API_KEY, never written) and <dir>/.claude/skills/landflow/SKILL.md\n' +
    '(the workflow JSON format, the tools, and the host’s node types when it can be reached). A file that exists is left alone and reported, unless --force.',
  flags: {
    dir: flag.string('The project directory (default the current one)', 'path'),
    force: flag.boolean('Overwrite files that exist'),
    offline: flag.boolean('Don’t ask the host for its node types'),
  },
  args: { max: 0 },
  async run(ctx) {
    const root = resolve(ctx.io.cwd, String(ctx.flags.dir ?? '.'));
    const url = ctx.connection.url;
    let nodeTypes = `Run \`landflow claude init\` again with the host reachable to list them here, or use \`search_node_types\`.`;
    if (!ctx.flags.offline) {
      try {
        const { nodeTypes: list } = await callTool<{ nodeTypes: Array<{ type: string; displayName: string; description?: string; kind: string }> }>(ctx.client, 'list_node_types');
        nodeTypes = list.map((t) => `- \`${t.type}\` (${t.kind}): ${t.displayName}${t.description ? `. ${t.description.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`).join('\n');
      } catch (caught) {
        ctx.note(`warning: node types not listed (${reasonOf(caught)})`);
      }
    }
    const written: string[] = [];
    const skipped: string[] = [];
    const put = (rel: string, content: string) => {
      const path = join(root, rel);
      if (existsSync(path) && !ctx.flags.force) return void skipped.push(rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      written.push(rel);
    };
    put('.mcp.json', `${JSON.stringify({ mcpServers: { landflow: MCP_ENTRY(url) } }, null, 2)}\n`);
    put('.claude/skills/landflow/SKILL.md', SKILL(url, nodeTypes));
    return {
      data: { dir: root, url, written, skipped },
      human: () =>
        [
          written.length ? `Wrote ${written.join(', ')} in ${root}` : `Nothing written in ${root}`,
          skipped.length ? `Left alone (exist already, --force overwrites): ${skipped.join(', ')}${skipped.includes('.mcp.json') ? `\nAdd this server to your .mcp.json yourself:\n${JSON.stringify({ landflow: MCP_ENTRY(url) }, null, 2)}` : ''}` : '',
          `Export the key before starting Claude Code: export LANDFLOW_API_KEY=lf_…  (and turn the MCP server on in Settings → MCP if it is off)`,
        ]
          .filter(Boolean)
          .join('\n'),
    };
  },
};

export const debugCommands = [debugBundle, replay, watch, claudeInit];
