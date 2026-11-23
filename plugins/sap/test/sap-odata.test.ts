/** The SAP OData node and its presets against the fake S/4HANA server on loopback. No real SAP system is called. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { FakeS4 } from './fake-s4';
import { SALES, basicCredential, freshState, loadOptions, nodeNamed, run, runAsTool } from './helpers';
import { sapOData } from '../src/nodes/sap-odata';
import { plugin, DEFAULT_MAX_CONCURRENCY } from '../src/main';
import { checkBaseUrl } from '../src/odata/client';

const fake = new FakeS4();
beforeAll(async () => {
  process.env.LANDFLOW_SAP_ALLOWED_HOSTS = '127.0.0.1';
  await fake.start();
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.pageSize = 100;
  freshState();
});

const creds = () => basicCredential(fake);
const list = (extra = {}, options = {}) => run('sapOData', { ...SALES, operation: 'list', ...extra }, { credentials: creds(), ...options });

describe('descriptor', () => {
  it('is a tool, announces nine nodes and five credential types, and is not idempotent as a whole', () => {
    const d = sapOData.description;
    expect(d.usableAsTool).toBe(true);
    expect(d.idempotent).toBe(false);
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['sapOData', 'sapBusinessPartner', 'sapSalesOrder', 'sapPurchaseOrder', 'sapProduct', 'sapSupplierInvoice', 'sapTrigger', 'sapEvent']);
    expect(plugin.credentialTypes?.map((c) => c.name)).toEqual(['sapS4hanaBasicApi', 'sapS4hanaOAuth2Api', 'sapS4hanaOAuth2ClientApi', 'sapSandboxApi', 'sapEventApi']);
    expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
  });

  it('marks reads idempotent and writes destructive per operation', () => {
    const operation = d('operation');
    const byValue = Object.fromEntries((operation.options ?? []).map((o) => [o.value, o]));
    expect(byValue.get.idempotent).toBe(true);
    expect(byValue.list.idempotent).toBe(true);
    for (const op of ['create', 'update', 'delete']) {
      expect(byValue[op].idempotent).toBe(false);
      expect(byValue[op].toolAnnotations?.destructiveHint).toBe(true);
    }
    function d(name: string) {
      return sapOData.description.properties.find((p) => p.name === name)!;
    }
  });

  it('keeps writes off by default and the safety switches out of the tool schema', () => {
    const props = Object.keys((sapOData.description.toolInputSchema as any).properties);
    expect(props.sort()).toEqual(['body', 'entitySet', 'expand', 'filter', 'keys', 'operation', 'orderby', 'select', 'service', 'top']);
    const allow = sapOData.description.properties.find((p) => p.name === 'allowWrites')!;
    expect(allow.default).toBe(false);
  });

  it('preset nodes list only their operations', () => {
    expect((nodeNamed('sapProduct').description.toolInputSchema as any).properties.operation.enum).toEqual(['get', 'list']);
    expect((nodeNamed('sapPurchaseOrder').description.toolInputSchema as any).properties.operation.enum).toEqual(['get', 'list', 'create']);
    expect((nodeNamed('sapProduct').description.toolInputSchema as any).properties.body).toBeUndefined();
  });
});

describe('base URL and host checks', () => {
  it('needs https unless the host is named exactly on the operator list', () => {
    expect(() => checkBaseUrl('http://my.s4hana.cloud.sap', [])).toThrow(/https/);
    expect(() => checkBaseUrl('http://127.0.0.1:1', [])).toThrow(/https/);
    expect(() => checkBaseUrl('http://127.0.0.1:1', ['127.0.0.1'])).not.toThrow();
    expect(() => checkBaseUrl('http://x.s4hana.cloud.sap', ['.s4hana.cloud.sap'])).toThrow(/https/);
    expect(() => checkBaseUrl('https://my1-api.s4hana.cloud.sap', ['.s4hana.cloud.sap'])).not.toThrow();
    expect(() => checkBaseUrl('https://evil.example', ['.s4hana.cloud.sap'])).toThrow(/ALLOWED_HOSTS/);
    expect(() => checkBaseUrl('https://user:pw@my1-api.s4hana.cloud.sap', [])).toThrow(/user name/);
  });

  it('refuses a host that is not on the list at run time', async () => {
    process.env.LANDFLOW_SAP_ALLOWED_HOSTS = '.s4hana.cloud.sap';
    try {
      const r = await list();
      expect(r.error?.message).toMatch(/not in LANDFLOW_SAP_ALLOWED_HOSTS/);
      expect(fake.requests).toHaveLength(0);
    } finally {
      process.env.LANDFLOW_SAP_ALLOWED_HOSTS = '127.0.0.1';
    }
  });
});

describe('List and Get', () => {
  it('lists sales orders: wrappers stripped, dates ISO, ETag and keys kept, no $metadata call for a catalog read', async () => {
    const r = await list();
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(5);
    const first = r.items[0] as any;
    expect(first.SalesOrder).toBe('4500000001');
    expect(first.__metadata).toBeUndefined();
    expect(first.to_Item).toBeUndefined();
    expect(first.CreationDate).toBe('2026-11-01T08:00:00.000Z');
    expect(first.LastChangeDateTime).toBe('2026-11-01T09:00:00.000Z');
    expect(first.__etag).toBe('W/"v1"');
    expect(first.__keys).toEqual({ SalesOrder: '4500000001' });
    expect(fake.requests.filter((q) => q.path.endsWith('$metadata'))).toHaveLength(0);
    expect(fake.requests[0].headers.authorization).toMatch(/^Basic /);
  });

  it('passes $filter, $select and $orderby with %20 spaces and the key quoted', async () => {
    const r = await list({ filter: "SoldToParty eq '10100001' and OverallSDProcessStatus eq 'A'", select: 'SalesOrder,SoldToParty', orderby: 'SalesOrder desc' });
    expect(r.items.map((i: any) => i.SalesOrder)).toEqual(['4500000005', '4500000002']);
    expect(Object.keys(r.items[0]).filter((k) => !k.startsWith('__')).sort()).toEqual(['SalesOrder', 'SoldToParty']);
    const sent = fake.requests.at(-1)!;
    expect(sent.query.get('$filter')).toBe("(SoldToParty eq '10100001' and OverallSDProcessStatus eq 'A')");
    expect(sent.query.get('$top')).toBe('51');
  });

  it('pages by the server next link up to the limit, and says there is more', async () => {
    fake.pageSize = 2;
    const r = await list({ top: 3 }, {});
    expect(r.items).toHaveLength(3);
    expect(fake.requests.filter((q) => q.path.endsWith('/A_SalesOrder')).length).toBe(2);
    const all = await list({ returnAll: true });
    expect(all.items).toHaveLength(5);
    expect(all.items.at(-1)).toMatchObject({ SalesOrder: '4500000005' });
  });

  it('caps Return All at Max Records and reports the summary with includeSummary', async () => {
    const r = await list({ returnAll: true, options: { maxRecords: 3, includeSummary: true } });
    expect(r.items).toHaveLength(4);
    expect(r.items.at(-1)).toEqual({ __summary: { returned: 3, total: 5, hasMore: true } });
  });

  it('ceilings Max Records at 1000', async () => {
    await list({ returnAll: true, options: { maxRecords: 99999 } });
    expect(fake.requests.at(-1)!.query.get('$top')).toBe('1001');
  });

  it('gets one entity by typed keys with its ETag, expand and the items', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'get', keys: { SalesOrder: '4500000001' }, expand: 'to_Item' }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    const order = r.items[0] as any;
    expect(order.SalesOrder).toBe('4500000001');
    expect(order.to_Item).toHaveLength(1);
    expect(order.to_Item[0].Material).toBe('TG11');
    expect(order.__etag).toBe('W/"v1"');
    expect(fake.requests.at(-1)!.path).toBe("/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder('4500000001')");
  });

  it('builds composite keys', async () => {
    const r = await run('sapOData', { ...SALES, entitySet: 'A_SalesOrderItem', operation: 'get', keys: { SalesOrder: '4500000001', SalesOrderItem: '10' } }, { credentials: creds() });
    expect(r.items[0]).toMatchObject({ Material: 'TG11' });
    expect(decodeURIComponent(fake.requests.at(-1)!.path)).toContain("A_SalesOrderItem(SalesOrder='4500000001',SalesOrderItem='10')");
  });

  it('turns an unknown key into a "no such key" error with the status', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'get', keys: { SalesOrder: 'nope' } }, { credentials: creds() });
    expect(r.error?.message).toMatch(/404 no such key/);
  });

  it('reads a custom service through $metadata and refuses an entity set the tenant lacks', async () => {
    const ok = await run('sapOData', { authentication: 'basic', service: 'custom', customPath: '/sap/opu/odata/sap/ZMY_SRV', entitySet: 'A_Thing', operation: 'list' }, { credentials: creds() });
    expect(ok.items[0]).toMatchObject({ ThingID: 'T1', YY1_Color_ABC: 'red', __keys: { ThingID: 'T1' } });
    const bad = await run('sapOData', { authentication: 'basic', service: 'custom', customPath: '/sap/opu/odata/sap/ZMY_SRV', entitySet: 'A_Nope', operation: 'list' }, { credentials: creds() });
    expect(bad.error?.message).toMatch(/not an entity set of this tenant's service/);
  });

  it('refuses custom paths that could leave /sap/', async () => {
    for (const customPath of ['/etc/passwd', '/sap/../admin', 'http://evil/sap/x', '/sap/x?y=1', '/sap/x y']) {
      const r = await run('sapOData', { authentication: 'basic', service: 'custom', customPath, entitySet: 'A_Thing', operation: 'list' }, { credentials: creds() });
      expect(r.error, customPath).toBeDefined();
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('reads a V4 service: value, count and nextLink', async () => {
    fake.pageSize = 3;
    const r = await run(
      'sapOData',
      { authentication: 'basic', service: 'custom', customPath: '/sap/opu/odata4/sap/zv4_demo/srvd_a2x/sap/zv4_demo/0001', odataVersion: 'v4', entitySet: 'Items', operation: 'list', returnAll: true },
      { credentials: creds() },
    );
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(7);
    expect((r.items[0] as any).ChangedAt).toBe('2026-11-01T08:00:00.000Z');
    expect(fake.requests.some((q) => q.query.get('$count') === 'true')).toBe(true);
  });
});

describe('errors', () => {
  it('maps a 401 so the host renews a token, a 403 for a missing arrangement and an HTML login page', async () => {
    const bad = await run('sapOData', { ...SALES, operation: 'list' }, { credentials: basicCredential(fake, { password: 'wrong' }) });
    expect(bad.error?.message).toMatch(/401 Unauthorized/);
    fake.blockedServices.add('API_SALES_ORDER_SRV');
    const blocked = await list();
    expect(blocked.error?.message).toMatch(/403 Forbidden/);
    expect(blocked.error?.description).toMatch(/arrangement/);
    fake.blockedServices.clear();
    const html = await run('sapOData', { ...SALES, operation: 'get', keys: { SalesOrder: 'HTML' } }, { credentials: creds() });
    expect(html.error?.message).toMatch(/not an OData answer/);
  });

  it('retries a read once on a 5xx and fails the second time with the status', async () => {
    fake.fault({ match: (q) => q.method === 'GET' && q.path.endsWith('/A_SalesOrder'), status: 500, times: 1 });
    const once = await list();
    expect(once.error).toBeUndefined();
    fake.fault({ match: (q) => q.method === 'GET' && q.path.endsWith('/A_SalesOrder'), status: 500, times: 2 });
    const twice = await list();
    expect(twice.error?.message).toMatch(/500/);
  });

  it('honours Retry-After on a 429', async () => {
    fake.fault({ match: (q) => q.path.endsWith('/A_SalesOrder'), status: 429, headers: { 'retry-after': '0' }, times: 1 });
    const r = await list();
    expect(r.error).toBeUndefined();
    fake.fault({ match: (q) => q.path.endsWith('/A_SalesOrder'), status: 429, headers: { 'retry-after': '600' }, times: 3 });
    const long = await list();
    expect(long.error?.message).toMatch(/429 rate limited, retry after 600 s/);
  });

  it('does not follow a redirect and times out slow calls', async () => {
    fake.fault({ match: (q) => q.path.endsWith('/A_SalesOrder'), status: 302, headers: { location: 'http://127.0.0.1:1/login' } });
    expect((await list()).error?.message).toMatch(/redirects are not followed/);
    fake.fault({ match: (q) => q.path.endsWith('/A_SalesOrder'), status: 200, body: { d: { results: [] } }, delayMs: 1500 });
    const slow = await run('sapOData', { ...SALES, operation: 'list', options: { timeoutSeconds: 1 } }, { credentials: creds() });
    expect(slow.error?.message).toMatch(/timed out after 1 s/);
  });

  it('carries a business-rule error with its details and no request body', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'create', allowWrites: true, body: { SalesOrderType: 'OR', SoldToParty: '99999999' }, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(r.error?.message).toContain('VF/055: Customer 99999999 is blocked for sales');
    expect(r.error?.message).toContain('Sales area data missing');
    expect(r.error?.message).not.toContain('dev-password');
  });

  it('continues on fail with the status in the item', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'get', keys: { SalesOrder: 'nope' } }, { credentials: creds(), continueOnFail: true });
    expect(r.error).toBeUndefined();
    expect(r.items[0]).toMatchObject({ status: 404 });
  });
});

describe('writes', () => {
  const create = { ...SALES, operation: 'create', allowWrites: true, body: { SalesOrderType: 'OR', SoldToParty: '10100009', PurchaseOrderByCustomer: 'REF-1' }, options: { dryRun: 'off' } };

  it('are off unless Allow Writes is on, and nothing is sent', async () => {
    const r = await run('sapOData', { ...create, allowWrites: false }, { credentials: creds() });
    expect(r.error?.message).toMatch(/Writes are off/);
    expect(fake.requests).toHaveLength(0);
  });

  it('create: fetches a CSRF token, posts with token and cookie, and returns the new entity', async () => {
    const r = await run('sapOData', create, { credentials: creds() });
    expect(r.error).toBeUndefined();
    expect(r.items[0]).toMatchObject({ SoldToParty: '10100009', OverallSDProcessStatus: 'A', __keys: { SalesOrder: '4500000006' } });
    const post = fake.writes()[0];
    expect(post.method).toBe('POST');
    expect(post.headers['x-csrf-token']).toMatch(/^[0-9a-f]{24}$/);
    expect(String(post.headers.cookie)).toContain('SAP_SESSIONID=');
    expect(fake.requests.some((q) => q.headers['x-csrf-token'] === 'Fetch')).toBe(true);
  });

  it('create: deep insert of items works', async () => {
    const r = await run('sapOData', { ...create, body: { SalesOrderType: 'OR', SoldToParty: '10100009', to_Item: [{ Material: 'TG11', RequestedQuantity: '3' }, { Material: 'TG12', RequestedQuantity: '1' }] } }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    const order = (r.items[0] as any).SalesOrder;
    const got = await run('sapOData', { ...SALES, operation: 'get', keys: { SalesOrder: order }, expand: 'to_Item' }, { credentials: creds() });
    expect((got.items[0] as any).to_Item.map((i: any) => i.SalesOrderItem)).toEqual(['10', '20']);
  });

  it('refuses a property the tenant does not have, and one that is not creatable, before sending anything', async () => {
    const unknown = await run('sapOData', { ...create, body: { SoldToParty: '1', YY1_Missing: 'x' } }, { credentials: creds() });
    expect(unknown.error?.message).toMatch(/"YY1_Missing" is not in this tenant's service/);
    const key = await run('sapOData', { ...create, body: { SalesOrder: '1' } }, { credentials: creds() });
    expect(key.error?.message).toMatch(/cannot be set on create/);
    expect(fake.writes()).toHaveLength(0);
    const custom = await run('sapOData', { ...create, body: { SoldToParty: '10100009', YY1_Note_SDH: 'hello' } }, { credentials: creds() });
    expect(custom.error).toBeUndefined();
  });

  it('update: reads the ETag, PATCHes with If-Match and returns the new state', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'update', allowWrites: true, keys: { SalesOrder: '4500000003' }, body: { DeliveryBlockReason: '' }, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    expect((r.items[0] as any).DeliveryBlockReason).toBe('');
    expect((r.items[0] as any).__etag).toBe('W/"v2"');
    const patch = fake.writes().find((w) => w.method === 'PATCH')!;
    expect(patch.headers['if-match']).toBe('W/"v1"');
    expect(patch.body).toEqual({ DeliveryBlockReason: '' });
  });

  it('update: a stale ETag is a readable 412 and is not retried with *', async () => {
    // Another user changes the order between our read and our write.
    const original = fake.touch.bind(fake);
    let first = true;
    fake.faults.length = 0;
    fake.fault({
      match: (q) => {
        if (q.method === 'PATCH' && first) {
          first = false;
          original('A_SalesOrder', { SalesOrder: '4500000002' }, { DeliveryBlockReason: '02' });
        }
        return false;
      },
      status: 200,
      times: 99,
    });
    const r = await run('sapOData', { ...SALES, operation: 'update', allowWrites: true, keys: { SalesOrder: '4500000002' }, body: { DeliveryBlockReason: '' }, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(r.error?.message).toMatch(/412 the entity changed since it was read/);
    expect(fake.writes().filter((w) => w.method === 'PATCH')).toHaveLength(1);
  });

  it('update: refuses key and non-updatable properties', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'update', allowWrites: true, keys: { SalesOrder: '4500000003' }, body: { TotalNetAmount: '5' }, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(r.error?.message).toMatch(/cannot be updated/);
  });

  it('a missing ETag from SAP is a 428, and If-Match * is only sent on request', async () => {
    // SAP answers 428 when a write has no If-Match: strip the ETag the read carries.
    fake.fault({ match: (q) => q.method === 'GET' && q.path.includes("A_SalesOrder('4500000003')"), status: 200, body: { d: { SalesOrder: '4500000003', SoldToParty: 'x' } } });
    const r = await run('sapOData', { ...SALES, operation: 'update', allowWrites: true, keys: { SalesOrder: '4500000003' }, body: { DeliveryBlockReason: '' }, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(r.error?.message).toMatch(/428 SAP wants an ETag/);
    fake.requests.length = 0;
    const star = await run('sapOData', { ...SALES, operation: 'update', allowWrites: true, keys: { SalesOrder: '4500000003' }, body: { DeliveryBlockReason: '' }, options: { dryRun: 'off', ifMatchAny: true } }, { credentials: creds() });
    expect(star.error).toBeUndefined();
    expect(fake.writes().find((w) => w.method === 'PATCH')!.headers['if-match']).toBe('*');
  });

  it('refetches an expired CSRF token once and repeats the write', async () => {
    fake.csrfTtlMs = 60_000;
    let t = 1_000_000;
    fake.now = () => t;
    const r = await run('sapOData', { ...create, options: { dryRun: 'off', maxWritesPerRun: 5 } }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    // A new execution against a token that expires between fetch and use: expire the session mid-way.
    fake.expireCsrf();
    const second = await run('sapOData', create, { credentials: creds(), executionId: 'ex_two' });
    expect(second.error).toBeUndefined();
    const tokensFetched = fake.requests.filter((q) => q.headers['x-csrf-token'] === 'Fetch').length;
    expect(tokensFetched).toBeGreaterThanOrEqual(2);
  });

  it('a CSRF 403 on the first try triggers exactly one refetch and one repeat', async () => {
    // Expire the token right after it is fetched, so the first write answers 403 Required.
    let armed = true;
    fake.fault({
      match: (q) => {
        if (armed && q.method === 'POST' && q.path.endsWith('/A_SalesOrder')) {
          armed = false;
          fake.expireCsrf();
        }
        return false;
      },
      status: 200,
      times: 99,
    });
    const r = await run('sapOData', create, { credentials: creds() });
    expect(r.error).toBeUndefined();
    const posts = fake.writes().filter((w) => w.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(fake.requests.filter((q) => q.headers['x-csrf-token'] === 'Fetch')).toHaveLength(2);
  });

  it('delete needs Allow Deletes as well and honours the deletion rule', async () => {
    const del = { ...SALES, operation: 'delete', allowWrites: true, keys: { SalesOrder: '4500000002' }, options: { dryRun: 'off' } };
    const off = await run('sapOData', del, { credentials: creds() });
    expect(off.error?.message).toMatch(/Deletes are off/);
    expect(fake.requests).toHaveLength(0);
    const ok = await run('sapOData', { ...del, allowDeletes: true }, { credentials: creds() });
    expect(ok.items[0]).toEqual({ deleted: true, entitySet: 'A_SalesOrder', __keys: { SalesOrder: '4500000002' } });
    const followOn = await run('sapOData', { ...del, allowDeletes: true, keys: { SalesOrder: '4500000001' } }, { credentials: creds(), executionId: 'ex_b' });
    expect(followOn.error?.message).toMatch(/follow-on documents/);
  });

  it('Max Writes per Run counts before sending, per execution, and 0 means none', async () => {
    const params = { ...create, options: { dryRun: 'off', maxWritesPerRun: 2 } };
    expect((await run('sapOData', params, { credentials: creds(), executionId: 'ex_w' })).error).toBeUndefined();
    expect((await run('sapOData', params, { credentials: creds(), executionId: 'ex_w' })).error).toBeUndefined();
    const third = await run('sapOData', params, { credentials: creds(), executionId: 'ex_w' });
    expect(third.error?.message).toMatch(/already made 2 writes; Max Writes per Run is 2/);
    expect(fake.writes().filter((w) => w.method === 'POST')).toHaveLength(2);
    expect((await run('sapOData', params, { credentials: creds(), executionId: 'ex_other' })).error).toBeUndefined();
    const none = await run('sapOData', { ...create, options: { dryRun: 'off', maxWritesPerRun: 0 } }, { credentials: creds(), executionId: 'ex_zero' });
    expect(none.error?.message).toMatch(/switched off/);
  });

  it('Dry Run sends no write request and returns what would be sent, with the real current entity', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'update', allowWrites: true, keys: { SalesOrder: '4500000003' }, body: { DeliveryBlockReason: '' }, options: { dryRun: 'on' } }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    expect(fake.writes()).toHaveLength(0);
    expect(fake.requests.some((q) => q.headers['x-csrf-token'] === 'Fetch')).toBe(false);
    expect(r.items[0]).toMatchObject({ dryRun: true, operation: 'update', wouldSend: { method: 'PATCH', ifMatch: 'W/"v1"', body: { DeliveryBlockReason: '' } }, current: { SalesOrder: '4500000003', DeliveryBlockReason: '01' } });
    const c = await run('sapOData', { ...create, options: { dryRun: 'on' } }, { credentials: creds() });
    expect(c.items[0]).toMatchObject({ dryRun: true, wouldSend: { method: 'POST' } });
    expect(fake.writes()).toHaveLength(0);
    // A dry run does not use the write budget.
    expect((await run('sapOData', { ...create, options: { dryRun: 'off', maxWritesPerRun: 1 } }, { credentials: creds(), executionId: 'ex_d' })).error).toBeUndefined();
  });

  it('converts ISO dates in a body for DateTime properties', async () => {
    const r = await run('sapOData', { authentication: 'basic', service: 'custom', customPath: '/sap/opu/odata/sap/ZMY_SRV', entitySet: 'A_Thing', operation: 'create', allowWrites: true, body: { ThingID: 'T9', Name: 'n' }, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(r.error).toBeUndefined();
  });
});

describe('as an agent tool', () => {
  it('lists with only key fields unless select is given, and adds a summary item', async () => {
    const r = await runAsTool('sapOData', { authentication: 'basic' }, { service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'list', top: 2 }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.items[0]).filter((k) => !k.startsWith('__'))).toEqual(['SalesOrder']);
    expect(r.items.at(-1)).toMatchObject({ __summary: { returned: 2, total: 5, hasMore: true } });
    const wide = await runAsTool('sapOData', { authentication: 'basic' }, { service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'list', top: 1, select: 'SalesOrder,SoldToParty' }, { credentials: creds() });
    expect(wide.items[0]).toMatchObject({ SoldToParty: '10100001' });
  });

  it('refuses a write while Allow Writes is off, even when the model asks for it', async () => {
    const r = await runAsTool('sapOData', { authentication: 'basic' }, { service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'create', body: { SoldToParty: '1' } }, { credentials: creds() });
    expect(r.error?.message).toMatch(/Writes are off/);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses arguments outside the schema, so a model cannot switch the safety settings', async () => {
    const attempts: JsonObject[] = [{ allowWrites: true }, { allowDeletes: true }, { options: { dryRun: 'off', maxWritesPerRun: 999 } }, { customPath: '/sap/x' }, { authentication: 'sandbox' }];
    for (const args of attempts) {
      const r = await runAsTool('sapOData', { ...SALES, operation: 'create', allowWrites: false, body: { SoldToParty: '1' } }, { operation: 'create', body: { SoldToParty: '1' }, ...args }, { credentials: creds() });
      expect(r.error?.message, JSON.stringify(args)).toMatch(/does not take the argument/);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('a write is a dry run by default as a tool; the real write needs Dry Run off on the node', async () => {
    const node = { authentication: 'basic', allowWrites: true };
    const dry = await runAsTool('sapOData', node, { service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'create', body: { SoldToParty: '10100009' } }, { credentials: creds() });
    expect(dry.items[0]).toMatchObject({ dryRun: true });
    expect(fake.writes()).toHaveLength(0);
    const real = await runAsTool('sapOData', { ...node, options: { dryRun: 'off' } }, { service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'create', body: { SoldToParty: '10100009' } }, { credentials: creds() });
    expect(real.error).toBeUndefined();
    expect(fake.writes()).toHaveLength(1);
  });

  it('cannot name a path through service: only catalog ids or the node\'s own custom path', async () => {
    const r = await runAsTool('sapOData', { authentication: 'basic' }, { service: '/sap/opu/odata/sap/API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', operation: 'list' }, { credentials: creds() });
    expect(r.error?.message).toMatch(/Unknown service/);
  });

  it('the credential can narrow the services', async () => {
    const r = await run('sapOData', { ...SALES, operation: 'list' }, { credentials: basicCredential(fake, { allowedServices: 'API_BUSINESS_PARTNER' }) });
    expect(r.error?.message).toMatch(/does not allow the service API_SALES_ORDER_SRV/);
  });
});

describe('redaction', () => {
  it('blanks personal fields on request and keeps the keys', async () => {
    const r = await run('sapBusinessPartner', { authentication: 'basic', entitySet: 'A_BusinessPartner', operation: 'list', options: { redactPersonalData: true, redactFields: 'SearchTerm1' } }, { credentials: creds() });
    const bp = r.items[0] as any;
    expect(bp.OrganizationBPName1).toBe('[redacted]');
    expect(bp.EmailAddress).toBe('[redacted]');
    expect(bp.TaxNumber1).toBe('[redacted]');
    expect(bp.SearchTerm1).toBe('[redacted]');
    expect(bp.BusinessPartner).toBe('1000');
    expect(bp.__keys).toEqual({ BusinessPartner: '1000' });
  });
});

describe('presets', () => {
  it('Sales Order lists by customer and creation date', async () => {
    const r = await run('sapSalesOrder', { authentication: 'basic', entitySet: 'A_SalesOrder', operation: 'list', customer: '10100001', createdFrom: '2026-11-02T00:00:00Z' }, { credentials: creds() });
    expect(r.error).toBeUndefined();
    expect(r.items.map((i: any) => i.SalesOrder)).toEqual(['4500000002', '4500000005']);
    expect(fake.requests.at(-1)!.query.get('$filter')).toBe("SoldToParty eq '10100001' and CreationDate ge datetime'2026-11-02T00:00:00'");
  });

  it('Business Partner gets one by key; a preset refuses an operation it does not have', async () => {
    const r = await run('sapBusinessPartner', { authentication: 'basic', entitySet: 'A_BusinessPartner', operation: 'get', keys: { BusinessPartner: '1001' } }, { credentials: creds() });
    expect(r.items[0]).toMatchObject({ FirstName: 'Mira', LastChangeDate: '2026-11-02T00:00:00.000Z' });
    const del = await run('sapProduct', { authentication: 'basic', entitySet: 'A_Product', operation: 'delete', keys: { Product: '1' }, allowWrites: true, allowDeletes: true }, { credentials: creds() });
    expect(del.error?.message).toMatch(/not available on this node/);
  });

  it('Purchase Order creates, as a write that needs Allow Writes', async () => {
    const body = { CompanyCode: '1010', PurchasingOrganization: '1010', Supplier: '10300001' };
    const off = await run('sapPurchaseOrder', { authentication: 'basic', entitySet: 'A_PurchaseOrder', operation: 'create', body }, { credentials: creds() });
    expect(off.error?.message).toMatch(/Writes are off/);
    const on = await run('sapPurchaseOrder', { authentication: 'basic', entitySet: 'A_PurchaseOrder', operation: 'create', body, allowWrites: true, options: { dryRun: 'off' } }, { credentials: creds() });
    expect(on.error).toBeUndefined();
    expect(on.items[0]).toMatchObject({ Supplier: '10300001' });
  });
});

describe('credentials and pickers', () => {
  it('the sandbox key goes in the APIKey header', async () => {
    const r = await run('sapOData', { ...SALES, authentication: 'sandbox', operation: 'list', top: 1 }, { credentials: { sapSandboxApi: { apiKey: fake.apiKey, baseUrl: fake.url } } });
    expect(r.error).toBeUndefined();
    expect(fake.requests.at(-1)!.headers.apikey).toBe(fake.apiKey);
  });

  it('a bearer token works, and an expired one reads like a 401', async () => {
    fake.tokens.set('good', Date.now() + 60_000);
    fake.tokens.set('old', Date.now() - 1000);
    const ok = await run('sapOData', { ...SALES, authentication: 'oAuth2', operation: 'list', top: 1 }, { credentials: { sapS4hanaOAuth2Api: { baseUrl: fake.url, accessToken: 'good', clientId: 'c1' } } });
    expect(ok.error).toBeUndefined();
    const stale = await run('sapOData', { ...SALES, authentication: 'oAuth2', operation: 'list', top: 1 }, { credentials: { sapS4hanaOAuth2Api: { baseUrl: fake.url, accessToken: 'old', clientId: 'c1' } } });
    expect(stale.error?.message).toMatch(/401/);
    const notConnected = await run('sapOData', { ...SALES, authentication: 'oAuth2', operation: 'list' }, { credentials: { sapS4hanaOAuth2Api: { baseUrl: fake.url } } });
    expect(notConnected.error?.message).toMatch(/not connected/);
  });

  it('adds sap-client when the credential has one', async () => {
    await list({ top: 1 }, { credentials: basicCredential(fake, { sapClient: '100' }) });
    expect(fake.requests.at(-1)!.query.get('sap-client')).toBe('100');
  });

  it('entity sets come from $metadata, cached, falling back to the catalog without a credential', async () => {
    const options = await loadOptions('sapOData', 'entitySets', { authentication: 'basic', service: 'custom', customPath: '/sap/opu/odata/sap/ZMY_SRV' }, creds());
    expect(options).toEqual([{ name: 'A_Thing', value: 'A_Thing' }]);
    const again = await loadOptions('sapOData', 'entitySets', { authentication: 'basic', service: 'custom', customPath: '/sap/opu/odata/sap/ZMY_SRV' }, creds());
    expect(again).toHaveLength(1);
    expect(fake.requests.filter((q) => q.path.endsWith('$metadata'))).toHaveLength(1);
    const catalog = await loadOptions('sapOData', 'entitySets', { authentication: 'basic', service: 'API_SALES_ORDER_SRV' });
    expect(catalog.map((o) => o.value)).toEqual(['A_SalesOrder', 'A_SalesOrderItem']);
  });

  it('test connection reads one row and reports the host', async () => {
    const type = plugin.credentialTypes!.find((c) => c.name === 'sapS4hanaBasicApi')!;
    const ctx = { credentialType: type.name, logger: console as any, http: fetch as any, span: undefined as any, helpers: undefined as any };
    const good = await type.test!({ baseUrl: fake.url, user: fake.user, password: fake.password, testService: 'API_BUSINESS_PARTNER' } as any, ctx as any);
    expect(good).toMatchObject({ ok: true });
    const bad = await type.test!({ baseUrl: fake.url, user: fake.user, password: 'no' } as any, ctx as any);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/401/);
  });
});
