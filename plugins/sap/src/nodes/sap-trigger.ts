import { NodeOperationError, defineNode, pollIntervalProperty, type IExecuteContext, type ILoadOptionsContext, type JsonObject, type NodeItem, type PropertyOption } from '@landflow/sdk';
import { serviceById } from '../catalog';
import { collect } from '../odata/client';
import { entityTypeOf, isDateOnly } from '../odata/metadata';
import { buildQuery, checkEntitySetName, dateTimeLiteral } from '../odata/query';
import { redact, redactSet, shapeEntity } from '../odata/shape';
import { DEFAULT_OVERLAP_SECONDS, advance, baseline, overlapMs, scopeOf, type PollState } from '../poll';
import { HARD_MAX_RECORDS } from '../run';
import { connect, loadMetadata, resolveService, tryMetadata } from '../session';
import { CREDENTIAL_REQUIREMENTS, authenticationProperty, serviceProperties, timestampOptions } from './sap-odata';

export const MIN_POLL_SECONDS = 60;
export const DEFAULT_MAX_RECORDS_PER_POLL = 100;
const MANUAL_ITEMS = 5;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function entitySetOptions(ctx: ILoadOptionsContext): Promise<PropertyOption[]> {
  const serviceParam = String(ctx.getNodeParameter('service', ''));
  // Only entity sets with a change timestamp in the catalog are offered for polling; a custom service lists them all.
  const catalog = serviceById(serviceParam)?.entitySets.filter((s) => s.changeTimestamps.length > 0).map((s) => ({ name: s.name, value: s.name })) ?? [];
  if (catalog.length) return catalog;
  const service = resolveService(serviceParam, ctx.getNodeParameter('customPath', ''), ctx.getNodeParameter('odataVersion', 'v2'));
  const meta = await loadMetadata(connect(ctx, ctx.getNodeParameter('authentication', 'basic')), service);
  return meta.entitySets.map((s) => ({ name: s.name, value: s.name }));
}

