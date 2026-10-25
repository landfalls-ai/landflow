/**
 * Data Table (n8n's `dataTable`): insert, get, update, upsert and delete rows of
 * a built-in data table (the Data Tables page). Conditions pick the rows; values
 * are mapped column by column with expressions, or automatically from the
 * item's fields. Runs in-process against the host's tables and works as an
 * agent tool. When every item uses the same table, a run's changes are one
 * transaction: a failing item (without "continue on error") undoes them all.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import { CONDITION_OPERATORS, type ConditionOperator, type DataTable, type RowFilter } from '../../shared/data-tables';
import { dataTables, DataTableError } from '../datatables';

const main = [{ type: 'main' as const }];
const FILTER_OPERATIONS = ['get', 'update', 'deleteRows'];
const WRITE_OPERATIONS = ['insert', 'update', 'upsert'];

interface ConditionParameter {
  keyName?: string;
  condition?: ConditionOperator;
  keyValue?: unknown;
}

const columnPicker = (name: string, displayName: string, method: 'columns' | 'filterColumns', extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
  name,
  displayName,
  type: 'options',
  default: '',
  noDataExpression: true,
  typeOptions: { loadOptionsMethod: method, loadOptionsDependsOn: ['dataTableId'] },
  ...extra,
});

export const dataTableNode = defineNode({
  description: {
    name: 'dataTable',
    displayName: 'Data Table',
    description: 'Store and read rows in a built-in data table',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:table-2',
    color: '#14b8a6',
    subtitle: '{{operation}}',
    keywords: ['data table', 'table', 'database', 'storage', 'store', 'rows', 'insert', 'upsert', 'lookup', 'memory'],
    usableAsTool: true,
    toolDescription:
      'Read and write rows of a Landflow data table. Insert / Upsert: pass the column values as arguments. Get / Update / Delete: the configured conditions choose the rows.',
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'insert',
        noDataExpression: true,
        options: [
          { name: 'Insert', value: 'insert', description: 'Insert a new row', action: 'Insert row' },
          { name: 'Get', value: 'get', description: 'Get the rows that match conditions', action: 'Get row(s)' },
          { name: 'Update', value: 'update', description: 'Update the rows that match conditions', action: 'Update row(s)' },
          { name: 'Upsert', value: 'upsert', description: 'Update the rows that match on chosen columns, or insert a row', action: 'Upsert row(s)' },
          { name: 'Delete', value: 'deleteRows', description: 'Delete the rows that match conditions', action: 'Delete row(s)' },
        ],
      },
      {
        name: 'dataTableId',
        displayName: 'Data Table',
        type: 'options',
        default: '',
        required: true,
        typeOptions: { loadOptionsMethod: 'tables' },
        description: 'Create tables and columns on the Data Tables page. An expression may give a table id or name.',
      },
      {
        name: 'matchType',
        displayName: 'Must Match',
        type: 'options',
        default: 'allConditions',
        noDataExpression: true,
        displayOptions: { show: { operation: FILTER_OPERATIONS } },
        options: [
          { name: 'All Conditions', value: 'allConditions' },
          { name: 'Any Condition', value: 'anyCondition' },
        ],
      },
      {
        name: 'filters',
        displayName: 'Conditions',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: { show: { operation: FILTER_OPERATIONS } },
        description: 'Without conditions, Get returns every row; Update and Delete need at least one',
        groups: [
          {
            name: 'conditions',
            displayName: 'Condition',
            values: [
              columnPicker('keyName', 'Column', 'filterColumns'),
              {
                name: 'condition',
                displayName: 'Condition',
                type: 'options',
                default: 'eq',
                noDataExpression: true,
                options: CONDITION_OPERATORS.map((o) => ({ name: o.name, value: o.value })),
              },
              { name: 'keyValue', displayName: 'Value', type: 'string', default: '', displayOptions: { hide: { condition: ['isEmpty', 'isNotEmpty'] } } },
            ],
          },
        ],
      },
      {
        name: 'matchingColumns',
        displayName: 'Columns to Match On',
        type: 'multiOptions',
        default: [],
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'columns', loadOptionsDependsOn: ['dataTableId'] },
        displayOptions: { show: { operation: ['upsert'] } },
        description: 'Rows whose values in these columns equal the new values are updated; when none match, a row is inserted',
      },
      {
        name: 'mappingMode',
        displayName: 'Mapping Column Mode',
        type: 'options',
        default: 'defineBelow',
        noDataExpression: true,
        displayOptions: { show: { operation: WRITE_OPERATIONS } },
        options: [
          { name: 'Map Each Column Manually', value: 'defineBelow', description: 'Set each column’s value, with expressions' },
          { name: 'Map Automatically', value: 'autoMapInputData', description: 'Item fields named like a column fill it; other fields are ignored' },
        ],
      },
      {
        name: 'columns',
        displayName: 'Values to Send',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: { show: { operation: WRITE_OPERATIONS, mappingMode: ['defineBelow'] } },
        groups: [
          {
            name: 'column',
            displayName: 'Column',
            values: [columnPicker('column', 'Column', 'columns'), { name: 'value', displayName: 'Value', type: 'string', default: '', placeholder: '{{ $json.email }}' }],
          },
        ],
      },
      { name: 'returnAll', displayName: 'Return All', type: 'boolean', default: false, displayOptions: { show: { operation: ['get'] } } },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1 },
        description: 'Max number of rows to return',
        displayOptions: { show: { operation: ['get'], returnAll: [false] } },
      },
      {
        name: 'dryRun',
        displayName: 'Dry Run',
        type: 'boolean',
        default: false,
        description: 'Return the rows that would be deleted, without deleting them',
        displayOptions: { show: { operation: ['deleteRows'] } },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { operation: ['get'] } },
        values: [
          columnPicker('orderByColumn', 'Order By', 'filterColumns'),
          {
            name: 'orderByDirection',
            displayName: 'Order Direction',
            type: 'options',
            default: 'ASC',
            noDataExpression: true,
            options: [
              { name: 'Ascending', value: 'ASC' },
              { name: 'Descending', value: 'DESC' },
            ],
          },
        ],
      },
    ],
  },
  execute(ctx) {
    const service = dataTables();
    const items = ctx.getInputData();
    const operation = ctx.getNodeParameter<string>('operation', 0, 'insert');
    const out: NodeItem[] = [];

    const tableFor = (i: number): DataTable => {
      const ref = String(ctx.getNodeParameter('dataTableId', i, '') ?? '').trim();
      const table = service.findTable(ref);
      if (!table) throw new NodeOperationError(ref ? `Data table “${ref}” not found` : 'Choose a data table', { itemIndex: i, description: 'Tables are created on the Data Tables page.' });
      return table;
    };
    const filterFor = (i: number): RowFilter => {
      const conditions = (ctx.getNodeParameter<{ conditions?: ConditionParameter[] }>('filters', i)?.conditions ?? [])
        .filter((c) => c.keyName)
        .map((c) => ({ column: String(c.keyName), operator: c.condition ?? 'eq', value: c.keyValue }));
      return { type: ctx.getNodeParameter('matchType', i) === 'anyCondition' ? 'or' : 'and', conditions };
    };
    const auto = (i: number) => ctx.getNodeParameter('mappingMode', i) === 'autoMapInputData';
    const valuesFor = (item: NodeItem, i: number): Record<string, unknown> => {
      if (auto(i)) return item.json as Record<string, unknown>;
      const mapped = ctx.getNodeParameter<{ column?: Array<{ column?: string; value?: unknown }> }>('columns', i)?.column ?? [];
      return Object.fromEntries(mapped.filter((m) => m.column).map((m) => [String(m.column), m.value]));
    };
    const needConditions = (filter: RowFilter, i: number, verb: string) => {
      if (!filter.conditions?.length) {
        throw new NodeOperationError(`Add a condition to choose the rows to ${verb}`, { itemIndex: i, description: 'To change every row, use a condition such as “id Is Not Empty”.' });
      }
    };
    const emit = (rows: JsonObject[], i: number) => rows.forEach((json) => out.push({ json, pairedItem: { item: i } }));

    const runItem = (item: NodeItem, i: number) => {
      const table = tableFor(i);
      switch (operation) {
        case 'insert':
          return emit(service.insertRows(table.id, [valuesFor(item, i)], { ignoreUnknown: auto(i) }) as JsonObject[], i);
        case 'get': {
          const options = ctx.getNodeParameter<{ orderByColumn?: string; orderByDirection?: string }>('options', i) ?? {};
          const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
          const page = service.listRows(table.id, {
            filter: filterFor(i),
            ...(options.orderByColumn && { sortBy: options.orderByColumn, sortDirection: options.orderByDirection === 'DESC' ? 'desc' : 'asc' }),
            ...(!returnAll && { limit: Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50) }),
          });
          return emit(page.rows as JsonObject[], i);
        }
        case 'update': {
          const filter = filterFor(i);
          needConditions(filter, i, 'update');
          return emit(service.updateRows(table.id, filter, valuesFor(item, i), { ignoreUnknown: auto(i) }) as JsonObject[], i);
        }
        case 'upsert': {
          const matching = (ctx.getNodeParameter<string[]>('matchingColumns', i, []) ?? []).filter(Boolean);
          if (!matching.length) throw new NodeOperationError('Choose the columns to match on', { itemIndex: i });
          return emit(service.upsertRows(table.id, matching, [valuesFor(item, i)], { ignoreUnknown: auto(i) }).rows as JsonObject[], i);
        }
        case 'deleteRows': {
          const filter = filterFor(i);
          needConditions(filter, i, 'delete');
          const rows = ctx.getNodeParameter<boolean>('dryRun', i, false) ? service.listRows(table.id, { filter }).rows : service.deleteRows(table.id, filter);
          return emit(rows as JsonObject[], i);
        }
        default:
          throw new NodeOperationError(`Unknown operation “${operation}”`, { itemIndex: i });
      }
    };

    const runAll = () =>
      items.forEach((item, i) => {
        try {
          runItem(item, i);
        } catch (caught) {
          const error = caught instanceof DataTableError ? new NodeOperationError(caught.message, { itemIndex: i }) : caught;
          if (!ctx.continueOnFail()) throw error;
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
        }
      });

    // One table for every item: run as one transaction (one write, all or nothing).
    let shared: string | undefined;
    try {
      const ids = new Set(items.map((_item, i) => tableFor(i).id));
      if (ids.size === 1) shared = [...ids][0];
    } catch {
      // A missing table fails on its item below.
    }
    if (shared && operation !== 'get') service.transaction(shared, runAll);
    else runAll();
    return [out];
  },
  methods: {
    loadOptions: {
      tables: () =>
        dataTables()
          .listTables()
          .map((table) => ({ name: table.name, value: table.id, description: `${table.rowCount.toLocaleString('en-US')} rows · ${table.columns.length} columns` })),
      columns: (ctx) => (dataTables().findTable(String(ctx.getNodeParameter('dataTableId', '') ?? ''))?.columns ?? []).map((c) => ({ name: c.name, value: c.name, description: c.type })),
      filterColumns: (ctx) => [
        ...(dataTables().findTable(String(ctx.getNodeParameter('dataTableId', '') ?? ''))?.columns ?? []).map((c) => ({ name: c.name, value: c.name, description: c.type })),
        { name: 'id', value: 'id', description: 'number' },
        { name: 'createdAt', value: 'createdAt', description: 'date' },
        { name: 'updatedAt', value: 'updatedAt', description: 'date' },
      ],
    },
  },
});
