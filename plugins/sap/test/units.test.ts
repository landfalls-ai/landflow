/** Query building, `$metadata`, shaping, error mapping and the poll and CloudEvents logic, with no server. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { advance, baseline, overlapMs, signature, DAY_MS, MAX_SEEN, type PollState } from '../src/poll';
import { CloudEventError, deliveryKey, entityAndAction, matchesType, parseCloudEvents, secretMatches } from '../src/cloudevents';
import { SapError, mapError, parseErrorBody } from '../src/odata/errors';
import { clearMetadataCache, cachedMetadata, keyTypes, parseMetadata, storeMetadata, timestampProperties, isDateOnly } from '../src/odata/metadata';
import { buildQuery, checkCustomPath, checkNameList, checkOrderBy, dateTimeLiteral, keyPredicate, lowerVersionParams, parseKeyPredicate, quoteString } from '../src/odata/query';
import { cleanValue, fromSapDate, prepareBody, redact, redactSet, shapeEntity, toSapDate } from '../src/odata/shape';
import { FakeS4, SERVICES, cloudEvent, deliveryOf } from './fake-s4';

describe('keys and query options', () => {
  it('quotes strings and doubles quotes', () => {
    expect(quoteString("O'Brien")).toBe("'O''Brien'");
    expect(keyPredicate({ SalesOrder: '4500000001' })).toBe("('4500000001')");
    expect(keyPredicate({ A: "x'y", B: 2 })).toBe("(A='x''y',B=2)");
  });

  it('types keys by $metadata and refuses malformed ones', () => {
    expect(keyPredicate({ N: '12' }, { N: 'Edm.Int32' })).toBe('(12)');
    expect(keyPredicate({ G: '0123456789abcdef0123456789abcdef' }, { G: 'Edm.Guid' })).toBe("(guid'0123456789abcdef0123456789abcdef')");
    expect(() => keyPredicate({ N: 'x' }, { N: 'Edm.Int32' })).toThrow(/not a number/);
    expect(() => keyPredicate({ 'A(1)': '1' })).toThrow(/valid key property name/);
    expect(() => keyPredicate({})).toThrow(/Keys are empty/);
    expect(() => keyPredicate({ A: 1e999 })).toThrow(/finite/);
  });

  it('parses a key predicate back from a __metadata uri', () => {
    expect(parseKeyPredicate("https://h/sap/A_SalesOrder('4500000001')")).toEqual({ key: '4500000001' });
    expect(parseKeyPredicate("https://h/x/A(SalesOrder='1',SalesOrderItem='10')")).toEqual({ SalesOrder: '1', SalesOrderItem: '10' });
    expect(parseKeyPredicate("https://h/x/A(Name='a,b',N=2)")).toEqual({ Name: 'a,b', N: 2 });
  });

  it('encodes the filter verbatim with %20, and checks the other options', () => {
    const q = buildQuery({ filter: "Name eq 'a b' and X ge 1", select: 'A, B', orderby: 'A desc', top: 5, skip: 2, count: true }, 'v2');
    expect(q).toBe("$filter=Name%20eq%20%27a%20b%27%20and%20X%20ge%201&$select=A%2CB&$orderby=A%20desc&$top=5&$skip=2&$inlinecount=allpages");
    expect(buildQuery({ count: true }, 'v4')).toBe('$count=true');
    expect(() => checkNameList('Select', 'A,B;drop')).toThrow(/not a property name/);
    expect(() => checkOrderBy('A sideways')).toThrow(/asc or desc/);
    expect(() => buildQuery({ filter: 'x'.repeat(2001) }, 'v2')).toThrow(/longer than/);
    expect(() => buildQuery({ filter: 'a\nb' }, 'v2')).toThrow(/control characters/);
  });

  it('writes date literals per edition and type', () => {
    expect(dateTimeLiteral('2026-11-07T10:00:00.123Z', 'Edm.DateTime', 'v2')).toBe("datetime'2026-11-07T10:00:00'");
    expect(dateTimeLiteral('2026-11-07T10:00:00Z', 'Edm.DateTimeOffset', 'v2')).toBe("datetimeoffset'2026-11-07T10:00:00.000Z'");
    expect(dateTimeLiteral('2026-11-07T10:00:00Z', 'Edm.DateTimeOffset', 'v4')).toBe('2026-11-07T10:00:00.000Z');
    expect(dateTimeLiteral('2026-11-07T10:00:00Z', 'Edm.Date', 'v4')).toBe('2026-11-07');
    expect(() => dateTimeLiteral('nope', undefined, 'v2')).toThrow(/not a date/);
  });

  it('lowercases version parameters and checks custom paths', () => {
    expect(lowerVersionParams('/sap/opu/odata/sap/ZSRV;V=2')).toBe('/sap/opu/odata/sap/ZSRV;v=2');
    expect(checkCustomPath('/sap/opu/odata/sap/ZMY_SRV/')).toBe('/sap/opu/odata/sap/ZMY_SRV');
    for (const bad of ['sap/x', '/sap/../x', '/sap/%2e%2e/x', '/sap/x?a=1', '/sap/x#y', '/sap/a b', 'https://h/sap/x', '/sap/x\\y']) expect(() => checkCustomPath(bad), bad).toThrow();
  });
});

describe('$metadata', () => {
  const fake = new FakeS4();
  const edmx = (id: string) => {
    // Reuse the fake's EDMX through a started server would need a port; the generator is private, so rebuild via a request.
    return id;
  };
  void edmx;

  it('parses entity sets, keys, types and sap annotations from the fake\'s EDMX', async () => {
    await fake.start();
    try {
      const service = SERVICES.find((s) => s.id === 'API_SALES_ORDER_SRV')!;
      const response = await fetch(`${fake.url}${service.path}/$metadata`, { headers: { authorization: `Basic ${Buffer.from(`${fake.user}:${fake.password}`).toString('base64')}` } });
      const meta = parseMetadata(await response.text());
      expect(meta.entitySets.map((s) => s.name)).toEqual(['A_SalesOrder', 'A_SalesOrderItem']);
      const order = meta.entityTypes.A_SalesOrderType;
      expect(order.keys).toEqual(['SalesOrder']);
      expect(order.navigation).toEqual(['to_Item']);
      expect(order.properties.find((p) => p.name === 'SalesOrder')).toMatchObject({ type: 'Edm.String', nullable: false, creatable: false, updatable: false });
      expect(order.properties.find((p) => p.name === 'YY1_Note_SDH')).toBeDefined();
      expect(meta.entityTypes.A_SalesOrderItemType.keys).toEqual(['SalesOrder', 'SalesOrderItem']);
      expect(keyTypes(meta, 'A_SalesOrderItem')).toEqual({ SalesOrder: 'Edm.String', SalesOrderItem: 'Edm.String' });
      expect(timestampProperties(order).map((p) => p.name)).toEqual(['LastChangeDateTime', 'CreationDate']);
    } finally {
      await fake.stop();
    }
  });

  it('knows a date-only property', () => {
    const meta = parseMetadata('<Schema><EntityType Name="T"><Key><PropertyRef Name="K"/></Key><Property Name="K" Type="Edm.String"/><Property Name="LastChangeDate" Type="Edm.DateTime" sap:display-format="Date"/><Property Name="Other" Type="Edm.DateTime"/></EntityType><EntityContainer><EntitySet Name="Ts" EntityType="S.T"/></EntityContainer></Schema>');
    const type = meta.entityTypes.T;
    expect(isDateOnly(type.properties.find((p) => p.name === 'LastChangeDate'), 'LastChangeDate')).toBe(true);
    expect(isDateOnly(type.properties.find((p) => p.name === 'Other'), 'Other')).toBe(false);
    expect(isDateOnly(undefined, 'LastChangeDate')).toBe(true);
    expect(isDateOnly(undefined, 'LastChangeDateTime')).toBe(false);
  });

  it('caches with a TTL', () => {
    clearMetadataCache();
    const meta = parseMetadata('<Schema><EntityType Name="T"><Key><PropertyRef Name="K"/></Key><Property Name="K" Type="Edm.String"/></EntityType><EntityContainer><EntitySet Name="Ts" EntityType="S.T"/></EntityContainer></Schema>');
    storeMetadata('k', meta, 1000);
    expect(cachedMetadata('k', 1000 + 3_599_000)).toBe(meta);
    expect(cachedMetadata('k', 1000 + 3_601_000)).toBeUndefined();
    process.env.LANDFLOW_SAP_METADATA_TTL_SECONDS = '10';
    storeMetadata('k2', meta, 0);
    expect(cachedMetadata('k2', 11_000)).toBeUndefined();
    delete process.env.LANDFLOW_SAP_METADATA_TTL_SECONDS;
  });
});

describe('shaping', () => {
  it('converts SAP dates both ways and strips wrappers', () => {
    expect(fromSapDate('/Date(1700000000000)/')).toBe('2023-11-14T22:13:20.000Z');
    expect(fromSapDate('/Date(1700000000000+0000)/')).toBe('2023-11-14T22:13:20.000Z');
    expect(fromSapDate('2023')).toBeUndefined();
    expect(toSapDate('2023-11-14T22:13:20Z')).toBe('/Date(1700000000000)/');
    expect(cleanValue({ __metadata: { uri: 'x' }, A: 1, to_Item: { results: [{ __metadata: {}, B: '/Date(0)/' }] }, to_X: { __deferred: { uri: 'u' } } })).toEqual({ A: 1, to_Item: [{ B: '1970-01-01T00:00:00.000Z' }] });
    expect(cleanValue({ D: '/Date(0)/' }, true)).toEqual({ D: '/Date(0)/' });
  });

  it('keeps the ETag and keys', () => {
    const item = shapeEntity({ __metadata: { uri: "h/A_Thing('T1')", etag: 'W/"1"' }, ThingID: 'T1', Name: 'n' }, undefined, 'A_Thing');
    expect(item).toMatchObject({ ThingID: 'T1', __etag: 'W/"1"', __keys: { key: 'T1' } });
    expect(shapeEntity({ ThingID: 'T1' }, undefined, 'A_Thing', { keyNames: ['ThingID'] }).__keys).toEqual({ ThingID: 'T1' });
    expect(shapeEntity({ ThingID: 'T1' }, undefined, 'A_Thing', { headerEtag: 'W/"9"' }).__etag).toBe('W/"9"');
  });

  it('redacts named fields at any depth but not the keys', () => {
    const fields = redactSet('Secret', true);
    const out = redact({ FirstName: 'A', Secret: 'x', Empty: '', n: { IBAN: 'DE00', Other: 1 }, list: [{ EmailAddress: 'e' }], __keys: { FirstName: 'k' } }, fields) as any;
    expect(out.FirstName).toBe('[redacted]');
    expect(out.Secret).toBe('[redacted]');
    expect(out.n).toEqual({ IBAN: '[redacted]', Other: 1 });
    expect(out.list[0].EmailAddress).toBe('[redacted]');
    expect(out.__keys).toEqual({ FirstName: 'k' });
    expect(redact({ A: 1 }, new Set())).toEqual({ A: 1 });
  });

  it('prepares a body: wrappers dropped, dates converted, unknown properties refused', () => {
    const meta = parseMetadata('<Schema><EntityType Name="T"><Key><PropertyRef Name="K"/></Key><Property Name="K" Type="Edm.String" sap:creatable="false" sap:updatable="false"/><Property Name="When" Type="Edm.DateTime"/><Property Name="Name" Type="Edm.String"/><NavigationProperty Name="to_I" Relationship="r" FromRole="a" ToRole="b"/></EntityType><EntityContainer><EntitySet Name="Ts" EntityType="S.T"/></EntityContainer></Schema>');
    expect(prepareBody({ __etag: 'x', __keys: {}, Name: 'n', When: '2023-11-14T22:13:20Z', to_I: [{ A: 1 }] }, meta, 'Ts', 'create', 'v2')).toEqual({ Name: 'n', When: '/Date(1700000000000)/', to_I: [{ A: 1 }] });
    expect(prepareBody({ When: '2023-11-14T22:13:20Z' }, meta, 'Ts', 'update', 'v4')).toEqual({ When: '2023-11-14T22:13:20Z' });
    expect(() => prepareBody({ Nope: 1 }, meta, 'Ts', 'create', 'v2')).toThrow(/not in this tenant/);
    expect(() => prepareBody({ K: '1' }, meta, 'Ts', 'update', 'v2')).toThrow(/key/);
    expect(() => prepareBody({}, meta, 'Ts', 'create', 'v2')).toThrow(/empty/);
    expect(() => prepareBody([] as never, meta, 'Ts', 'create', 'v2')).toThrow(/JSON object/);
    expect(() => prepareBody({ A: 1 }, meta, 'Nope', 'create', 'v2')).toThrow(/not an entity set/);
    expect(prepareBody({ Anything: 1 }, undefined, 'Ts', 'create', 'v2')).toEqual({ Anything: 1 });
  });
});

describe('error mapping', () => {
  const ctx = { service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'get' };

  it('reads V2 and V4 error bodies', () => {
    expect(parseErrorBody({ error: { code: 'SY/530', message: { lang: 'en', value: 'Boom' }, innererror: { errordetails: [{ code: 'A/1', message: 'detail one' }, { code: 'A/1', message: 'detail one' }] } } })).toEqual({ code: 'SY/530', message: 'Boom', details: ['A/1: detail one'] });
    expect(parseErrorBody({ error: { code: '400', message: 'Bad', target: '$filter', details: [{ code: 'x', message: 'why' }] } })).toEqual({ code: '400', message: 'Bad', target: '$filter', details: ['x: why'] });
    expect(parseErrorBody('nope')).toBeUndefined();
  });

  it('writes one line per case, with the status as a field', () => {
    const e401 = mapError(ctx, 401, '');
    expect(e401).toBeInstanceOf(SapError);
    expect(e401.status).toBe(401);
    expect(e401.message).toContain('401 Unauthorized');
    expect(mapError(ctx, 404, { error: { code: 'X', message: { value: 'gone' } } }).message).toBe('SAP API_SALES_ORDER_SRV/A_SalesOrder get failed: 404 no such key (X: gone)');
    expect(mapError({ ...ctx, operation: 'update' }, 412, {}).message).toMatch(/changed since it was read/);
    expect(mapError({ ...ctx, operation: 'update' }, 428, {}).message).toMatch(/wants an ETag/);
    expect(mapError(ctx, 429, {}, { 'retry-after': '7' }).message).toMatch(/retry after 7 s/);
    expect(mapError(ctx, 200, '<html><body>login</body></html>', { 'content-type': 'text/html' }).message).toMatch(/not an OData answer/);
    expect(mapError(ctx, 500, 'x'.repeat(1000)).message.length).toBeLessThan(400);
  });
});

describe('poll cursor and seen set', () => {
  const rec = (id: string, ts: string, etag = 'v1', more: Record<string, unknown> = {}) => ({ Id: id, Changed: ts, __etag: etag, __keys: { Id: id }, ...more }) as any;
  const scope = 's';
  const overlap = 300_000;

  it('the baseline emits nothing and counts the window as seen', () => {
    const state = baseline([rec('1', '2026-11-01T10:00:00.000Z'), rec('2', '2026-11-01T10:10:00.000Z')], 'Changed', overlap, scope);
    expect(state.cursor).toBe('2026-11-01T10:10:00.000Z');
    expect(Object.keys(state.seen)).toHaveLength(1);
    expect(advance([rec('2', '2026-11-01T10:10:00.000Z')], state, 'Changed', overlap, scope).fresh).toEqual([]);
  });

  it('emits a new record once, a re-read of the overlap window is silent', () => {
    let state = baseline([rec('1', '2026-11-01T10:00:00.000Z')], 'Changed', overlap, scope);
    const next = advance([rec('1', '2026-11-01T10:00:00.000Z'), rec('2', '2026-11-01T10:01:00.000Z')], state, 'Changed', overlap, scope);
    expect(next.fresh.map((r) => r.Id)).toEqual(['2']);
    state = next.state;
    expect(advance([rec('1', '2026-11-01T10:00:00.000Z'), rec('2', '2026-11-01T10:01:00.000Z')], state, 'Changed', overlap, scope).fresh).toEqual([]);
  });

  it('emits a record again when it changed (new ETag), and a late-written record inside the overlap', () => {
    const state = baseline([rec('1', '2026-11-01T10:00:00.000Z'), rec('2', '2026-11-01T10:10:00.000Z')], 'Changed', overlap, scope);
    const changed = advance([rec('2', '2026-11-01T10:10:00.000Z', 'v2')], state, 'Changed', overlap, scope);
    expect(changed.fresh.map((r) => r.Id)).toEqual(['2']);
    const late = advance([rec('3', '2026-11-01T10:08:00.000Z'), rec('2', '2026-11-01T10:10:00.000Z')], state, 'Changed', overlap, scope);
    expect(late.fresh.map((r) => r.Id)).toEqual(['3']);
  });

  it('never moves the cursor back and prunes the seen set to the window', () => {
    const state = baseline([rec('1', '2026-11-01T10:00:00.000Z')], 'Changed', overlap, scope);
    const step = advance([rec('9', '2026-10-01T10:00:00.000Z')], state, 'Changed', overlap, scope);
    expect(step.state.cursor).toBe('2026-11-01T10:00:00.000Z');
    const far = advance([rec('2', '2026-11-01T12:00:00.000Z')], state, 'Changed', overlap, scope);
    expect(Object.keys(far.state.seen)).toHaveLength(1);
  });

  it('records without a timestamp are emitted by signature and do not move the cursor', () => {
    const state = baseline([rec('1', '2026-11-01T10:00:00.000Z')], 'Changed', overlap, scope);
    const step = advance([{ Id: '7', __keys: { Id: '7' }, __etag: 'v1' } as any], state, 'Changed', overlap, scope);
    expect(step.fresh).toHaveLength(1);
    expect(step.state.cursor).toBe(state.cursor);
  });

  it('an empty baseline starts at the epoch so the first new record is emitted', () => {
    const state = baseline([], 'Changed', overlap, scope);
    expect(state.cursor).toBe('1970-01-01T00:00:00.000Z');
    expect(advance([rec('1', '2026-11-01T10:00:00.000Z')], state, 'Changed', overlap, scope).fresh).toHaveLength(1);
  });

  it('flags a full page that was all seen and did not move', () => {
    const state = baseline([rec('1', '2026-11-01T10:00:00.000Z')], 'Changed', overlap, scope);
    expect(advance([rec('1', '2026-11-01T10:00:00.000Z')], state, 'Changed', overlap, scope, true).stuck).toBe(true);
    expect(advance([rec('1', '2026-11-01T10:00:00.000Z')], state, 'Changed', overlap, scope, false).stuck).toBe(false);
  });

  it('signatures use key and ETag, else a content hash; date-only fields widen the overlap to a day', () => {
    expect(signature(rec('1', 'x'))).toBe(signature(rec('1', 'y')));
    expect(signature(rec('1', 'x', 'v2'))).not.toBe(signature(rec('1', 'x', 'v1')));
    const plain = (n: string) => ({ Id: '1', Name: n, __keys: { Id: '1' } }) as any;
    expect(signature(plain('a'))).not.toBe(signature(plain('b')));
    expect(overlapMs(undefined, false)).toBe(300_000);
    expect(overlapMs(60, true)).toBe(DAY_MS + 1000);
    expect(overlapMs(-5, false)).toBe(300_000);
  });

  it('bounds the seen set', () => {
    const many = Array.from({ length: MAX_SEEN + 50 }, (_, i) => rec(`r${i}`, new Date(Date.parse('2026-11-01T10:00:00Z') + i).toISOString()));
    const step = advance(many, undefined as unknown as PollState, 'Changed', DAY_MS, scope);
    expect(Object.keys(step.state.seen)).toHaveLength(MAX_SEEN);
  });
});

describe('CloudEvents', () => {
  const raw = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

  it('reads the entity and action from dotted and slashed types', () => {
    expect(entityAndAction('sap.s4.beh.businesspartner.v1.BusinessPartner.Changed.v1')).toEqual({ entity: 'BusinessPartner', action: 'Changed' });
    expect(entityAndAction('sap/s4/beh/salesorder/v1/SalesOrder/Created/v1')).toEqual({ entity: 'SalesOrder', action: 'Created' });
    expect(entityAndAction('x')).toEqual({ entity: null, action: null });
  });

  it('parses structured, binary and batch deliveries', () => {
    const event = cloudEvent({ id: 'e1' });
    const structured = deliveryOf(event, 'structured');
    const [one] = parseCloudEvents(structured.headers, raw(structured.body));
    expect(one).toMatchObject({ id: 'e1', entity: 'BusinessPartner', action: 'Changed', keys: { BusinessPartner: '1000' }, specversion: '1.0' });
    const binary = deliveryOf(event, 'binary');
    expect(parseCloudEvents(Object.fromEntries(Object.entries(binary.headers).map(([k, v]) => [k.toLowerCase(), v])), raw(binary.body))[0]).toMatchObject({ id: 'e1', type: event.type, keys: { BusinessPartner: '1000' } });
    const batch = deliveryOf([cloudEvent({ id: 'a' }), cloudEvent({ id: 'b' })], 'batch');
    expect(parseCloudEvents(batch.headers, raw(batch.body)).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('keeps the data of a non-thin payload without keys', () => {
    const [e] = parseCloudEvents({ 'content-type': 'application/cloudevents+json' }, raw({ ...cloudEvent(), data: { a: { nested: true }, list: [1] } }));
    expect(e.keys).toBeNull();
    expect(e.data).toEqual({ a: { nested: true }, list: [1] });
  });

  it('refuses what is not a CloudEvent', () => {
    for (const body of ['not json', '[]', '{"id":"1"}', '[1]', JSON.stringify({ specversion: '1.0', id: '', source: 's', type: 't' }), '"str"']) {
      expect(() => parseCloudEvents({ 'content-type': 'application/json' }, raw(body)), body).toThrow(CloudEventError);
    }
    expect(() => parseCloudEvents({}, Buffer.alloc(1_000_001))).toThrow(/too large/);
    expect(() => parseCloudEvents({}, raw(Array.from({ length: 101 }, () => cloudEvent())))).toThrow(/at most 100/);
  });

  it('matches types by glob, either form, empty list matches all', () => {
    expect(matchesType('sap.s4.beh.salesorder.v1.SalesOrder.Created.v1', [])).toBe(true);
    expect(matchesType('sap.s4.beh.salesorder.v1.SalesOrder.Created.v1', ['*SalesOrder.Created*'])).toBe(true);
    expect(matchesType('sap/s4/beh/salesorder/v1/SalesOrder/Created/v1', ['sap.s4.beh.salesorder.v1.SalesOrder.Created.v1'])).toBe(true);
    expect(matchesType('sap.s4.beh.salesorder.v1.SalesOrder.Created.v1', ['*Changed*', 'other'])).toBe(false);
    expect(matchesType('a.b', ['a.b+'])).toBe(false);
  });

  it('compares secrets in constant time and keys a delivery by source and id', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abd', 'abc')).toBe(false);
    expect(secretMatches(undefined, 'abc')).toBe(false);
    expect(secretMatches('abc', '')).toBe(false);
    const [a, b] = ['a', 'b'].map((id) => parseCloudEvents({}, raw(cloudEvent({ id })))[0]);
    expect(deliveryKey([a])).toBe(`${a.source}|a`);
    expect(deliveryKey([a, b])).toBe(createHash('sha1').update(`${a.source}|a\n${b.source}|b`).digest('hex'));
  });
});
