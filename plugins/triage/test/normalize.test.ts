import { describe, expect, it } from 'vitest';
import { NormalizeAlert } from '../src/nodes/normalize-alert';
import { alertmanager, clickland, cloudwatch, cloudwatchOk, datadog, generic, grafana, sentry, wazuh, webhook } from './fixtures';
import { jsonOf, run } from './helpers';

const normalize = async (items: object[], params: Record<string, unknown> = {}, options = {}) => {
  const response = await run(NormalizeAlert, params as any, items as any, options);
  return { response, alerts: jsonOf(response).map((j) => j.alert) };
};

describe('Normalize Alert', () => {
  it('Alertmanager: one item per alert, firing and resolved, junk links dropped', async () => {
    const { alerts } = await normalize([alertmanager]);
    expect(alerts).toHaveLength(2);
    const [a, b] = alerts;
    expect(a).toMatchObject({
      source: 'alertmanager',
      id: '3a1f6c2b9d8e7f40',
      fingerprint: '3a1f6c2b9d8e7f40',
      status: 'firing',
      title: 'Checkout 5xx rate above 5%',
      description: '5xx ratio is 12% for 10m',
      severity: 'sev1',
      severityRaw: 'critical',
      service: 'checkout',
      environment: 'production',
      startsAt: '2026-10-28T09:15:00.000Z',
      endsAt: null,
      groupKey: '{}:{alertname="HighErrorRate"}',
      dedupKey: 'alertmanager:3a1f6c2b9d8e7f40',
      entity: { kind: 'pod', id: 'checkout-7d9f8-abcde' },
    });
    expect(a.labels.alertname).toBe('HighErrorRate');
    expect(a.links).toEqual([
      { kind: 'runbook', url: 'https://runbooks.example.com/checkout-5xx' },
      { kind: 'alert', url: expect.stringContaining('https://prometheus.example.com/graph') },
    ]);
    expect(a.raw.alerts).toHaveLength(1);
    expect(a.raw.alerts[0].fingerprint).toBe('3a1f6c2b9d8e7f40');
    expect(b).toMatchObject({ status: 'resolved', severity: 'sev3', service: 'node', endsAt: '2026-10-28T09:20:00.000Z', entity: { kind: 'host', id: 'db-1.example.com:9100' } });
  });

  it('Grafana: dashboard, panel and silence links; severity high is sev2', async () => {
    const { alerts } = await normalize([grafana]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'grafana', severity: 'sev2', service: 'payments-api', environment: 'prod', title: 'p95 latency above 800ms', dedupKey: 'grafana:f00dfeedcafe1234' });
    expect(alerts[0].links.map((l: any) => l.kind)).toEqual(['runbook', 'dashboard', 'dashboard', 'alert', 'other']);
  });

  it('Datadog: tags become labels, priority P2 is sev2, link kept', async () => {
    const { alerts } = await normalize([datadog]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: 'datadog',
      id: '7234567890123456789',
      status: 'firing',
      title: 'CPU is high on web-3',
      severity: 'sev2',
      severityRaw: 'P2',
      service: 'web',
      environment: 'prod',
      entity: { kind: 'host', id: 'web-3' },
      tags: ['env:prod', 'service:web', 'team:platform', 'host:web-3'],
    });
    expect(alerts[0].labels.team).toBe('platform');
    expect(alerts[0].dedupKey).toMatch(/^datadog:987654:[0-9a-f]{12}$/);
    expect(alerts[0].startsAt).toBe(new Date(1761645600000).toISOString());
    expect(alerts[0].links[0]).toEqual({ kind: 'alert', url: 'https://app.datadoghq.com/monitors/987654' });
    const recovered = await normalize([{ ...datadog, alert_transition: 'Recovered' }]);
    expect(recovered.alerts[0].status).toBe('resolved');
  });

  it('CloudWatch via SNS: Message JSON string, dimensions, sev tag in the description, OK resolves', async () => {
    const { alerts } = await normalize([cloudwatch]);
    expect(alerts[0]).toMatchObject({
      source: 'cloudwatch',
      status: 'firing',
      title: 'orders-lambda-errors',
      severity: 'sev2',
      service: 'orders',
      entity: { kind: 'lambda', id: 'orders' },
      dedupKey: 'cloudwatch:arn:aws:cloudwatch:us-east-1:000000000000:alarm:orders-lambda-errors',
      startsAt: '2026-10-28T11:30:00.000Z',
    });
    expect(alerts[0].labels).toMatchObject({ FunctionName: 'orders', Namespace: 'AWS/Lambda', Region: 'us-east-1' });
    expect(alerts[0].links[0].url).toContain('region=us-east-1#alarmsV2:alarm/orders-lambda-errors');
    const ok = await normalize([cloudwatchOk]);
    expect(ok.alerts[0]).toMatchObject({ status: 'resolved', severity: 'sev4' });
    const insufficient = await normalize([{ ...cloudwatch, Message: JSON.stringify({ ...JSON.parse(cloudwatch.Message), AlarmDescription: '', NewStateValue: 'INSUFFICIENT_DATA' }) }]);
    expect(insufficient.alerts[0]).toMatchObject({ status: 'firing', severity: 'sev3' });
  });

  it('Sentry: issue alert with level error, tags and project', async () => {
    const { alerts } = await normalize([sentry]);
    expect(alerts[0]).toMatchObject({
      source: 'sentry',
      id: 'e1f2a3b4c5d64e7f8a9b0c1d2e3f4a5b',
      fingerprint: '4501234567',
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      severity: 'sev2',
      severityRaw: 'error',
      service: 'storefront',
      environment: 'production',
      status: 'firing',
      dedupKey: 'sentry:4501234567',
    });
    expect(alerts[0].tags).toContain('browser:Chrome 129');
    expect(alerts[0].links[0].kind).toBe('alert');
    const fatal = await normalize([{ ...sentry, data: { event: { ...sentry.data.event, level: 'fatal' } } }]);
    expect(fatal.alerts[0].severity).toBe('sev1');
  });

  it('Wazuh: level bands, host entity, groups as tags', async () => {
    const { alerts } = await normalize([wazuh]);
    expect(alerts[0]).toMatchObject({
      source: 'wazuh',
      id: '1761656412.4521',
      title: 'sshd: brute force trying to get access to the system.',
      severity: 'sev2',
      severityRaw: '12',
      entity: { kind: 'host', id: 'bastion-1' },
      startsAt: '2026-10-28T13:00:12.345Z',
      tags: ['syslog', 'sshd', 'authentication_failures'],
      dedupKey: 'wazuh:5763:bastion-1',
    });
    expect(alerts[0].labels).toMatchObject({ srcip: '198.51.100.23', agent_ip: '10.0.4.12' });
    const bands = await Promise.all([3, 7, 10, 13, 15].map((level) => normalize([{ ...wazuh, rule: { ...wazuh.rule, level } }])));
    expect(bands.map((b) => b.alerts[0].severity)).toEqual(['sev4', 'sev3', 'sev2', 'sev1', 'sev1']);
  });

  it('Clickland: a delivery, the Alert Trigger item and the poll trigger item give the same alert', async () => {
    const delivered = (await normalize([clickland])).alerts[0];
    expect(delivered).toMatchObject({
      source: 'clickland',
      id: 'evt_01JDCLICK',
      fingerprint: 'al_api_errors:',
      dedupKey: 'clickland:al_api_errors:',
      status: 'firing',
      title: 'API errors',
      description: 'logs `service:api level:error` (42 above 10 in 5 min)',
      service: 'api',
      entity: { kind: 'service', id: 'api' },
      startsAt: '2026-11-14T14:58:00.000Z',
      endsAt: null,
      labels: { alert_id: 'al_api_errors', signal: 'logs', value: '42', threshold: '10', service: 'api' },
      links: [
        { kind: 'alert', url: 'http://127.0.0.1:4711/alerts/al_api_errors' },
        { kind: 'dashboard', url: clickland.data.searchUrl },
      ],
      tags: ['signal:logs', 'service:api'],
    });
    // The Clickland Alert Trigger's item: the delivery's data with type, id and timestamp.
    const triggerItem = { ...clickland.data, type: clickland.type, id: clickland.id, timestamp: clickland.timestamp };
    expect((await normalize([triggerItem])).alerts[0]).toMatchObject({ source: 'clickland', id: 'evt_01JDCLICK', fingerprint: 'al_api_errors:', service: 'api' });
    // Behind the host's plain Webhook node.
    expect((await normalize([webhook(clickland)])).alerts[0].source).toBe('clickland');
    // The Clickland Trigger's item, grouped by service and resolved.
    const polled = {
      event: 'alert.event',
      alert: { id: 'al_latency', name: 'Slow checkout', signal: 'traces', query: 'duration_ms:>500', groupBy: 'service', thresholdType: 'above', threshold: 20 },
      alertEvent: { id: 'ae_9', groupKey: 'checkout', state: 'ok', value: 3, createdAt: '2026-11-14T16:00:00.000Z' },
    };
    expect((await normalize([polled], { format: 'clickland' })).alerts[0]).toMatchObject({
      id: 'ae_9',
      status: 'resolved',
      title: 'Slow checkout (checkout)',
      service: 'checkout',
      groupKey: 'checkout',
      fingerprint: 'al_latency:checkout',
      endsAt: '2026-11-14T16:00:00.000Z',
      severity: 'sev3',
    });
  });

  it('Generic: maps title, severity, service and id by dot path; hashes a dedup key without a fingerprint', async () => {
    const params = { format: 'generic', titlePath: 'name', severityPath: 'level', servicePath: 'owner.svc', idPath: 'ref', genericSource: 'queues' };
    const { alerts } = await normalize([generic], params);
    expect(alerts[0]).toMatchObject({ source: 'queues', title: 'Queue depth', severity: 'sev1', severityRaw: 'P1', service: 'billing', id: 'q-77', fingerprint: null });
    expect(alerts[0].dedupKey).toMatch(/^queues:[0-9a-f]{16}$/);
    const again = await normalize([{ ...generic, ref: 'other' }], params);
    expect(again.alerts[0].dedupKey).toBe(alerts[0].dedupKey);
  });

  it('accepts the host Webhook item shape, with the body an object or a JSON string', async () => {
    const asObject = await normalize([webhook(grafana)]);
    expect(asObject.alerts[0].source).toBe('grafana');
    const asString = await normalize([webhook(JSON.stringify(wazuh))]);
    expect(asString.alerts[0].source).toBe('wazuh');
    const forced = await normalize([webhook(alertmanager)], { format: 'alertmanager' });
    expect(forced.alerts).toHaveLength(2);
    const raw = await normalize([datadog]);
    expect(raw.alerts[0].source).toBe('datadog');
  });

  it('severity map overrides the built-in mapping, default severity covers the unknown', async () => {
    const custom = { ...alertmanager, alerts: [{ ...alertmanager.alerts[0], labels: { alertname: 'X', severity: 'page-me' } }, { ...alertmanager.alerts[1], labels: { alertname: 'Y', severity: 'critical' } }, { ...alertmanager.alerts[1], labels: { alertname: 'Z' } }] };
    const { alerts } = await normalize([custom], { severityMap: '{"page-me":"sev1","CRITICAL":"sev3"}', defaultSeverity: 'sev2' });
    expect(alerts.map((a) => a.severity)).toEqual(['sev1', 'sev3', 'sev2']);
  });

  it('can drop the raw payload', async () => {
    const { alerts } = await normalize([wazuh], { includeRaw: false });
    expect('raw' in alerts[0]).toBe(false);
  });

  it('caps links at 10 and keeps http(s) only', async () => {
    const many = { ...alertmanager, alerts: [{ ...alertmanager.alerts[0], annotations: { runbook_url: 'ftp://x/y', dashboard_url: 'https://ok.example.com/d' }, generatorURL: 'https://g.example.com' }] };
    const { alerts } = await normalize([many]);
    expect(alerts[0].links).toEqual([{ kind: 'dashboard', url: 'https://ok.example.com/d' }, { kind: 'alert', url: 'https://g.example.com' }]);
  });

  it('auto reads an unknown payload as Generic with the default paths, so it is never dropped', async () => {
    const plain = { title: 'Checkout 5xx above 4%', severity: 'warning', service: 'checkout', environment: 'production', description: '5xx at 4.2%' };
    const { alerts, response } = await normalize([plain, { headers: { 'content-type': 'application/json' }, body: plain }, { hello: 'world' }]);
    expect(response.error).toBeUndefined();
    expect(alerts[0]).toMatchObject({ source: 'generic', title: 'Checkout 5xx above 4%', service: 'checkout', environment: 'production', status: 'firing' });
    expect(alerts[1]).toMatchObject({ source: 'generic', title: 'Checkout 5xx above 4%', dedupKey: alerts[0].dedupKey });
    expect(alerts[2]).toMatchObject({ source: 'generic', title: 'Alert' });
  });

  it('continueOnFail turns a bad item into an error item', async () => {
    const { response } = await normalize([{ alerts: [] }, alertmanager], { format: 'alertmanager' }, { continueOnFail: true });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0].error).toMatch(/holds no alertmanager alerts/);
    expect(jsonOf(response)[1].alert.source).toBe('alertmanager');
    expect(response.outputs[0][0].pairedItem).toEqual({ item: 0 });
  });
});
