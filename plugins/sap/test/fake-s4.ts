/**
 * A fake SAP S/4HANA Cloud API on loopback (spec 4.1). It is hand-written from the spec, not captured from SAP, so it proves how the
 * plugin behaves against the documented protocol rules, not against a real tenant. Nothing here talks to the network except 127.0.0.1.
 *
 * Emulates: Basic, API key and OAuth bearer auth (an authorization-code + PKCE round trip, refresh, client credentials); `$metadata`
 * (EDMX with `sap:` annotations) for Business Partner, Sales Order, Purchase Order and a custom `ZMY_SRV` with `YY1_` fields, plus a
 * small V4 service; CSRF token and session cookie (with expiry); ETags with 428 and 412; paging with `__next`; a `$filter` subset;
 * V2 and V4 error JSON; faults (HTML login page, 429, 500, a slow call); the deletion rule of sales orders; and a change feed whose
 * `LastChangeDateTime` moves on write. Run it by hand for a live check: `tsx plugins/sap/test/fake-s4.ts` (PORT, default 3651).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Prop {
  name: string;
  type: string;
  key?: boolean;
  creatable?: boolean;
  updatable?: boolean;
  displayFormat?: string;
}
interface Nav {
  name: string;
  target: string;
}
interface EntityDef {
  set: string;
  type: string;
  props: Prop[];
  nav?: Nav[];
  deletable?: boolean;
}
interface ServiceDef {
  id: string;
  version: 'v2' | 'v4';
  path: string;
  entities: EntityDef[];
}

const s = (name: string, extra: Partial<Prop> = {}): Prop => ({ name, type: 'Edm.String', ...extra });
const dt = (name: string, extra: Partial<Prop> = {}): Prop => ({ name, type: 'Edm.DateTime', ...extra });
const dto = (name: string, extra: Partial<Prop> = {}): Prop => ({ name, type: 'Edm.DateTimeOffset', ...extra });

export const SERVICES: ServiceDef[] = [
  {
    id: 'API_BUSINESS_PARTNER',
    version: 'v2',
    path: '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
    entities: [
      {
        set: 'A_BusinessPartner',
        type: 'A_BusinessPartnerType',
        props: [s('BusinessPartner', { key: true, creatable: false, updatable: false }), s('BusinessPartnerCategory'), s('OrganizationBPName1'), s('FirstName'), s('LastName'), s('SearchTerm1'), s('EmailAddress'), s('TaxNumber1'), dt('CreationDate', { creatable: false, updatable: false, displayFormat: 'Date' }), dt('LastChangeDate', { creatable: false, updatable: false, displayFormat: 'Date' })],
      },
    ],
  },
  {
    id: 'API_SALES_ORDER_SRV',
    version: 'v2',
    path: '/sap/opu/odata/sap/API_SALES_ORDER_SRV',
    entities: [
      {
        set: 'A_SalesOrder',
        type: 'A_SalesOrderType',
        props: [s('SalesOrder', { key: true, creatable: false, updatable: false }), s('SalesOrderType'), s('SoldToParty'), s('PurchaseOrderByCustomer'), s('DeliveryBlockReason'), s('OverallSDProcessStatus', { creatable: false, updatable: false }), { name: 'TotalNetAmount', type: 'Edm.Decimal', creatable: false, updatable: false }, s('TransactionCurrency'), dt('CreationDate', { creatable: false, updatable: false }), dto('LastChangeDateTime', { creatable: false, updatable: false }), s('YY1_Note_SDH')],
        nav: [{ name: 'to_Item', target: 'A_SalesOrderItem' }],
        deletable: true,
      },
      {
        set: 'A_SalesOrderItem',
        type: 'A_SalesOrderItemType',
        props: [s('SalesOrder', { key: true }), s('SalesOrderItem', { key: true }), s('Material'), s('RequestedQuantity')],
      },
    ],
  },
  {
    id: 'API_PURCHASEORDER_PROCESS_SRV',
    version: 'v2',
    path: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV',
    entities: [
      {
        set: 'A_PurchaseOrder',
        type: 'A_PurchaseOrderType',
        props: [s('PurchaseOrder', { key: true, creatable: false, updatable: false }), s('CompanyCode'), s('PurchasingOrganization'), s('Supplier'), dto('LastChangeDateTime', { creatable: false, updatable: false })],
        nav: [{ name: 'to_PurchaseOrderItem', target: 'A_PurchaseOrderItem' }],
      },
      { set: 'A_PurchaseOrderItem', type: 'A_PurchaseOrderItemType', props: [s('PurchaseOrder', { key: true }), s('PurchaseOrderItem', { key: true }), s('Material'), s('OrderQuantity')] },
    ],
  },
  {
    id: 'ZMY_SRV',
    version: 'v2',
    path: '/sap/opu/odata/sap/ZMY_SRV',
    entities: [{ set: 'A_Thing', type: 'A_ThingType', props: [s('ThingID', { key: true }), s('Name'), s('YY1_Color_ABC'), dto('LastChangeDateTime', { creatable: false, updatable: false })] }],
  },
  {
    id: 'ZV4_DEMO',
    version: 'v4',
    path: '/sap/opu/odata4/sap/zv4_demo/srvd_a2x/sap/zv4_demo/0001',
    entities: [{ set: 'Items', type: 'ItemType', props: [s('ID', { key: true }), s('Title'), dto('ChangedAt')] }],
  },
];

type Row = Record<string, unknown> & { __v: number };
type Fault = {
  match: (request: Recorded) => boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  times: number;
};

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export interface FakeOptions {
  /** Server page size for collections (default 100): more rows get a `__next` link. */
  pageSize?: number;
  user?: string;
  password?: string;
  apiKey?: string;
  csrfTtlMs?: number;
}

