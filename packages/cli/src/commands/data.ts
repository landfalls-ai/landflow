/** `data-tables list/rows` and `variables list/set/delete`. */
import { seg, type Client } from '../client';
import { flag, type Command } from '../command';
import { CliError, usage } from '../errors';
import { table, time } from '../output';
import { readInput } from '../shared';

interface Table {
  id: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  updatedAt: string | null;
}

const tableOf = (raw: Record<string, unknown>): Table => ({
  id: String(raw.id),
  name: String(raw.name ?? ''),
  columns: Array.isArray(raw.columns) ? (raw.columns as Array<{ name: string; type: string }>).map((c) => ({ name: String(c.name), type: String(c.type) })) : [],
  rowCount: Number(raw.rowCount ?? 0),
  updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
});

async function findTable(client: Client, ref: string): Promise<Table> {
  const { tables } = await client.get<{ tables: Array<Record<string, unknown>> }>('/api/data-tables');
  const found = tables.find((t) => t.id === ref) ?? tables.find((t) => String(t.name).toLowerCase() === ref.toLowerCase());
  if (!found) throw new CliError('not_found', `No data table with the id or name "${ref}"`, { status: 404 });
  return tableOf(found);
}

export const tablesList: Command = {
  name: 'data-tables list',
  summary: 'List data tables with their columns and row counts',
  args: { max: 0 },
  async run(ctx) {
    const { tables } = await ctx.client.get<{ tables: Array<Record<string, unknown>> }>('/api/data-tables');
    const rows = tables.map(tableOf).sort((a, b) => a.name.localeCompare(b.name));
    return {
      data: { tables: rows },
      human: () =>
        table(
          rows,
          [
            { label: 'id', value: (t) => t.id },
            { label: 'name', value: (t) => t.name, max: 40 },
            { label: 'rows', value: (t) => t.rowCount, align: 'right' },
            { label: 'columns', value: (t) => t.columns.map((c) => `${c.name}:${c.type}`).join(', '), max: 60 },
            { label: 'updated', value: (t) => time(t.updatedAt) },
          ],
          'No data tables.',
        ),
    };
  },
};

export const tablesRows: Command = {
  name: 'data-tables rows',
  summary: 'Show a data table’s rows (by table id or name)',
  usage: '<table> [--limit <n>] [--offset <n>] [--search <text>] [--sort <column>] [--desc]',
  flags: {
    limit: flag.number('At most this many rows (default 50, max 1000)'),
    offset: flag.number('Skip this many rows'),
    search: flag.string('Only rows containing this text in any column', 'text'),
    sort: flag.string('Sort by this column', 'column'),
    desc: flag.boolean('Sort descending'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const found = await findTable(ctx.client, ctx.args[0]);
    const limit = Math.max(1, Math.min(1000, Number(ctx.flags.limit ?? 50)));
    const page = await ctx.client.get<{ rows: Array<Record<string, unknown>>; total: number; offset: number; limit: number }>(`/api/data-tables/${seg(found.id)}/rows`, {
      limit,
      offset: ctx.flags.offset !== undefined ? Number(ctx.flags.offset) : undefined,
      search: ctx.flags.search as string | undefined,
      sortBy: ctx.flags.sort as string | undefined,
      sortDirection: ctx.flags.sort ? (ctx.flags.desc ? 'desc' : 'asc') : undefined,
    });
    const data = { table: { id: found.id, name: found.name, columns: found.columns }, rows: page.rows, total: page.total, offset: page.offset, limit: page.limit };
    return {
      data,
      human: () => {
        const columns = ['id', ...found.columns.map((c) => c.name)];
        const body = table(
          page.rows,
          columns.map((name) => ({ label: name, value: (row: Record<string, unknown>) => row[name] as string | number | boolean | null, max: 40 })),
          'No rows.',
        );
        return page.rows.length ? `${body}\n\n${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}` : body;
      },
    };
  },
};

export const variablesList: Command = {
  name: 'variables list',
  summary: 'List variables ($vars in expressions)',
  args: { max: 0 },
  async run(ctx) {
    const list = await ctx.client.get<Array<{ key: string; value: string }>>('/api/variables');
    const variables = list.map((v) => ({ key: String(v.key), value: String(v.value ?? '') })).sort((a, b) => a.key.localeCompare(b.key));
    return {
      data: { variables },
      human: () =>
        table(
          variables,
          [
            { label: 'key', value: (v) => v.key },
            { label: 'value', value: (v) => v.value, max: 80 },
          ],
          'No variables.',
        ),
    };
  },
};

export const variablesSet: Command = {
  name: 'variables set',
  summary: 'Create or change a variable',
  usage: '<key> <value> | <key> --value-file <file|->',
  flags: { 'value-file': flag.string('Read the value from a file, or - for stdin (one trailing newline is dropped)', 'file|-') },
  args: { min: 1, max: 2 },
  async run(ctx) {
    const [key, inline] = ctx.args;
    if ((inline === undefined) === (ctx.flags['value-file'] === undefined)) throw usage('Give the value as the second argument or with --value-file');
    const value = inline ?? (await readInput(ctx, String(ctx.flags['value-file']))).replace(/\r?\n$/, '');
    const existing = await ctx.client.request('GET', `/api/variables/${seg(key)}`, { accept: [404] });
    const created = existing.status === 404;
    const saved = created
      ? await ctx.client.post<{ key: string; value: string }>('/api/variables', { key, value })
      : await ctx.client.patch<{ key: string; value: string }>(`/api/variables/${seg(key)}`, { value });
    const variable = { key: String(saved.key ?? key), value: String(saved.value ?? value) };
    return { data: { variable, created }, human: () => `${created ? 'Created' : 'Updated'} ${variable.key}` };
  },
};

export const variablesDelete: Command = {
  name: 'variables delete',
  summary: 'Delete a variable',
  usage: '<key>',
  args: { min: 1, max: 1 },
  async run(ctx) {
    await ctx.client.delete(`/api/variables/${seg(ctx.args[0])}`);
    return { data: { deleted: ctx.args[0] }, human: () => `Deleted ${ctx.args[0]}` };
  },
};

export const dataCommands = [tablesList, tablesRows, variablesList, variablesSet, variablesDelete];