export const sapTrigger = defineNode({
  description: {
    name: 'sapTrigger',
    displayName: 'SAP Trigger (Poll)',
    description: 'Starts the workflow when a record of an SAP S/4HANA Cloud entity set is created or changed. Polls the OData API, so it needs no public URL and no event broker',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    categories: ['SAP', 'Data'],
    icon: 'file:sap.svg',
    color: '#0a6ed1',
    subtitle: '{{entitySet}} every {{pollInterval}}s',
    keywords: ['sap', 's/4hana', 'trigger', 'poll', 'changed', 'new', 'odata', 'erp'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: CREDENTIAL_REQUIREMENTS,
    properties: [
      authenticationProperty(),
      ...serviceProperties().map((p) => (p.name === 'entitySet' ? { ...p, typeOptions: { loadOptionsMethod: 'entitySets', loadOptionsDependsOn: ['authentication', 'service', 'customPath', 'odataVersion'] }, description: 'Entity sets with a change timestamp' } : p)),
      {
        name: 'timestampProperty',
        displayName: 'Change Timestamp Property',
        type: 'options',
        default: 'LastChangeDateTime',
        required: true,
        typeOptions: { loadOptionsMethod: 'timestampProperties', loadOptionsDependsOn: ['authentication', 'service', 'customPath', 'odataVersion', 'entitySet'] },
        description: 'A date or datetime property that moves when the record changes. A date without a time is read with a one day overlap',
      },
      { name: 'extraFilter', displayName: 'Extra Filter', type: 'string', default: '', placeholder: "SoldToParty eq '10100001'", description: 'An OData $filter ANDed to the change window' },
      { ...pollIntervalProperty(300), typeOptions: { minValue: MIN_POLL_SECONDS, numberPrecision: 0 }, default: 300 },
      { name: 'maxRecordsPerPoll', displayName: 'Max Records per Poll', type: 'number', default: DEFAULT_MAX_RECORDS_PER_POLL, typeOptions: { minValue: 1, maxValue: HARD_MAX_RECORDS }, description: 'More changes than this wait for the next poll (oldest first)' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'overlapSeconds', displayName: 'Overlap (seconds)', type: 'number', default: DEFAULT_OVERLAP_SECONDS, typeOptions: { minValue: 0 }, description: 'Each poll re-reads this far before the last timestamp seen, so records written late are not missed; repeats are silent' },
          { name: 'redactPersonalData', displayName: 'Redact Personal Data', type: 'boolean', default: false },
          { name: 'redactFields', displayName: 'Redact Fields', type: 'string', default: '' },
          { name: 'timeoutSeconds', displayName: 'Timeout (seconds)', type: 'number', default: 30 },
        ],
      },
      {
        name: 'notice',
        displayName: `The first poll sets a baseline and emits nothing. Deletions are not seen. A record that changes again is emitted again. Execute in the editor shows the ${MANUAL_ITEMS} most recently changed records and changes nothing. The state (cursor and seen set) lives in the host; changing the service, entity set, property or filter starts again from a baseline.`,
        type: 'notice',
        default: '',
      },
    ],
  },
  methods: { loadOptions: { entitySets: entitySetOptions, timestampProperties: timestampOptions } },
  async execute(ctx: IExecuteContext): Promise<NodeItem[]> {
    const p = <T>(name: string, fallback?: T) => ctx.getNodeParameter<T>(name, 0, fallback as T);
    const options = (p<JsonObject>('options', {}) ?? {}) as JsonObject;
    const connection = connect(ctx, p('authentication', 'basic'), Math.max(1, Math.min(Number(options.timeoutSeconds) || 30, 120)) * 1000);
    const service = resolveService(p('service', ''), p('customPath', ''), p('odataVersion', 'v2'), connection.resolved.allowedServices);
    const entitySet = checkEntitySetName(String(p('entitySet', '')));
    const property = String(p('timestampProperty', '')).trim();
    if (!NAME.test(property)) throw new NodeOperationError('Choose the Change Timestamp Property');
    const extra = String(p('extraFilter', '') ?? '').trim();
    const limit = Math.max(1, Math.min(Math.floor(Number(p('maxRecordsPerPoll', DEFAULT_MAX_RECORDS_PER_POLL))) || DEFAULT_MAX_RECORDS_PER_POLL, HARD_MAX_RECORDS));
    const meta = await tryMetadata(connection, service, (m) => ctx.logger.warn(m));
    const typeProperty = entityTypeOf(meta ?? { entitySets: [], entityTypes: {} }, entitySet)?.properties.find((x) => x.name === property);
    const edmType = typeProperty?.type ?? 'Edm.DateTime';
    const overlap = overlapMs(options.overlapSeconds, isDateOnly(typeProperty, property));
    const fields = redactSet(String(options.redactFields ?? ''), options.redactPersonalData === true);
    const scope = scopeOf([service.path, entitySet, property, extra, connection.client.base.origin]);
    const context = { service: service.id, entitySet, operation: 'poll' };
    const base = `${service.path}/${entitySet}`;
    const keyNames = service.catalog?.entitySets.find((s) => s.name === entitySet)?.keys;
    const shape = (raw: unknown) => redact(shapeEntity(raw, meta, entitySet, { version: service.version, ...(keyNames && { keyNames }) }), fields);
    const window = async (fromMs: number, order: 'asc' | 'desc', top: number) => {
      const clauses = [`${property} ge ${dateTimeLiteral(new Date(Math.max(fromMs, 0)).toISOString(), edmType, service.version)}`];
      if (extra) clauses.push(`(${extra})`);
      const query = buildQuery({ filter: clauses.join(' and '), orderby: `${property} ${order}`, top: top + 1 }, service.version);
      return collect(connection.client, base, query, top, context);
    };

    return ctx.span('sap.poll', { 'sap.service': service.id, 'sap.entity_set': entitySet, 'sap.operation': 'poll', 'sap.mode': ctx.mode }, async (span) => {
      if (ctx.mode === 'manual') {
        // The most recent few, newest first; nothing is stored.
        const query = buildQuery({ ...(extra && { filter: extra }), orderby: `${property} desc`, top: MANUAL_ITEMS }, service.version);
        const result = await collect(connection.client, base, query, MANUAL_ITEMS, context);
        span.setAttribute('sap.rows', result.records.length);
        return result.records.map((r) => ({ json: shape(r) }));
      }

      if (ctx.isFirstPoll() || ctx.getPollState<PollState>()?.scope !== scope) {
        // Baseline: the newest record sets the cursor, the window before it counts as seen, nothing is emitted.
        const newest = await collect(
          connection.client,
          base,
          buildQuery({ ...(extra && { filter: extra }), orderby: `${property} desc`, top: 1 }, service.version),
          1,
          context,
        );
        const top = newest.records[0] ? shape(newest.records[0]) : undefined;
        const cursor = top && typeof top[property] === 'string' ? Date.parse(top[property] as string) : 0;
        const read = top && Number.isFinite(cursor) && cursor > 0 ? await window(cursor - overlap, 'asc', limit) : { records: [] as unknown[] };
        ctx.setPollState(baseline(read.records.map(shape), property, overlap, scope));
        span.setAttribute('sap.rows', 0);
        ctx.logger.info(`SAP trigger baseline for ${entitySet} at ${top ? String(top[property]) : 'an empty entity set'}`);
        return [];
      }

      const previous = ctx.getPollState<PollState>() as PollState;
      const from = Date.parse(previous.cursor) - overlap;
      // The window holds records seen before: ask for that many more, so they do not use up the page.
      const read = await window(from, 'asc', Math.min(limit + Object.keys(previous.seen ?? {}).length, 6000));
      const records = read.records.map(shape);
      const step = advance(records, previous, property, overlap, scope, read.hasMore, limit);
      ctx.setPollState(step.state);
      span.setAttribute('sap.rows', step.fresh.length);
      span.setAttribute('sap.has_more', read.hasMore);
      if (step.stuck) ctx.logger.warn(`SAP trigger read a full page of ${limit} records that were all seen: raise Max Records per Poll or the timestamp cannot separate them`);
      if (step.fresh.length) ctx.logger.info(`SAP trigger found ${step.fresh.length} new or changed record(s) in ${entitySet}`, { 'landflow.poll.items': step.fresh.length });
      return step.fresh.map((json) => ({ json }));
    });
  },
});

