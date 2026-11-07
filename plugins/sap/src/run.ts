/**
 * Running one SAP OData operation per input item: Get, List, Create, Update, Delete, with the safety rules of spec 3.5 and 3.6
 * (writes off unless allowed, deletes need a second switch, a per-run write budget, a dry run, redaction, keys-only spans).
 */
import { NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { CUSTOM_SERVICE, type Preset } from './catalog';
import { collect, unwrapEntity } from './odata/client';
import { SapError } from './odata/errors';
import { entityTypeOf, keyTypes, type ServiceMetadata } from './odata/metadata';
import { buildQuery, checkEntitySetName, dateTimeLiteral, keyPredicate, quoteString, type KeyValue } from './odata/query';
import { prepareBody, redact, redactSet, shapeEntity } from './odata/shape';
import { DEFAULT_MAX_WRITES_PER_RUN, connect, countWrite, peekMetadata, resolveService, tryMetadata, type Connection, type ServiceRef } from './session';

export type Operation = 'get' | 'list' | 'create' | 'update' | 'delete';
export const WRITE_OPERATIONS: readonly Operation[] = ['create', 'update', 'delete'];

export const DEFAULT_MAX_RECORDS = 100;
export const HARD_MAX_RECORDS = 1000;
export const DEFAULT_TOP = 50;
export const DEFAULT_TIMEOUT_SECONDS = 30;

/** Arguments a model may pass to the generic node as a tool. Anything else is refused (see `guardToolArguments`). */
export const GENERIC_TOOL_ARGS = ['service', 'entitySet', 'operation', 'keys', 'filter', 'select', 'expand', 'orderby', 'top', 'body'];

export interface RunSpec {
  /** Set for the preset nodes: the service is fixed. */
  preset?: Preset;
  operations: readonly Operation[];
  /** The tool arguments the node's schema declares. */
  toolArgs: readonly string[];
}

interface Options {
  maxRecords?: number;
  dryRun?: 'auto' | 'on' | 'off';
  maxWritesPerRun?: number;
  redactFields?: string;
  redactPersonalData?: boolean;
  keepSapDates?: boolean;
  ifMatchAny?: boolean;
  includeSummary?: boolean;
  timeoutSeconds?: number;
}

const asObject = (name: string, value: unknown): Record<string, unknown> => {
  let v = value;
  if (typeof v === 'string') {
    const text = v.trim();
    if (!text) return {};
    try {
      v = JSON.parse(text);
    } catch {
      throw new NodeOperationError(`${name} is not valid JSON`);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new NodeOperationError(`${name} must be a JSON object`);
  return v as Record<string, unknown>;
};

/**
 * Overrides: the engine lets a tool argument replace any parameter of the same name, so a model could pass `allowWrites` or `options`.
 * In tool mode only the arguments the node's own schema declares are accepted; anything else fails the call.
 */
export function guardToolArguments(input: JsonObject, allowed: readonly string[]) {
  const extra = Object.keys(input ?? {}).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new NodeOperationError(`The tool does not take the argument${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')}`, {
      description: `Allowed arguments: ${allowed.join(', ')}. Safety settings such as Allow Writes are set on the node, not by the model.`,
    });
  }
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const spanKeys = (keys: Record<string, unknown> | undefined) => (keys ? JSON.stringify(keys).slice(0, 200) : undefined);

export async function runSap(ctx: IExecuteContext, spec: RunSpec): Promise<NodeItem[]> {
  const items = ctx.getInputData();
  const tool = ctx.getMode() === 'tool';
  const out: NodeItem[] = [];
  const authentication = ctx.getNodeParameter('authentication', 0, 'basic');
  const first = ctx.getNodeParameter<Options>('options', 0, {}) ?? {};
  const connection = connect(ctx, authentication, clampInt(first.timeoutSeconds, 1, 120, DEFAULT_TIMEOUT_SECONDS) * 1000);
  const run = items.length > 0 ? items : [{ json: {} }];
  for (let i = 0; i < run.length; i++) {
    try {
      const produced = await one(ctx, spec, connection, tool, i, run[i].json);
      for (const item of produced) out.push({ json: item, pairedItem: { item: i } });
    } catch (error) {
      if (!ctx.continueOnFail()) throw error;
      out.push({ json: { error: (error as Error).message, ...((error as SapError).status !== undefined && { status: (error as SapError).status }) }, pairedItem: { item: i } });
    }
  }
  return out;
}

async function one(ctx: IExecuteContext, spec: RunSpec, connection: Connection, tool: boolean, i: number, input: JsonObject): Promise<JsonObject[]> {
  if (tool) guardToolArguments(input, spec.toolArgs);
  const p = <T>(name: string, fallback?: T) => ctx.getNodeParameter<T>(name, i, fallback as T);
  const options = (p<Options>('options', {}) ?? {}) as Options;
  const operation = String(p('operation', spec.operations[0])) as Operation;
  if (!spec.operations.includes(operation)) throw new NodeOperationError(`Operation "${operation}" is not available on this node`, { description: `Available: ${spec.operations.join(', ')}` });

  const service: ServiceRef = spec.preset
    ? resolveService(spec.preset.service, '', 'v2', connection.resolved.allowedServices)
    : resolveService(p('service', ''), p('customPath', ''), p('odataVersion', 'v2'), connection.resolved.allowedServices);
  const entitySet = checkEntitySetName(String(p('entitySet', spec.preset?.defaultEntitySet ?? '')));
  const ctxError = { service: service.id, entitySet, operation };
  const environment = connection.resolved.environment;
  const write = WRITE_OPERATIONS.includes(operation);

  // The gates come first: nothing is read from SAP for a write that is not allowed.
  if (write && p<boolean>('allowWrites', false) !== true) {
    throw new NodeOperationError(`Writes are off on this node (${operation})`, { description: 'Turn on Allow Writes on the node. As an agent tool a write also waits for approval when the agent requires it.' });
  }
  if (operation === 'delete' && p<boolean>('allowDeletes', false) !== true) {
    throw new NodeOperationError('Deletes are off on this node', { description: 'Turn on Allow Deletes as well as Allow Writes.' });
  }

  const warn = (message: string) => ctx.logger.warn(message);
  // $metadata: needed to check a write and for a custom service; a catalog read uses it only when it is already cached.
  const meta: ServiceMetadata | undefined = write || service.catalog === undefined ? await tryMetadata(connection, service, warn) : peekMetadata(connection, service);
  if (meta && !meta.entitySets.some((s) => s.name === entitySet)) {
    throw new NodeOperationError(`"${entitySet}" is not an entity set of this tenant's service ${service.id}`, { description: `Entity sets: ${meta.entitySets.map((s) => s.name).slice(0, 30).join(', ')}` });
  }
  const version = service.version;
  const keepSapDates = options.keepSapDates === true;
  const fields = redactSet(options.redactFields ?? '', options.redactPersonalData === true);
  const keyNames = service.catalog?.entitySets.find((s) => s.name === entitySet)?.keys;
  const shape = (raw: unknown, headerEtag?: string) => redact(shapeEntity(raw, meta, entitySet, { keepSapDates, version, ...(keyNames && { keyNames }), ...(headerEtag && { headerEtag }) }), fields);
  const keysOf = () => asObject('Keys', p('keys', {}));
  const base = `${service.path}/${entitySet}`;
  const defaultSelect = () => {
    // An agent gets the key fields unless it asks for more (spec 3.6: data minimisation).
    const names = meta ? (entityTypeOf(meta, entitySet)?.keys ?? []) : (service.catalog?.entitySets.find((s) => s.name === entitySet)?.keys ?? []);
    return names.join(',');
  };
  const select = String(p('select', '') ?? '').trim() || (tool ? defaultSelect() : '');

  return ctx.span(
    'sap.odata',
    { 'sap.service': service.id, 'sap.entity_set': entitySet, 'sap.operation': operation, 'sap.environment': environment === 'production' ? 'PROD' : 'Test', 'sap.tool': tool },
    async (span) => {
      const finish = (rows: number, extra: Record<string, string | number | boolean | undefined> = {}) => {
        span.setAttribute('sap.rows', rows);
        for (const [k, v] of Object.entries(extra)) if (v !== undefined) span.setAttribute(k, v);
      };

      if (operation === 'list') {
        const maxRecords = clampInt(options.maxRecords, 1, HARD_MAX_RECORDS, DEFAULT_MAX_RECORDS);
        const returnAll = !tool && p<boolean>('returnAll', false) === true;
        const limit = returnAll ? maxRecords : Math.min(clampInt(p('top', DEFAULT_TOP), 1, HARD_MAX_RECORDS, DEFAULT_TOP), maxRecords);
        const clauses: string[] = [];
        const userFilter = String(p('filter', '') ?? '').trim();
        if (userFilter) clauses.push(`(${userFilter})`);
        for (const f of spec.preset?.filters ?? []) {
          const value = String(p(f.name, '') ?? '').trim();
          if (!value) continue;
          if (f.kind === 'string') clauses.push(`${f.property} eq ${quoteString(value)}`);
          else clauses.push(`${f.property} ${f.kind === 'dateFrom' ? 'ge' : 'le'} ${dateTimeLiteral(value, 'Edm.DateTime', version)}`);
        }
        const query = buildQuery(
          { filter: clauses.join(' and '), select, expand: String(p('expand', '') ?? ''), orderby: String(p('orderby', '') ?? ''), top: limit + 1, count: true },
          version,
        );
        const result = await collect(connection.client, base, query, limit, ctxError);
        span.setAttribute('sap.has_more', result.hasMore);
        finish(result.records.length, { ...(result.total !== undefined && { 'sap.total': result.total }) });
        const rows = result.records.map((raw) => shape(raw));
        if (tool || options.includeSummary === true) {
          rows.push({ __summary: { returned: rows.length, ...(result.total !== undefined && { total: result.total }), hasMore: result.hasMore } });
        }
        return rows;
      }

      // A create has no key yet; every other operation addresses one entity.
      const keys = operation === 'create' ? {} : keysOf();
      if (operation !== 'create' && Object.keys(keys).length === 0) throw new NodeOperationError(`${operation} needs the key of the entity`, { description: 'Set Keys, for example {"SalesOrder": "4500000001"}.' });
      if (operation !== 'create') span.setAttribute('sap.keys', spanKeys(keys) ?? '');
      const entityPath = operation === 'create' ? base : `${base}${keyPredicate(keys, keyTypes(meta, entitySet), version)}`;

      if (operation === 'get') {
        const response = await connection.client.get(entityPath, { query: buildQuery({ select, expand: String(p('expand', '') ?? '') }, version), context: ctxError });
        finish(1);
        return [shape(unwrapEntity(response.body), response.headers.get('etag') ?? undefined)];
      }

      // ---- writes -----------------------------------------------------------------------------
      return writeOperation();

      async function writeOperation(): Promise<JsonObject[]> {
        const dry = options.dryRun === 'on' || (options.dryRun !== 'off' && tool);
        const ifMatchAny = options.ifMatchAny === true;
        const body = operation === 'delete' ? undefined : prepareBody(asObject('Fields', p('body', {})), meta, entitySet, operation === 'create' ? 'create' : 'update', version, keepSapDates);
        const method = operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE';

        // Update and delete read the entity first: its ETag is the If-Match. A stale ETag fails with 412 instead of a retry with `*`.
        let etag: string | undefined;
        let current: unknown;
        if (operation !== 'create') {
          const read = await connection.client.get(entityPath, { context: { ...ctxError, operation: `${operation} (read)` } });
          current = unwrapEntity(read.body);
          etag = ifMatchAny ? '*' : (read.headers.get('etag') ?? (current && typeof current === 'object' ? (current as { __metadata?: { etag?: string } }).__metadata?.etag : undefined) ?? undefined);
        }
        const target = operation === 'create' ? base : entityPath;

        if (dry) {
          finish(0, { 'sap.dry_run': true });
          return [
            redact(
              {
                dryRun: true,
                operation,
                service: service.id,
                entitySet,
                wouldSend: { method, path: target, ...(etag && { ifMatch: etag }), ...(body && { body }) },
                ...(current !== undefined && { current: shape(current, etag === '*' ? undefined : etag) }),
              } as JsonObject,
              fields,
            ),
          ];
        }

        const limit = clampInt(options.maxWritesPerRun, 0, 1000, DEFAULT_MAX_WRITES_PER_RUN);
        const count = countWrite(ctx.getExecutionId(), limit);
        span.setAttribute('sap.write_number', count);
        const response = await connection.client.write(method, service.path, target, { ...(body && { body }), ...(etag && { etag }), context: ctxError });
        span.setAttribute('sap.status', response.status);
        finish(1);
        if (operation === 'delete') return [redact({ deleted: true, entitySet, __keys: keys as JsonObject }, fields)];
        if (operation === 'create') {
          const created = unwrapEntity(response.body);
          return [created && typeof created === 'object' ? shape(created, response.headers.get('etag') ?? undefined) : { created: true, entitySet }];
        }
        // PATCH answers 204: read the entity again, so the output is the real new state with its new ETag.
        try {
          const read = await connection.client.get(entityPath, { context: { ...ctxError, operation: 'update (read back)' } });
          return [shape(unwrapEntity(read.body), read.headers.get('etag') ?? undefined)];
        } catch {
          return [{ updated: true, entitySet, __keys: keys as JsonObject }];
        }
      }
    },
  );
}

export { CUSTOM_SERVICE };
export type { KeyValue };
