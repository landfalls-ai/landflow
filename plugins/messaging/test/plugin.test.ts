/** The plugin end to end: manifest over HTTP and gRPC, traces carrying the host's trace id, redaction and the messaging metrics. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type ExecuteRequest, type JsonObject, type PluginManifest } from '@landflow/protocol';
import {
  executeRequestToMsg,
  executeResponseFromMsg,
  grpc,
  loadLandflowProto,
  manifestFromMsg,
  unary,
  type ExecuteResponseMsg,
  type ManifestMsg,
} from '@landflow/protocol/grpc';
import { setTelemetry } from '@landflow/sdk';
import { serveGrpc } from '@landflow/sdk/grpc';
import { createFetchHandler } from '@landflow/sdk/http';
import { createTelemetry } from '@landflow/sdk/telemetry';
import { plugin } from '../src/main';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp';
import { executeRequest, startFakeApi, type FakeApi } from './helpers';

const TOKEN = '123456:test-token-abc';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const GRPC_PORT = 47904;

let api: FakeApi;
let updates: JsonObject[] = [];

beforeAll(async () => {
  api = await startFakeApi((req) => {
    if (!req.path.startsWith(`/bot${TOKEN}/`)) return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
    if (req.path.endsWith('/getUpdates')) return { body: { ok: true, result: updates.filter((u) => Number(u.update_id) >= Number(req.body.offset ?? 0)) } };
    if (req.body?.chat_id === 'missing') return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
    return { body: { ok: true, result: { message_id: 1, chat: { id: 42 }, text: req.body?.text } } };
  });
});
afterAll(() => api.close());

const telegram = () => ({ telegramApi: { accessToken: TOKEN, baseUrl: api.url } });

describe('manifest', () => {
  const handle = createFetchHandler(plugin);

  function check(manifest: PluginManifest) {
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.plugin).toMatchObject({ id: 'messaging', name: 'Messaging', color: '#229ED9', language: 'typescript' });
    expect(manifest.nodes.map((n) => n.name)).toEqual(['telegram', 'telegramTrigger', 'slack', 'slackTrigger', 'slackActivityTrigger', 'discord', 'whatsApp', 'twilio', 'emailSend']);
    for (const icon of [manifest.plugin.icon, ...manifest.nodes.map((n) => n.icon), ...(manifest.credentialTypes ?? []).map((c) => c.icon)]) {
      expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
    }
    expect(JSON.stringify(manifest)).not.toContain('file:');
    expect(manifest.credentialTypes?.map((c) => [c.name, c.testable])).toEqual([
      ['telegramApi', true],
      ['slackApi', true],
      ['slackOAuth2Api', true],
      ['discordBotApi', true],
      ['discordOAuth2Api', true],
      ['discordWebhookApi', true],
      ['whatsAppApi', true],
      ['twilioApi', true],
      ['smtp', true],
    ]);
    for (const node of manifest.nodes) {
      expect(node.categories).toEqual(['Communication']);
      expect(node.documentationUrl).toMatch(/^https:\/\//);
      expect(node.color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(node.usableAsTool ?? false).toBe(node.kind === 'action');
      // Every action node is at most once over a broker unless an operation opts in (docs/transports.md delivery rules).
      if (node.kind === 'action') expect(node.idempotent).toBe(false);
    }
    const idempotentOperations = manifest.nodes.flatMap((n) =>
      n.properties.filter((p) => p.name === 'operation').flatMap((p) => (p.options ?? []).filter((o) => o.idempotent === true).map((o) => `${n.name}.${o.value}`)),
    );
    expect(idempotentOperations).toEqual([
      'telegram.get',
      'telegram.get',
      'slack.getAll',
      'slack.getByEmail',
      'slack.getAll',
      'slack.get',
      'slack.get',
      'slack.getManySince',
      'slack.getPermalink',
      'discord.getAll',
      'whatsApp.get',
      'twilio.download',
      'twilio.list',
      'twilio.get',
      'twilio.list',
      'twilio.get',
      'twilio.getMedia',
      'twilio.list',
    ]);
    // Every secret field is masked.
    for (const type of manifest.credentialTypes ?? []) {
      for (const property of type.properties) {
        if (property.type !== 'hidden' && /token|password|webhookUrl/i.test(property.name)) expect(property.typeOptions?.password).toBe(true);
      }
    }
    expect(manifest.nodes.find((n) => n.name === 'discord')?.credentials).toEqual([
      { name: 'discordBotApi', required: true, displayOptions: { show: { authentication: ['botToken'] } } },
      { name: 'discordOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
      { name: 'discordWebhookApi', required: true, displayOptions: { show: { authentication: ['webhook'] } } },
    ]);
    expect(manifest.nodes.find((n) => n.name === 'telegramTrigger')).toMatchObject({ kind: 'trigger', triggerSource: 'poll' });
    expect(manifest.nodes.find((n) => n.name === 'slackTrigger')).toMatchObject({ kind: 'trigger', triggerSource: 'appWebhook' });
  }

  it('is valid over HTTP, icons inlined', async () => {
    check((await (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json()) as PluginManifest);
  });

  it('is valid over gRPC, and Execute works there too', async () => {
    const server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
    const client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
    try {
      check(manifestSchema.parse(manifestFromMsg(await unary<object, ManifestMsg>(client, 'GetManifest', {}, 3000))) as PluginManifest);
      const request = executeRequest(
        'telegram',
        { resource: 'message', operation: 'sendMessage', chatId: '42', text: 'via grpc' },
        { credentials: telegram() },
      );
      const response = executeResponseFromMsg(await unary<object, ExecuteResponseMsg>(client, 'Execute', executeRequestToMsg(request), 3000));
      expect(response.outputs[0][0].json).toMatchObject({ message_id: 1, text: 'via grpc' });
    } finally {
      client.close();
      server.forceShutdown();
    }
  });
});

describe('telemetry', () => {
  let smtp: FakeSmtp;
  beforeAll(async () => {
    smtp = await startFakeSmtp({ auth: { user: 'mailer', password: 'test-password-123' } });
  });
  afterAll(() => smtp.close());

  it('continues the host trace, redacts the token, opens an smtp.send client span and records the messaging metrics', async () => {
    const lines: string[] = [];
    const telemetry = await createTelemetry({ pluginId: 'messaging', env: {}, logWriter: (line) => lines.push(line) });
    setTelemetry(telemetry); // the smtp.send client span uses the process tracer, as under serve()
    const handle = createFetchHandler(plugin, { telemetry });
    const execute = (request: ExecuteRequest) =>
      handle(
        new Request(`http://plugin${HTTP_PATHS.execute}`, {
          method: 'POST',
          headers: { traceparent: `00-${TRACE_ID}-${PARENT}-01` },
          body: JSON.stringify(request),
        }),
      ).then((r) => r.json());

    try {
      await execute(executeRequest('telegram', { resource: 'message', operation: 'sendMessage', chatId: '42', text: 'traced' }, { credentials: telegram() }));
      await execute(executeRequest('telegram', { resource: 'message', operation: 'sendMessage', chatId: 'missing', text: 'x' }, { credentials: telegram() }));
      updates = [
        { update_id: 5, message: { text: 'a', chat: { id: 1 } } },
        { update_id: 6, message: { text: 'b', chat: { id: 1 } } },
      ];
      const polled = await execute(
        executeRequest('telegramTrigger', { updates: ['message'] }, { credentials: telegram(), mode: 'poll', items: [], pollState: { offset: 5 } }),
      );
      expect(polled.outputs[0]).toHaveLength(2);
      expect(polled.pollState).toEqual({ offset: 7 });
      const emailed = await execute(
        executeRequest(
          'emailSend',
          { fromEmail: 'bot@example.com', toEmail: 'ann@example.com', subject: 'x', emailFormat: 'text', text: 'x' },
          { credentials: { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'mailer', password: 'test-password-123' } } },
        ),
      );
      expect(emailed.error).toBeUndefined();

      const records = lines.map((line) => JSON.parse(line));
      const spans = records.filter((r) => r.msg === 'span.end');
      const servers = spans.filter((s) => s.span === 'plugin.execute messaging.telegram');
      expect(servers[0]).toMatchObject({ trace_id: TRACE_ID, parent_span_id: PARENT, kind: 'server' });
      const http = spans.find((s) => s.span === 'HTTP POST' && s.parent_span_id === servers[0].span_id);
      expect(http).toMatchObject({
        kind: 'client',
        trace_id: TRACE_ID,
        attributes: { 'url.full': `${api.url}/bot[REDACTED]/sendMessage`, 'http.response.status_code': 200 },
      });

      const emailServer = spans.find((s) => s.span === 'plugin.execute messaging.emailSend');
      const send = spans.find((s) => s.span === 'smtp.send');
      expect(send).toMatchObject({
        kind: 'client',
        trace_id: TRACE_ID,
        parent_span_id: emailServer.span_id,
        attributes: {
          'server.address': '127.0.0.1',
          'server.port': smtp.port,
          'messaging.system': 'smtp',
          'smtp.recipients.accepted': 1,
          'smtp.recipients.rejected': 0,
        },
      });
      const phases = spans.filter((s) => s.parent_span_id === send.span_id).map((s) => s.span);
      expect(phases).toEqual(['smtp.connect', 'smtp.ehlo', 'smtp.auth', 'smtp.envelope', 'smtp.data', 'smtp.quit']);

      // No secret anywhere in the process log.
      expect(lines.join('\n')).not.toContain('test-token-abc');
      expect(lines.join('\n')).not.toContain('test-password-123');

      const metrics = await (await handle(new Request('http://plugin/metrics'))).text();
      expect(metrics).toMatch(/landflow_messaging_messages_sent_total\{[^}]*operation="sendMessage"[^}]*service="telegram"[^}]*\} 1/);
      expect(metrics).toMatch(/landflow_messaging_messages_sent_total\{[^}]*operation="send"[^}]*service="email"[^}]*\} 1/);
      expect(metrics).toMatch(/landflow_messaging_api_errors_total\{[^}]*service="telegram"[^}]*status_class="4xx"[^}]*\} 1/);
      expect(metrics).toMatch(/landflow_messaging_poll_updates_total\{[^}]*service="telegram"[^}]*\} 2/);
    } finally {
      setTelemetry(undefined);
      await telemetry.shutdown();
    }
  });
});
