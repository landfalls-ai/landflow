/**
 * A local fake of ServiceNow's Table API and of a ticket-opening webhook, for the ticket channels' tests and live check
 * (no real ServiceNow, no cloud). It accepts `POST /api/now/table/<table>` and `PATCH /api/now/table/<table>/<sys_id>`
 * with Basic or Bearer auth, answers like the real thing (`{ result: { sys_id, number } }`), and lists what it holds at
 * `GET /records`. `POST /webhook` answers `{ ticket: { id, url } }`. `GET /nav_to.do` is the page a ticket link opens.
 * Used by import (`startFakeServiceNow`) or run alone: `node apps/web/test/fake-servicenow.ts [port]`.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRecord {
  sys_id: string;
  number: string;
  table: string;
  fields: Record<string, unknown>;
  patches: Record<string, unknown>[];
}

export interface FakeCall {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}

export interface FakeServiceNow {
  url: string;
  records: FakeRecord[];
  calls: FakeCall[];
  /** Make every Table API call answer 500 until switched off. */
  failing: boolean;
  /** Accepted credentials: Basic `user:password` and/or a Bearer token. */
  auth: { basic?: string; bearer?: string };
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeServiceNow(port = 0): Promise<FakeServiceNow> {
  const fake: FakeServiceNow = {
    url: '',
    records: [],
    calls: [],
    failing: false,
    auth: { basic: 'landflow:dev-password', bearer: 'dev-bearer-token' },
    reset() {
      fake.records.length = 0;
      fake.calls.length = 0;
      fake.failing = false;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const json = (() => {
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const path = req.url ?? '';
      const method = req.method ?? 'GET';
      const send = (status: number, value: unknown, type = 'application/json') => res.writeHead(status, { 'content-type': type }).end(typeof value === 'string' ? value : JSON.stringify(value));
      if (path === '/records') return send(200, { records: fake.records, calls: fake.calls });
      if (path.startsWith('/nav_to.do')) return send(200, '<html><body>Fake ServiceNow record</body></html>', 'text/html');
      fake.calls.push({ method, path, headers: req.headers, body, json });
      if (path === '/webhook') {
        if (fake.failing) return send(500, 'down');
        return send(200, { ticket: { id: `T-${fake.calls.filter((c) => c.path === '/webhook' && (c.json.event === 'approval.requested')).length}`, url: `${fake.url}/nav_to.do?ticket` } });
      }
      const table = /^\/api\/now\/table\/([a-z0-9_]+)(?:\/([0-9a-f]+))?$/.exec(path);
      if (!table) return send(404, { error: { message: 'No such path' } });
      const header = String(req.headers.authorization ?? '');
      const okBasic = fake.auth.basic && header === `Basic ${Buffer.from(fake.auth.basic).toString('base64')}`;
      const okBearer = fake.auth.bearer && header === `Bearer ${fake.auth.bearer}`;
      if (!okBasic && !okBearer) return send(401, { error: { message: 'User Not Authenticated' } });
      if (fake.failing) return send(500, { error: { message: 'Instance is down' } });
      if (method === 'POST' && !table[2]) {
        const number = `CHG${String(fake.records.length + 1).padStart(7, '0')}`;
        const record: FakeRecord = { sys_id: `a1b2c3d4e5f6${String(fake.records.length + 1).padStart(20, '0')}`, number, table: table[1]!, fields: json, patches: [] };
        fake.records.push(record);
        return send(201, { result: { sys_id: record.sys_id, number } });
      }
      const record = fake.records.find((r) => r.sys_id === table[2]);
      if (method === 'PATCH' && record) {
        record.patches.push(json);
        return send(200, { result: { sys_id: record.sys_id, number: record.number } });
      }
      return send(404, { error: { message: 'No Record found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

// Run alone for the live check.
if (process.argv[1]?.endsWith('fake-servicenow.ts')) {
  const fake = await startFakeServiceNow(Number(process.argv[2] ?? 3190));
  console.log(`Fake ServiceNow on ${fake.url} (basic landflow:dev-password, bearer dev-bearer-token); records at /records`);
}