const V2_ERROR = (code: string, message: string, details: Array<{ code: string; message: string }> = []) => ({
  error: { code, message: { lang: 'en', value: message }, innererror: { errordetails: details.map((d) => ({ ...d, severity: 'error' })) } },
});
const V4_ERROR = (code: string, message: string, target?: string) => ({ error: { code, message, ...(target && { target }), details: [] } });

const sapDate = (ms: number) => `/Date(${ms})/`;
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class FakeS4 {
  readonly rows = new Map<string, Row[]>();
  readonly requests: Recorded[] = [];
  readonly faults: Fault[] = [];
  pageSize: number;
  user: string;
  password: string;
  apiKey: string;
  csrfTtlMs: number;
  /** The clock of the fake: tests set it to control `LastChangeDateTime`. */
  now: () => number = () => Date.now();
  blockedServices = new Set<string>();
  /** Valid bearer tokens and when they expire (ms). */
  readonly tokens = new Map<string, number>();
  readonly refreshTokens = new Map<string, { client: string }>();
  readonly codes = new Map<string, { challenge: string; client: string }>();
  readonly sessions = new Map<string, { token: string; expires: number }>();
  tokenLifetimeMs = 3_600_000;
  private seq = 4_500_000_000;
  private server?: Server;
  url = '';
  port = 0;

  constructor(options: FakeOptions = {}) {
    this.pageSize = options.pageSize ?? 100;
    this.user = options.user ?? 'COMM_USER';
    this.password = options.password ?? 'dev-password';
    this.apiKey = options.apiKey ?? 'sandbox-key';
    this.csrfTtlMs = options.csrfTtlMs ?? 30 * 60_000;
    this.reset();
  }

  /** Back to the starting data. */
  reset() {
    this.rows.clear();
    this.requests.length = 0;
    this.faults.length = 0;
    this.sessions.clear();
    this.blockedServices.clear();
    this.now = () => Date.now();
    this.csrfTtlMs = 30 * 60_000;
    const t0 = Date.parse('2026-11-01T08:00:00Z');
    this.rows.set('A_BusinessPartner', [
      this.row({ BusinessPartner: '1000', BusinessPartnerCategory: '2', OrganizationBPName1: 'Acme Corp', SearchTerm1: 'ACME', EmailAddress: 'ap@acme.example', TaxNumber1: 'DE123456789', CreationDate: Date.parse('2026-01-05T00:00:00Z'), LastChangeDate: Date.parse('2026-10-30T00:00:00Z') }),
      this.row({ BusinessPartner: '1001', BusinessPartnerCategory: '1', FirstName: 'Mira', LastName: 'Okafor', SearchTerm1: 'OKAFOR', EmailAddress: 'mira@example.test', CreationDate: Date.parse('2026-02-11T00:00:00Z'), LastChangeDate: Date.parse('2026-11-02T00:00:00Z') }),
      this.row({ BusinessPartner: '1002', BusinessPartnerCategory: '2', OrganizationBPName1: 'Globex', SearchTerm1: 'GLOBEX', CreationDate: Date.parse('2026-03-01T00:00:00Z'), LastChangeDate: Date.parse('2026-11-03T00:00:00Z') }),
    ]);
    const order = (n: number, customer: string, day: number, status: string, extra: Record<string, unknown> = {}) =>
      this.row({ SalesOrder: String(this.seq + n), SalesOrderType: 'OR', SoldToParty: customer, PurchaseOrderByCustomer: `PO-${n}`, OverallSDProcessStatus: status, TotalNetAmount: `${n * 100}.00`, TransactionCurrency: 'EUR', CreationDate: t0 + day * 86_400_000, LastChangeDateTime: t0 + day * 86_400_000 + 3_600_000, ...extra });
    this.rows.set('A_SalesOrder', [
      order(1, '10100001', 0, 'C', { FollowOn: true }),
      order(2, '10100001', 1, 'A'),
      order(3, '10100002', 2, 'A', { DeliveryBlockReason: '01' }),
      order(4, '10100003', 3, 'B'),
      order(5, '10100001', 4, 'A'),
    ]);
    this.rows.set('A_SalesOrderItem', [
      this.row({ SalesOrder: String(this.seq + 1), SalesOrderItem: '10', Material: 'TG11', RequestedQuantity: '2' }),
      this.row({ SalesOrder: String(this.seq + 2), SalesOrderItem: '10', Material: 'TG12', RequestedQuantity: '1' }),
    ]);
    this.rows.set('A_PurchaseOrder', [this.row({ PurchaseOrder: '4500000100', CompanyCode: '1010', PurchasingOrganization: '1010', Supplier: '10300001', LastChangeDateTime: t0 })]);
    this.rows.set('A_PurchaseOrderItem', []);
    this.rows.set('A_Thing', [this.row({ ThingID: 'T1', Name: 'First', YY1_Color_ABC: 'red', LastChangeDateTime: t0 })]);
    this.rows.set('Items', Array.from({ length: 7 }, (_, i) => this.row({ ID: `I${i + 1}`, Title: `Item ${i + 1}`, ChangedAt: t0 + i * 60_000 })));
  }

  private row(values: Record<string, unknown>): Row {
    return { ...values, __v: 1 } as Row;
  }

  // ---- helpers for tests ------------------------------------------------------------------

  /** Changes a sales order directly (as another user would) and moves its change timestamp. */
  touch(set: string, key: Record<string, string>, changes: Record<string, unknown> = {}, at = this.now()) {
    const row = this.find(set, key);
    if (!row) throw new Error(`no ${set} ${JSON.stringify(key)}`);
    Object.assign(row, changes);
    row.__v++;
    const def = this.entity(set);
    for (const name of ['LastChangeDateTime', 'LastChangeDate', 'ChangedAt']) if (def?.props.some((p) => p.name === name)) row[name] = at;
    return row;
  }

  /** A new sales order as another user would create it. */
  addOrder(customer = '10100001', values: Record<string, unknown> = {}): Row {
    const n = this.rows.get('A_SalesOrder')!.length + 1;
    const at = this.now();
    const row = this.row({ SalesOrder: String(this.seq + n), SalesOrderType: 'OR', SoldToParty: customer, OverallSDProcessStatus: 'A', TransactionCurrency: 'EUR', TotalNetAmount: '10.00', CreationDate: at, LastChangeDateTime: at, ...values });
    this.rows.get('A_SalesOrder')!.push(row);
    return row;
  }

  expireCsrf() {
    for (const session of this.sessions.values()) session.expires = 0;
  }

  fault(fault: Omit<Fault, 'times'> & { times?: number }) {
    this.faults.push({ times: 1, ...fault });
  }

  writes() {
    return this.requests.filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE', 'MERGE'].includes(r.method) && !r.path.includes('/oauth2/') && !r.path.startsWith('/__fake'));
  }

  private entity(set: string): EntityDef | undefined {
    for (const service of SERVICES) {
      const found = service.entities.find((e) => e.set === set);
      if (found) return found;
    }
    return undefined;
  }

  private keyOf(def: EntityDef, row: Row): Record<string, string> {
    return Object.fromEntries(def.props.filter((p) => p.key).map((p) => [p.name, String(row[p.name])]));
  }

  private find(set: string, key: Record<string, string>): Row | undefined {
    const def = this.entity(set);
    if (!def) return undefined;
    return (this.rows.get(set) ?? []).find((r) => Object.entries(key).every(([k, v]) => String(r[k]) === v));
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.handle(req, res, Buffer.concat(chunks).toString('utf8')).catch((error) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(V2_ERROR('FAKE/500', `fake server bug: ${(error as Error).message}`)));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async stop() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  // ---- request handling ---------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse, text: string) {
    const url = new URL(req.url ?? '/', this.url || 'http://127.0.0.1');
    const contentType = String(req.headers['content-type'] ?? '');
    let body: any = text;
    if (text && /json/.test(contentType)) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else if (text && /urlencoded/.test(contentType)) body = Object.fromEntries(new URLSearchParams(text));
    const recorded: Recorded = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: body === '' ? undefined : body };
    this.requests.push(recorded);

    const send = (status: number, payload?: unknown, headers: Record<string, string | string[]> = {}) => {
      const isText = typeof payload === 'string';
      res.writeHead(status, { ...(payload !== undefined && { 'content-type': isText ? (headers['content-type'] as string) ?? 'text/plain' : 'application/json' }), ...headers });
      res.end(payload === undefined ? undefined : isText ? payload : JSON.stringify(payload));
    };

    if (url.pathname.startsWith('/__fake/')) return this.control(recorded, send);
    if (url.pathname.includes('/oauth2/')) return this.oauth(recorded, send);

    const faultAt = this.faults.findIndex((f) => f.times > 0 && f.match(recorded));
    if (faultAt >= 0) {
      const fault = this.faults[faultAt];
      fault.times--;
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (res.destroyed) return;
      return send(fault.status, fault.body ?? V2_ERROR('FAKE/FAULT', 'injected fault'), fault.headers ?? {});
    }

    const service = SERVICES.find((svc) => url.pathname === svc.path || url.pathname.startsWith(`${svc.path}/`));
    if (!service) return send(404, V2_ERROR('/IWFND/CM_COS/001', `Resource not found for segment '${url.pathname}'`));
    if (!this.authenticate(recorded)) return send(401, V2_ERROR('FAKE/401', 'Logon failed'), { 'www-authenticate': 'Basic realm="fake-s4"' });
    if (this.blockedServices.has(service.id)) return send(403, V2_ERROR('/IWFND/CM_COS/003', `No authorization for service ${service.id}: add it to a communication arrangement`));

    const rest = url.pathname.slice(service.path.length).replace(/^\//, '');
    const error = (status: number, code: string, message: string, headers: Record<string, string> = {}, details: Array<{ code: string; message: string }> = []) =>
      send(status, service.version === 'v4' ? V4_ERROR(code, message) : V2_ERROR(code, message, details), headers);

    if (rest === '$metadata') return send(200, this.edmx(service), { 'content-type': 'application/xml' });
    if (rest === '') {
      if (String(req.headers['x-csrf-token'] ?? '').toLowerCase() === 'fetch') {
        const cookieSession = /SAP_SESSIONID=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
        const id = cookieSession && this.sessions.has(cookieSession) ? cookieSession : randomBytes(8).toString('hex');
        const token = randomBytes(12).toString('hex');
        this.sessions.set(id, { token, expires: this.now() + this.csrfTtlMs });
        return send(200, service.version === 'v4' ? { value: service.entities.map((e) => ({ name: e.set, url: e.set })) } : { d: { EntitySets: service.entities.map((e) => e.set) } }, { 'x-csrf-token': token, 'set-cookie': [`SAP_SESSIONID=${id}; Path=/; HttpOnly`, 'sap-usercontext=sap-client=100; Path=/'] });
      }
      return send(200, { d: { EntitySets: service.entities.map((e) => e.set) } });
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(rest);
    const def = match ? service.entities.find((e) => e.set === match[1]) : undefined;
    if (!match || !def) return error(404, '/IWBEP/CM_MGW_RT/020', `Resource not found for the segment '${rest}'`);
    const set = def.set;
    const keyText = match[2];

    // ---- reads ----------------------------------------------------------------------------
    if (recorded.method === 'GET') {
      if (!keyText) return this.list(service, def, recorded, send);
      const key = this.parseKey(def, keyText);
      if (!key) return error(400, '/IWBEP/CM_MGW_RT/021', 'Invalid key predicate');
      if (key.SalesOrder === 'ERR500' || key.ID === 'ERR500') return send(500, V2_ERROR('/IWFND/CM_COS/500', 'Internal error in the fake'));
      if (key.SalesOrder === 'HTML') return send(200, '<html><body>Please log in</body></html>', { 'content-type': 'text/html' });
      const row = this.find(set, key);
      if (!row) return error(404, '/IWBEP/CM_MGW_RT/020', `Resource not found for segment '${set}'`);
      return send(200, this.wrap(service, def, row, recorded.query, true), { etag: this.etag(row) });
    }

    // ---- writes: CSRF, then ETag ----------------------------------------------------------
    const csrf = this.checkCsrf(recorded);
    if (!csrf) return error(403, '/IWFND/CM_COS/403', 'CSRF token validation failed', { 'x-csrf-token': 'Required' });

    if (recorded.method === 'POST') {
      if (keyText) return error(405, 'FAKE/405', 'POST on an entity');
      const payload = recorded.body;
      if (!payload || typeof payload !== 'object') return error(400, '/IWBEP/CM_MGW_RT/010', 'Invalid body');
      if (set === 'A_SalesOrder' && payload.SoldToParty === '99999999') {
        return error(400, 'VF/055', 'Customer 99999999 is blocked for sales', {}, [{ code: 'VF/055', message: 'Customer 99999999 is blocked for sales' }, { code: 'V1/012', message: 'Sales area data missing' }]);
      }
      const unknown = Object.keys(payload).filter((k) => !def.props.some((p) => p.name === k) && !def.nav?.some((n) => n.name === k));
      if (unknown.length) return error(400, '/IWBEP/CM_MGW_RT/021', `Property '${unknown[0]}' is invalid`);
      const at = this.now();
      const row = this.row({});
      for (const prop of def.props) if (prop.name in payload) row[prop.name] = this.fromWire(prop, payload[prop.name]);
      const keyProp = def.props.find((p) => p.key && p.creatable === false);
      if (keyProp) row[keyProp.name] = String(this.seq + this.rows.get(set)!.length + 1);
      for (const name of ['CreationDate']) if (def.props.some((p) => p.name === name)) row[name] = at;
      for (const name of ['LastChangeDateTime']) if (def.props.some((p) => p.name === name)) row[name] = at;
      if (set === 'A_SalesOrder') row.OverallSDProcessStatus = 'A';
      this.rows.get(set)!.push(row);
      for (const nav of def.nav ?? []) {
        const items = payload[nav.name];
        if (Array.isArray(items)) {
          const itemDef = service.entities.find((e) => e.set === nav.target)!;
          items.forEach((item: Record<string, unknown>, index: number) => {
            const child = this.row({});
            for (const prop of itemDef.props) if (prop.name in item) child[prop.name] = this.fromWire(prop, item[prop.name]);
            child[def.props.find((p) => p.key)!.name] = row[def.props.find((p) => p.key)!.name];
            child[itemDef.props.filter((p) => p.key)[1].name] = String((index + 1) * 10);
            this.rows.get(nav.target)!.push(child);
          });
        }
      }
      return send(201, this.wrap(service, def, row, new URLSearchParams(), true), { etag: this.etag(row), location: `${this.url}${service.path}/${set}${this.keyPredicate(def, row)}` });
    }

    const key = keyText ? this.parseKey(def, keyText) : undefined;
    if (!key) return error(400, '/IWBEP/CM_MGW_RT/021', 'A key is needed');
    const row = this.find(set, key);
    if (!row) return error(404, '/IWBEP/CM_MGW_RT/020', `Resource not found for segment '${set}'`);
    const ifMatch = String(req.headers['if-match'] ?? '');
    if (!ifMatch) return error(428, '/IWBEP/CM_MGW_RT/113', 'Precondition required: send If-Match with the ETag');
    if (ifMatch !== '*' && ifMatch !== this.etag(row)) return error(412, '/IWBEP/CM_MGW_RT/112', 'Precondition failed: the ETag does not match');

    if (recorded.method === 'PATCH' || recorded.method === 'MERGE') {
      const payload = recorded.body;
      if (!payload || typeof payload !== 'object') return error(400, '/IWBEP/CM_MGW_RT/010', 'Invalid body');
      for (const [name, value] of Object.entries(payload)) {
        const prop = def.props.find((p) => p.name === name);
        if (!prop) return error(400, '/IWBEP/CM_MGW_RT/021', `Property '${name}' is invalid`);
        if (prop.key || prop.updatable === false) return error(400, '/IWBEP/CM_MGW_RT/022', `Property '${name}' is not updatable`);
        row[name] = this.fromWire(prop, value);
      }
      row.__v++;
      for (const name of ['LastChangeDateTime']) if (def.props.some((p) => p.name === name)) row[name] = this.now();
      return send(204, undefined, { etag: this.etag(row) });
    }
    if (recorded.method === 'DELETE') {
      if (!def.deletable) return error(405, 'FAKE/405', `${set} cannot be deleted`);
      if (row.FollowOn === true) return error(400, 'V1/044', `Sales order ${row.SalesOrder} has follow-on documents and cannot be deleted`);
      this.rows.set(set, this.rows.get(set)!.filter((r) => r !== row));
      return send(204);
    }
    return error(405, 'FAKE/405', `${recorded.method} is not supported`);
  }

  private authenticate(r: Recorded): boolean {
    const authorization = String(r.headers.authorization ?? '');
    if (authorization.startsWith('Basic ')) {
      const [user, ...rest] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
      return user === this.user && rest.join(':') === this.password;
    }
    if (authorization.startsWith('Bearer ')) {
      const expires = this.tokens.get(authorization.slice(7));
      return expires !== undefined && expires > this.now();
    }
    const key = r.headers.apikey ?? r.headers.APIKey;
    return key === this.apiKey;
  }

  private checkCsrf(r: Recorded): boolean {
    const id = /SAP_SESSIONID=([^;]+)/.exec(String(r.headers.cookie ?? ''))?.[1];
    const session = id ? this.sessions.get(id) : undefined;
    return !!session && session.token === r.headers['x-csrf-token'] && session.expires > this.now();
  }

  private etag(row: Row) {
    return `W/"v${row.__v}"`;
  }

  private keyPredicate(def: EntityDef, row: Row) {
    const keys = def.props.filter((p) => p.key);
    const lit = (p: Prop) => `'${String(row[p.name]).replace(/'/g, "''")}'`;
    return keys.length === 1 ? `(${lit(keys[0])})` : `(${keys.map((p) => `${p.name}=${lit(p)}`).join(',')})`;
  }

  private parseKey(def: EntityDef, text: string): Record<string, string> | undefined {
    const keys = def.props.filter((p) => p.key);
    const decoded = decodeURIComponent(text);
    const value = (raw: string) => (/^'.*'$/.test(raw) ? raw.slice(1, -1).replace(/''/g, "'") : raw);
    if (keys.length === 1 && !decoded.includes('=')) return { [keys[0].name]: value(decoded) };
    const out: Record<string, string> = {};
    for (const part of decoded.match(/[A-Za-z_]\w*=('(?:[^']|'')*'|[^,]*)/g) ?? []) {
      const at = part.indexOf('=');
      out[part.slice(0, at)] = value(part.slice(at + 1));
    }
    return keys.every((p) => p.name in out) ? out : undefined;
  }

  private fromWire(prop: Prop, value: unknown): unknown {
    if (typeof value === 'string' && (prop.type === 'Edm.DateTime' || prop.type === 'Edm.DateTimeOffset')) {
      const m = /^\/Date\((-?\d+)\)\/$/.exec(value);
      return m ? Number(m[1]) : Date.parse(value);
    }
    return value;
  }

  private toWire(service: ServiceDef, prop: Prop, value: unknown): unknown {
    if (typeof value !== 'number' || !prop.type.startsWith('Edm.Date')) return value;
    return service.version === 'v4' ? new Date(value).toISOString() : sapDate(value);
  }

  private wrap(service: ServiceDef, def: EntityDef, row: Row, query: URLSearchParams, single: boolean): Record<string, unknown> {
    const select = query.get('$select')?.split(',').map((x) => x.trim());
    const expand = query.get('$expand')?.split(',').map((x) => x.trim()) ?? [];
    const out: Record<string, unknown> = {};
    for (const prop of def.props) {
      if (select && select[0] !== '*' && !select.includes(prop.name) && !prop.key) continue;
      if (row[prop.name] !== undefined) out[prop.name] = this.toWire(service, prop, row[prop.name]);
    }
    if (service.version === 'v4') return { ...out, '@odata.etag': this.etag(row) };
    for (const nav of def.nav ?? []) {
      if (expand.includes(nav.name)) {
        const target = service.entities.find((e) => e.set === nav.target)!;
        const keyName = def.props.find((p) => p.key)!.name;
        out[nav.name] = { results: (this.rows.get(nav.target) ?? []).filter((c) => c[keyName] === row[keyName]).map((c) => this.wrap(service, target, c, new URLSearchParams(), false)) };
      } else out[nav.name] = { __deferred: { uri: `${this.url}${service.path}/${def.set}${this.keyPredicate(def, row)}/${nav.name}` } };
    }
    const meta = { id: `${this.url}${service.path}/${def.set}${this.keyPredicate(def, row)}`, uri: `${this.url}${service.path}/${def.set}${this.keyPredicate(def, row)}`, type: `${service.id}.${def.type}`, etag: this.etag(row) };
    const entity = { __metadata: meta, ...out };
    return single ? { d: entity } : entity;
  }

  private list(service: ServiceDef, def: EntityDef, r: Recorded, send: (status: number, payload?: unknown, headers?: Record<string, string>) => void) {
    const q = r.query;
    let rows = [...(this.rows.get(def.set) ?? [])];
    try {
      const filter = q.get('$filter');
      if (filter) {
        const predicate = compileFilter(filter, def);
        rows = rows.filter(predicate);
      }
    } catch (error) {
      return send(400, service.version === 'v4' ? V4_ERROR('400', `Invalid $filter: ${(error as Error).message}`, '$filter') : V2_ERROR('/IWBEP/CM_MGW_RT/012', `Invalid $filter: ${(error as Error).message}`));
    }
    const orderby = q.get('$orderby');
    if (orderby) {
      const keys = orderby.split(',').map((x) => x.trim().split(/\s+/));
      rows.sort((a, b) => {
        for (const [name, dir] of keys) {
          const av = a[name] as any;
          const bv = b[name] as any;
          if (av === bv) continue;
          return ((av ?? '') < (bv ?? '') ? -1 : 1) * (dir === 'desc' ? -1 : 1);
        }
        return 0;
      });
    }
    const total = rows.length;
    const offset = Number(q.get('$skip') ?? 0) + Number(q.get('$skiptoken') ?? 0);
    const top = q.has('$top') ? Number(q.get('$top')) : Infinity;
    const window = rows.slice(offset, Number.isFinite(top) ? offset + top : undefined);
    const page = window.slice(0, this.pageSize);
    let next: string | undefined;
    if (window.length > page.length) {
      const nextQuery = new URLSearchParams(q);
      nextQuery.delete('$skip');
      nextQuery.set('$skiptoken', String(offset + page.length));
      if (Number.isFinite(top)) nextQuery.set('$top', String(top - page.length));
      next = `${this.url}${r.path}?${nextQuery.toString().replace(/\+/g, '%20')}`;
    }
    const results = page.map((row) => this.wrap(service, def, row, q, false));
    const count = q.get('$inlinecount') === 'allpages' || q.get('$count') === 'true';
    if (service.version === 'v4') return send(200, { value: results, ...(count && { '@odata.count': total }), ...(next && { '@odata.nextLink': next }) });
    return send(200, { d: { results, ...(count && { __count: String(total) }), ...(next && { __next: next }) } });
  }

  private control(r: Recorded, send: (status: number, payload?: unknown, headers?: Record<string, string>) => void) {
    if (r.method === 'GET' && r.path === '/__fake/state') return send(200, { orders: this.rows.get('A_SalesOrder'), requests: this.requests.length });
    if (r.method === 'POST' && r.path === '/__fake/order') {
      const row = this.addOrder(r.body?.customer ?? '10100001', r.body?.values ?? {});
      return send(200, { created: row.SalesOrder });
    }
    if (r.method === 'POST' && r.path === '/__fake/touch') {
      const row = this.touch('A_SalesOrder', { SalesOrder: String(r.body.salesOrder) }, r.body.changes ?? {});
      return send(200, { touched: row.SalesOrder });
    }
    if (r.method === 'POST' && r.path === '/__fake/reset') {
      this.reset();
      return send(200, { reset: true });
    }
    return send(404, { error: 'unknown control route' });
  }

  private oauth(r: Recorded, send: (status: number, payload?: unknown, headers?: Record<string, string>) => void) {
    const issue = (client: string, withRefresh: boolean) => {
      const access = `at_${randomBytes(8).toString('hex')}`;
      this.tokens.set(access, this.now() + this.tokenLifetimeMs);
      let refresh: string | undefined;
      if (withRefresh) {
        refresh = `rt_${randomBytes(8).toString('hex')}`;
        this.refreshTokens.set(refresh, { client });
      }
      return { access_token: access, token_type: 'Bearer', expires_in: Math.round(this.tokenLifetimeMs / 1000), ...(refresh && { refresh_token: refresh }) };
    };
    if (r.path.endsWith('/authorize')) {
      const redirect = r.query.get('redirect_uri') ?? '';
      const code = `code_${randomBytes(6).toString('hex')}`;
      this.codes.set(code, { challenge: r.query.get('code_challenge') ?? '', client: r.query.get('client_id') ?? '' });
      const location = `${redirect}${redirect.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(r.query.get('state') ?? '')}`;
      return send(302, undefined, { location });
    }
    const form = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, string>;
    const grant = form.grant_type;
    const invalid = (message: string) => send(400, { error: 'invalid_grant', error_description: message });
    if (grant === 'authorization_code') {
      const saved = this.codes.get(form.code);
      if (!saved) return invalid('unknown code');
      this.codes.delete(form.code);
      if (saved.challenge && b64url(createHash('sha256').update(form.code_verifier ?? '').digest()) !== saved.challenge) return invalid('PKCE verifier does not match');
      return send(200, issue(saved.client, true));
    }
    if (grant === 'refresh_token') {
      const saved = this.refreshTokens.get(form.refresh_token);
      if (!saved) return invalid('refresh token revoked or unknown');
      return send(200, issue(saved.client, false));
    }
    if (grant === 'client_credentials') {
      const authorization = String(r.headers.authorization ?? '');
      const given = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString().split(':')[0] : form.client_id;
      if (!given) return send(401, { error: 'invalid_client' });
      return send(200, issue(given, false));
    }
    return send(400, { error: 'unsupported_grant_type' });
  }

  private edmx(service: ServiceDef): string {
    const sapNs = 'http://www.sap.com/Protocols/SAPData';
    const types = service.entities
      .map((def) => {
        const keys = def.props.filter((p) => p.key).map((p) => `<PropertyRef Name="${p.name}"/>`).join('');
        const props = def.props
          .map(
            (p) =>
              `<Property Name="${p.name}" Type="${p.type}" Nullable="${p.key ? 'false' : 'true'}"${p.type === 'Edm.String' ? ' MaxLength="40"' : ''} sap:label="${p.name}"${p.creatable === false ? ' sap:creatable="false"' : ''}${p.updatable === false ? ' sap:updatable="false"' : ''}${p.displayFormat ? ` sap:display-format="${p.displayFormat}"` : ''}/>`,
          )
          .join('');
        const nav = (def.nav ?? []).map((n) => `<NavigationProperty Name="${n.name}" Relationship="${service.id}.assoc_${n.name}" FromRole="From" ToRole="To"/>`).join('');
        return `<EntityType Name="${def.type}" sap:content-version="1"><Key>${keys}</Key>${props}${nav}</EntityType>`;
      })
      .join('');
    const sets = service.entities.map((def) => `<EntitySet Name="${def.set}" EntityType="${service.id}.${def.type}" sap:deletable="${def.deletable ? 'true' : 'false'}" sap:content-version="1"/>`).join('');
    if (service.version === 'v4') {
      return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="${service.id}" xmlns="http://docs.oasis-open.org/odata/ns/edm">${types.replace(/sap:[a-z-]+="[^"]*"/g, '')}<EntityContainer Name="Container">${sets.replace(/ sap:[a-z-]+="[^"]*"/g, '')}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="${sapNs}"><edmx:DataServices m:DataServiceVersion="2.0"><Schema Namespace="${service.id}" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">${types}<EntityContainer Name="${service.id}_Entities" m:IsDefaultEntityContainer="true">${sets}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
  }
}

// ---------------------------------------------------------------------------
// $filter subset: eq ne gt ge lt le, and, or, parentheses, startswith(prop,'x'), literals
// ---------------------------------------------------------------------------

type Tok = { t: 'id' | 'str' | 'num' | 'op' | 'lp' | 'rp' | 'comma' | 'dt'; v: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) i++;
    else if (c === '(') (out.push({ t: 'lp', v: c }), i++);
    else if (c === ')') (out.push({ t: 'rp', v: c }), i++);
    else if (c === ',') (out.push({ t: 'comma', v: c }), i++);
    else if (c === "'") {
      let j = i + 1;
      let value = '';
      for (; j < text.length; j++) {
        if (text[j] === "'" && text[j + 1] === "'") (value += "'", j++);
        else if (text[j] === "'") break;
        else value += text[j];
      }
      if (j >= text.length) throw new Error('unterminated string');
      out.push({ t: 'str', v: value });
      i = j + 1;
    } else if (/[0-9-]/.test(c)) {
      const m = /^-?\d+(\.\d+)?/.exec(text.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w/]*/.exec(text.slice(i))!;
      let word = m[0];
      i += word.length;
      if (/^(datetime|datetimeoffset|guid)$/i.test(word) && text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) throw new Error('unterminated literal');
        out.push({ t: 'dt', v: `${word.toLowerCase()}:${text.slice(i + 1, end)}` });
        i = end + 1;
        continue;
      }
      out.push({ t: /^(eq|ne|gt|ge|lt|le|and|or|not)$/.test(word) ? 'op' : 'id', v: word });
    } else throw new Error(`unexpected "${c}"`);
  }
  return out;
}

