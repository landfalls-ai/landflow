import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcknowledgeAlert } from '../src/nodes/acknowledge-alert';
import { GetAlertDetails } from '../src/nodes/get-alert-details';

// AG10: a fake Alertmanager (Grafana's /api/alertmanager/grafana, v2) on a loopback port. Acknowledge Alert posts to
// /api/v2/silences (plural); Get Alert Details reads the alert by name through the list's filter.
const seen: Array<{ method: string; path: string; auth?: string; body?: any }> = [];
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: req.headers.authorization, ...(raw && { body: JSON.parse(raw) }) });
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url.pathname === '/api/alertmanager/grafana/api/v2/silences') {
        return req.headers.authorization === 'Bearer viewer' ? reply(403, { message: 'forbidden' }) : reply(200, { silenceID: 'sil-1' });
      }
      if (req.method === 'GET' && url.pathname === '/api/alertmanager/grafana/api/v2/alerts') {
        const filter = url.searchParams.get('filter') ?? '';
        return reply(200, filter === 'alertname="High CPU on web-01"' ? [{ labels: { alertname: 'High CPU on web-01', severity: 'warning' }, annotations: { summary: 'CPU is high' }, startsAt: '2026-11-17T10:00:00Z', fingerprint: 'f1', status: { state: 'active' } }] : []);
      }
      reply(404, { message: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/alertmanager/grafana`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ctx = (alertId: string, token: string, url = base): any => ({
  getInputData: () => [{ json: {} }],
  getNodeParameter: () => alertId,
  getCredentials: () => ({ url, token }),
  http: (target: string, init: RequestInit) => fetch(target, init),
});

describe('Acknowledge Alert', () => {
  it('posts to /api/v2/silences with the matcher and answers the silence id', async () => {
    seen.length = 0;
    const [item] = await new AcknowledgeAlert().execute(ctx('High CPU on web-01', 'editor'));
    expect(item.json).toMatchObject({ silenceId: 'sil-1', alertId: 'High CPU on web-01', acknowledged: true });
    expect(typeof item.json.endsAt).toBe('string');
    expect(seen[0].path).toBe('/api/alertmanager/grafana/api/v2/silences');
    expect(seen[0].body.matchers).toEqual([{ name: 'alertname', value: 'High CPU on web-01', isRegex: false, isEqual: true }]);
  });

  it('a 403 says the token needs the Editor role', async () => {
    await expect(new AcknowledgeAlert().execute(ctx('High CPU on web-01', 'viewer'))).rejects.toThrow(/needs the Editor role \(a Viewer token reads alerts only\)/);
  });

  it('a 404 says the URL must end in /api/alertmanager/grafana', async () => {
    await expect(new AcknowledgeAlert().execute(ctx('x', 'editor', base.replace('/api/alertmanager/grafana', '')))).rejects.toThrow(/must end in \/api\/alertmanager\/grafana/);
  });
});

describe('Get Alert Details', () => {
  it('finds High CPU on web-01 by name through the filter', async () => {
    seen.length = 0;
    const [item] = await new GetAlertDetails().execute(ctx('High CPU on web-01', 'viewer'));
    expect(seen[0].path).toBe('/api/alertmanager/grafana/api/v2/alerts?filter=alertname%3D%22High%20CPU%20on%20web-01%22');
    expect(item.json.alertDetails).toMatchObject({ labels: { severity: 'warning' }, annotations: { summary: 'CPU is high' }, state: 'active', startsAt: '2026-11-17T10:00:00Z' });
  });

  it('says No firing alert named … for another', async () => {
    await expect(new GetAlertDetails().execute(ctx('Disk full', 'viewer'))).rejects.toThrow('No firing alert named Disk full');
  });
});