function compileFilter(text: string, def: EntityDef): (row: Row) => boolean {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  type Value = { prop?: Prop; literal?: unknown; fn?: (row: Row) => unknown };
  const operand = (): ((row: Row) => unknown) => {
    const tok = take();
    if (!tok) throw new Error('unexpected end');
    if (tok.t === 'str') return () => tok.v;
    if (tok.t === 'num') return () => Number(tok.v);
    if (tok.t === 'dt') {
      const [kind, value] = [tok.v.slice(0, tok.v.indexOf(':')), tok.v.slice(tok.v.indexOf(':') + 1)];
      if (kind === 'guid') return () => value;
      const ms = Date.parse(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
      if (Number.isNaN(ms)) throw new Error(`bad date ${value}`);
      return () => ms;
    }
    if (tok.t === 'id') {
      if (/^(true|false)$/.test(tok.v)) return () => tok.v === 'true';
      if (tok.v === 'startswith' || tok.v === 'substringof' || tok.v === 'endswith') {
        take(); // (
        const a = operand();
        take(); // ,
        const b = operand();
        take(); // )
        return (row) => (tok.v === 'startswith' ? String(a(row)).startsWith(String(b(row))) : tok.v === 'endswith' ? String(a(row)).endsWith(String(b(row))) : String(b(row)).includes(String(a(row))));
      }
      const prop = def.props.find((p) => p.name === tok.v);
      if (!prop) throw new Error(`unknown property ${tok.v}`);
      return (row) => row[prop.name];
    }
    if (tok.t === 'lp') {
      const inner = orExpr();
      if (take()?.t !== 'rp') throw new Error('missing )');
      return inner;
    }
    throw new Error(`unexpected ${tok.v}`);
  };
  const comparison = (): ((row: Row) => boolean) => {
    if (peek()?.t === 'op' && peek().v === 'not') {
      take();
      const inner = comparison();
      return (row) => !inner(row);
    }
    if (peek()?.t === 'lp') {
      const save = pos;
      take();
      try {
        const inner = orExpr();
        if (take()?.t === 'rp') return inner;
      } catch {
        /* a parenthesised operand: fall through */
      }
      pos = save;
    }
    const left = operand();
    const op = peek();
    if (!op || op.t !== 'op' || !/^(eq|ne|gt|ge|lt|le)$/.test(op.v)) return (row) => Boolean(left(row));
    take();
    const right = operand();
    return (row) => {
      const a = left(row) as any;
      const b = right(row) as any;
      switch (op.v) {
        case 'eq': return a === b || String(a) === String(b);
        case 'ne': return !(a === b || String(a) === String(b));
        case 'gt': return a > b;
        case 'ge': return a >= b;
        case 'lt': return a < b;
        default: return a <= b;
      }
    };
  };
  const andExpr = () => {
    let left = comparison();
    while (peek()?.t === 'op' && peek().v === 'and') {
      take();
      const l = left;
      const r = comparison();
      left = (row) => l(row) && r(row);
    }
    return left;
  };
  const orExpr = (): ((row: Row) => boolean) => {
    let left = andExpr();
    while (peek()?.t === 'op' && peek().v === 'or') {
      take();
      const l = left;
      const r = andExpr();
      left = (row) => l(row) || r(row);
    }
    return left;
  };
  const result = orExpr();
  if (pos < tokens.length) throw new Error(`unexpected ${tokens[pos].v}`);
  void ({} as Value);
  return result;
}

// ---------------------------------------------------------------------------
// Event delivery helper (spec 4.1): a CloudEvent POSTed to the trigger's webhook with the secret
// ---------------------------------------------------------------------------

export interface CloudEventInit {
  id?: string;
  source?: string;
  type?: string;
  data?: unknown;
  time?: string;
}

export const cloudEvent = (init: CloudEventInit = {}) => ({
  specversion: '1.0',
  id: init.id ?? randomBytes(6).toString('hex'),
  source: init.source ?? '/default/sap.s4.beh/FAKE',
  type: init.type ?? 'sap.s4.beh.businesspartner.v1.BusinessPartner.Changed.v1',
  time: init.time ?? new Date().toISOString(),
  datacontenttype: 'application/json',
  data: init.data ?? { BusinessPartner: '1000' },
});

/** The headers and body of a delivery in one of the three CloudEvents modes. */
export function deliveryOf(event: ReturnType<typeof cloudEvent> | Array<ReturnType<typeof cloudEvent>>, mode: 'structured' | 'binary' | 'batch', secret?: { header: string; value: string }) {
  const auth = secret ? { [secret.header]: secret.value } : {};
  if (mode === 'batch') return { headers: { 'content-type': 'application/cloudevents-batch+json', ...auth }, body: JSON.stringify(Array.isArray(event) ? event : [event]) };
  const single = Array.isArray(event) ? event[0] : event;
  if (mode === 'binary') {
    return {
      headers: { 'content-type': 'application/json', 'ce-specversion': single.specversion, 'ce-id': single.id, 'ce-source': single.source, 'ce-type': single.type, 'ce-time': single.time, ...auth },
      body: JSON.stringify(single.data),
    };
  }
  return { headers: { 'content-type': 'application/cloudevents+json', ...auth }, body: JSON.stringify(single) };
}

/** POSTs a delivery to a webhook URL (the host's `/api/webhook/app/<workflowId>/<nodeId>` or a test double). */
export async function deliverCloudEvent(url: string, event: ReturnType<typeof cloudEvent> | Array<ReturnType<typeof cloudEvent>>, options: { mode?: 'structured' | 'binary' | 'batch'; header?: string; secret?: string } = {}) {
  const { headers, body } = deliveryOf(event, options.mode ?? 'structured', options.secret ? { header: options.header ?? 'x-sap-event-secret', value: options.secret } : undefined);
  const response = await fetch(url, { method: 'POST', headers, body });
  return { status: response.status, body: await response.text() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = new FakeS4();
  await fake.start(Number(process.env.PORT ?? 3651));
  console.log(`fake S/4HANA listening on ${fake.url} (user ${fake.user}, password ${fake.password}, api key ${fake.apiKey})`);
}
