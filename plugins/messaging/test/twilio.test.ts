/** The Twilio node and the twilioApi credential against the fake Twilio server (test/fake-twilio.ts): every operation, errors, 429, paging, exactly-once sends, MCP tools. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mcpToolsFromManifest } from '@landflow/protocol';
import type { JsonObject } from '@landflow/sdk';
import { createDispatcher } from '@landflow/sdk/dispatcher';
import { createMcpFace } from '@landflow/sdk/mcp';
import { plugin } from '../src/main';
import { formBody, mediaUrls, senderFields, Twilio, withChannel } from '../src/nodes/twilio';
import { startFakeTwilio, type FakeTwilio } from './fake-twilio';
import { jsonOf, run, testCredentials, type RequestOptions } from './helpers';

let twilio: FakeTwilio;
const FROM = '+15005550006';
const TO = '+15551234567';

const credentials = (extra: JsonObject = {}): Record<string, JsonObject> => ({
  twilioApi: { authType: 'authToken', accountSid: twilio.accountSid, authToken: twilio.authToken, baseUrl: twilio.url, ...extra },
});
const apiKeyCredentials = (): Record<string, JsonObject> => ({
  twilioApi: { authType: 'apiKey', accountSid: twilio.accountSid, apiKeySid: twilio.apiKey.sid, apiKeySecret: twilio.apiKey.secret, baseUrl: twilio.url },
});
const message = (parameters: JsonObject, options: RequestOptions = {}) => run(Twilio, { resource: 'message', ...parameters }, { credentials: credentials(), ...options });
const call = (parameters: JsonObject, options: RequestOptions = {}) => run(Twilio, { resource: 'call', ...parameters }, { credentials: credentials(), ...options });
const posts = () => twilio.requests.filter((r) => r.method === 'POST');
const lastForm = () => twilio.requests.at(-1)!.form;

beforeAll(async () => {
  twilio = await startFakeTwilio();
});
afterAll(() => twilio.close());
beforeEach(() => twilio.reset());

describe('helpers', () => {
  it('form-encodes bodies, repeating MediaUrl and skipping empty values', () => {
    expect(formBody({ To: '+1 555', Body: 'hi & bye', MediaUrl: ['https://a/1.png', 'https://a/2.png'], StatusCallback: undefined, Empty: '' })).toBe(
      'To=%2B1+555&Body=hi+%26+bye&MediaUrl=https%3A%2F%2Fa%2F1.png&MediaUrl=https%3A%2F%2Fa%2F2.png',
    );
  });

  it('maps a Messaging Service SID to MessagingServiceSid and adds the WhatsApp prefix only where it is missing', () => {
    expect(senderFields('MG0123456789abcdef0123456789abcdef')).toEqual({ MessagingServiceSid: 'MG0123456789abcdef0123456789abcdef' });
    expect(senderFields(' +15005550006 ', 'whatsapp:')).toEqual({ From: 'whatsapp:+15005550006' });
    expect(withChannel('whatsapp:+1', 'whatsapp:')).toBe('whatsapp:+1');
    expect(withChannel('+1', '')).toBe('+1');
  });

  it('reads media URLs from the fixedCollection, an array or a line/comma list', () => {
    expect(mediaUrls({ urls: [{ url: 'https://a/1' }, { url: ' https://a/2 ' }, { url: '' }] })).toEqual(['https://a/1', 'https://a/2']);
    expect(mediaUrls(['https://a/1', { url: 'https://a/2' }])).toEqual(['https://a/1', 'https://a/2']);
    expect(mediaUrls('https://a/1,https://a/2\nhttps://a/3')).toEqual(['https://a/1', 'https://a/2', 'https://a/3']);
    expect(mediaUrls({})).toEqual([]);
  });
});

describe('twilioApi credential', () => {
  it('fetches the account with the Auth Token', async () => {
    const result = await testCredentials('twilioApi', credentials().twilioApi);
    expect(result).toEqual({ ok: true, message: 'Account "Fake Twilio account" (Full, active)' });
    expect(twilio.requests).toHaveLength(1);
    expect(twilio.requests[0]).toMatchObject({ method: 'GET', path: `/2010-04-01/Accounts/${twilio.accountSid}.json`, authorized: true });
  });

  it('fetches the account with an API key', async () => {
    expect((await testCredentials('twilioApi', apiKeyCredentials().twilioApi)).ok).toBe(true);
    expect(twilio.requests[0].authorized).toBe(true);
    const [user] = Buffer.from(String(twilio.requests[0].headers.authorization).slice(6), 'base64').toString('utf8').split(':');
    expect(user).toBe(twilio.apiKey.sid);
  });

  it('reports a wrong token, a missing field and a wrong base URL', async () => {
    expect(await testCredentials('twilioApi', { ...credentials().twilioApi, authToken: 'wrong-token-0000' })).toEqual({
      ok: false,
      message: 'Twilio API error 401 (code 20003): Authentication Error - invalid username',
    });
    expect(await testCredentials('twilioApi', { ...credentials().twilioApi, authToken: '' })).toEqual({ ok: false, message: 'The Twilio credential needs an Account SID and Auth Token' });
    expect(await testCredentials('twilioApi', { ...apiKeyCredentials().twilioApi, apiKeySecret: '' })).toEqual({ ok: false, message: 'The Twilio credential needs an API key SID and secret' });
    expect(await testCredentials('twilioApi', { ...credentials().twilioApi, accountSid: '' })).toEqual({ ok: false, message: 'The Twilio credential has no Account SID' });
    const unreachable = await testCredentials('twilioApi', { ...credentials().twilioApi, baseUrl: 'http://127.0.0.1:1' });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.message).toMatch(/^Twilio API request failed: /);
  });
});

describe('Message', () => {
  it('sends an SMS exactly once, form-encoded with Basic auth, and returns the message', async () => {
    const response = await message({ operation: 'send', from: FROM, to: TO, body: 'Hello from Landflow' });
    expect(response.error).toBeUndefined();
    expect(posts()).toHaveLength(1);
    const [request] = posts();
    expect(request.path).toBe(`/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`);
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.headers.authorization).toMatch(/^Basic /);
    expect(request.form).toEqual({ To: [TO], From: [FROM], Body: ['Hello from Landflow'] });
    const [item] = jsonOf(response);
    expect(item).toMatchObject({ sid: expect.stringMatching(/^SM[0-9a-f]{32}$/), to: TO, from: FROM, body: 'Hello from Landflow', status: 'queued', num_media: '0', direction: 'outbound-api' });
    expect(String(item.date_created)).toMatch(/\+0000$/);
    expect(JSON.stringify(response)).not.toContain(twilio.authToken);
  });

  it('sends one SMS per input item, each exactly once', async () => {
    const response = await message({ operation: 'send', from: FROM, to: TO, body: 'x' }, { items: [{ n: 1 }, { n: 2 }, { n: 3 }], perItem: [{ body: 'one' }, { body: 'two' }, { body: 'three' }] });
    expect(response.error).toBeUndefined();
    expect(posts().map((r) => r.form.Body[0])).toEqual(['one', 'two', 'three']);
    expect(response.outputs[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('sends from a Messaging Service and passes the additional fields', async () => {
    const service = 'MG0123456789abcdef0123456789abcdef';
    await message({
      operation: 'send',
      from: service,
      to: TO,
      body: 'hi',
      additionalFields: { statusCallback: 'https://example.com/status', validityPeriod: 600, sendAt: '2026-11-01T09:00:00Z' },
    });
    expect(lastForm()).toEqual({ To: [TO], MessagingServiceSid: [service], Body: ['hi'], StatusCallback: ['https://example.com/status'], ValidityPeriod: ['600'], SendAt: ['2026-11-01T09:00:00Z'], ScheduleType: ['fixed'] });
    expect(jsonOf(await message({ operation: 'get', messageSid: twilio.messages[0].sid as string }))[0]).toMatchObject({ messaging_service_sid: service, from: null, status: 'scheduled' });
  });

  it('sends an MMS with repeated MediaUrl values', async () => {
    const response = await message({
      operation: 'sendMms',
      from: FROM,
      to: TO,
      body: 'see attached',
      mediaUrls: { urls: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.pdf' }] },
    });
    expect(response.error).toBeUndefined();
    expect(lastForm()).toEqual({ To: [TO], From: [FROM], Body: ['see attached'], MediaUrl: ['https://example.com/a.png', 'https://example.com/b.pdf'] });
    expect(jsonOf(response)[0]).toMatchObject({ sid: expect.stringMatching(/^MM/), num_media: '2' });
    expect((await message({ operation: 'sendMms', from: FROM, to: TO, body: 'no media' })).error?.message).toBe('At least one Media URL is required for an MMS');
    const tooMany = { urls: Array.from({ length: 11 }, (_, i) => ({ url: `https://example.com/${i}.png` })) };
    expect((await message({ operation: 'sendMms', from: FROM, to: TO, mediaUrls: tooMany })).error?.message).toBe('At most 10 Media URLs can be attached');
  });

  it('sends WhatsApp with the whatsapp: prefix added to both sides, and content templates', async () => {
    const response = await message({ operation: 'sendWhatsApp', from: FROM, to: TO, body: 'hola' });
    expect(response.error).toBeUndefined();
    expect(lastForm()).toEqual({ To: [`whatsapp:${TO}`], From: [`whatsapp:${FROM}`], Body: ['hola'] });
    await message({ operation: 'sendWhatsApp', from: `whatsapp:${FROM}`, to: `whatsapp:${TO}`, mediaUrls: { urls: [{ url: 'https://example.com/a.png' }] } });
    expect(lastForm()).toEqual({ To: [`whatsapp:${TO}`], From: [`whatsapp:${FROM}`], MediaUrl: ['https://example.com/a.png'] });
    await message({ operation: 'sendWhatsApp', from: FROM, to: TO, additionalFields: { contentSid: 'HX0123456789abcdef0123456789abcdef', contentVariables: '{"1":"Ann"}' } });
    expect(lastForm()).toEqual({ To: [`whatsapp:${TO}`], From: [`whatsapp:${FROM}`], ContentSid: ['HX0123456789abcdef0123456789abcdef'], ContentVariables: ['{"1":"Ann"}'] });
    expect((await message({ operation: 'sendWhatsApp', from: FROM, to: TO })).error?.message).toBe('A WhatsApp message needs a Message, a Media URL or a Content Template SID');
    expect((await message({ operation: 'sendWhatsApp', from: FROM, to: TO, body: 'x', additionalFields: { contentVariables: '[1]' } })).error?.message).toBe('Content Variables must be a JSON object');
  });

  it('requires From, To and a Message before calling Twilio', async () => {
    expect((await message({ operation: 'send', from: '', to: TO, body: 'x' })).error?.message).toBe('From is required');
    expect((await message({ operation: 'send', from: FROM, to: '', body: 'x' })).error?.message).toBe('To is required');
    expect((await message({ operation: 'send', from: FROM, to: TO, body: '  ' })).error?.message).toBe('Message is required');
    expect(twilio.requests).toHaveLength(0);
  });

  it('turns a Twilio error into a node error that keeps the code, the hint and more_info', async () => {
    const response = await message({ operation: 'send', from: FROM, to: '+15005550001', body: 'x' });
    expect(response.error).toMatchObject({
      message: "Twilio API error 400 (code 21211): The 'To' number +15005550001 is not a valid phone number.",
      description: "The 'To' number is not a valid phone number (use E.164, e.g. +15551234567). See https://www.twilio.com/docs/errors/21211",
      itemIndex: 0,
    });
    expect((await message({ operation: 'send', from: FROM, to: '+15005550009', body: 'x' })).error?.message).toContain('(code 21614)');
    expect((await message({ operation: 'get', messageSid: 'SM00000000000000000000000000000000' })).error).toMatchObject({
      message: 'Twilio API error 404 (code 20404): The requested resource /Messages/SM00000000000000000000000000000000 was not found',
      description: 'No such resource on this account: check the SID. See https://www.twilio.com/docs/errors/20404',
    });
    const unauthorized = await message({ operation: 'send', from: FROM, to: TO, body: 'x' }, { credentials: credentials({ authToken: 'wrong-token-0000' }) });
    expect(unauthorized.error?.message).toBe('Twilio API error 401 (code 20003): Authentication Error - invalid username');
    expect(JSON.stringify(unauthorized)).not.toContain('wrong-token-0000');
  });

  it('continues on fail: the failed item becomes { error } and the next item is still sent once', async () => {
    const response = await message(
      { operation: 'send', from: FROM, to: TO, body: 'x' },
      { items: [{}, {}], perItem: [{ to: '+15005550001' }, { to: TO }], continueOnFail: true },
    );
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ error: expect.stringContaining('(code 21211)') });
    expect(jsonOf(response)[1]).toMatchObject({ sid: expect.stringMatching(/^SM/) });
    expect(posts()).toHaveLength(2);
  });

  it('waits Retry-After on a 429 and retries once, so the SMS still goes out exactly once', async () => {
    twilio.failNext({ status: 429, retryAfter: 0.2 });
    const started = Date.now();
    const response = await message({ operation: 'send', from: FROM, to: TO, body: 'retry me' });
    expect(response.error).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(posts()).toHaveLength(2);
    expect(twilio.messages).toHaveLength(1);
    expect(jsonOf(response)[0]).toMatchObject({ body: 'retry me' });
  });

  it('fails a 429 whose Retry-After is too long (or that repeats) with the code, without a second retry', async () => {
    twilio.failNext({ status: 429, retryAfter: 120 });
    const response = await message({ operation: 'send', from: FROM, to: TO, body: 'x' });
    expect(response.error?.message).toBe('Twilio API error 429 (code 20429): Too Many Requests');
    expect(response.error?.description).toContain('Twilio rate limit');
    expect(posts()).toHaveLength(1);
    twilio.reset();
    twilio.failNext({ status: 429, retryAfter: 0.05, times: 2 });
    expect((await message({ operation: 'send', from: FROM, to: TO, body: 'x' })).error?.message).toContain('(code 20429)');
    expect(posts()).toHaveLength(2);
    expect(twilio.messages).toHaveLength(0);
  });

  it('does not wait for a 429 when the call deadline is near, and never retries a 5xx', async () => {
    twilio.failNext({ status: 429, retryAfter: 5 });
    const request = { operation: 'send', from: FROM, to: TO, body: 'x' };
    const deadline = Date.now() + 2_000;
    const near = await run(Twilio, { resource: 'message', ...request }, { credentials: credentials(), deadline });
    expect(near.error?.message).toContain('(code 20429)');
    expect(posts()).toHaveLength(1);
    twilio.reset();
    twilio.failNext({ status: 503 });
    const down = await message(request);
    expect(down.error?.message).toBe('Twilio API error 503 (code 20500): Internal Server Error');
    expect(posts()).toHaveLength(1);
    expect(twilio.messages).toHaveLength(0);
  });

  it('gets a message by SID', async () => {
    await message({ operation: 'send', from: FROM, to: TO, body: 'stored' });
    const sid = twilio.messages[0].sid as string;
    const response = await message({ operation: 'get', messageSid: sid });
    expect(twilio.requests.at(-1)).toMatchObject({ method: 'GET', path: `/2010-04-01/Accounts/${twilio.accountSid}/Messages/${sid}.json` });
    expect(jsonOf(response)).toEqual([expect.objectContaining({ sid, body: 'stored' })]);
  });

  it('lists messages with filters, a limit, and Return All paging through next_page_uri', async () => {
    for (let i = 0; i < 7; i++) await message({ operation: 'send', from: FROM, to: i % 2 ? TO : '+15557654321', body: `m${i}` });
    twilio.requests.length = 0;
    const limited = await message({ operation: 'list', returnAll: false, limit: 3 });
    expect(jsonOf(limited).map((m) => m.body)).toEqual(['m6', 'm5', 'm4']);
    expect(twilio.requests).toHaveLength(1);
    expect(twilio.requests[0].query.get('PageSize')).toBe('3');

    twilio.requests.length = 0;
    const filtered = await message({ operation: 'list', returnAll: true, filters: { to: TO, from: FROM, dateSent: new Date().toISOString().slice(0, 10) } });
    expect(jsonOf(filtered).map((m) => m.body)).toEqual(['m5', 'm3', 'm1']);
    expect(Object.fromEntries(twilio.requests[0].query)).toEqual({ To: TO, From: FROM, DateSent: new Date().toISOString().slice(0, 10), PageSize: '100' });
    expect(jsonOf(await message({ operation: 'list', returnAll: true, filters: { dateSentAfter: '2099-01-01' } }))).toEqual([]);

    twilio.requests.length = 0;
    expect(jsonOf(await message({ operation: 'list', returnAll: true }))).toHaveLength(7);
    expect(twilio.requests).toHaveLength(1); // 7 rows fit one page of 100
  });

  it('follows next_page_uri across pages until the end (fake pages of 2)', async () => {
    for (let i = 0; i < 5; i++) await message({ operation: 'send', from: FROM, to: TO, body: `p${i}` });
    twilio.requests.length = 0;
    // The node asks for PageSize=min(100, limit); with limit 5 and the fake holding 5 that is one page, so push the
    // fake's page size down by listing through a proxy base URL that rewrites PageSize.
    const proxy = await startPageSizeProxy(twilio.url, 2);
    try {
      const response = await run(Twilio, { resource: 'message', operation: 'list', returnAll: true }, { credentials: credentials({ baseUrl: proxy.url }) });
      expect(jsonOf(response).map((m) => m.body)).toEqual(['p4', 'p3', 'p2', 'p1', 'p0']);
      const pages = twilio.requests.filter((r) => r.method === 'GET');
      expect(pages).toHaveLength(3);
      expect(pages.map((r) => r.query.get('Page'))).toEqual([null, '1', '2']);
      expect(pages[1].query.get('PageToken')).toMatch(/^PA(SM|MM)/);
      const limited = await run(Twilio, { resource: 'message', operation: 'list', returnAll: false, limit: 3 }, { credentials: credentials({ baseUrl: proxy.url }) });
      expect(jsonOf(limited).map((m) => m.body)).toEqual(['p4', 'p3', 'p2']);
    } finally {
      await proxy.close();
    }
  });
});

describe('Call', () => {
  it('makes a call with inline TwiML exactly once', async () => {
    const response = await call({ operation: 'make', callFrom: FROM, callTo: TO, callSource: 'twiml', twiml: '<Response><Say>Hi</Say></Response>', callOptions: { timeout: 30, record: true, machineDetection: 'Enable' } });
    expect(response.error).toBeUndefined();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`);
    expect(lastForm()).toEqual({ To: [TO], From: [FROM], Twiml: ['<Response><Say>Hi</Say></Response>'], Timeout: ['30'], Record: ['true'], MachineDetection: ['Enable'] });
    expect(jsonOf(response)[0]).toMatchObject({ sid: expect.stringMatching(/^CA[0-9a-f]{32}$/), status: 'queued', from: FROM, to: TO });
  });

  it('makes a call from a TwiML URL, and validates before calling', async () => {
    await call({ operation: 'make', callFrom: FROM, callTo: TO, callSource: 'url', url: 'https://example.com/voice.xml', callOptions: { statusCallback: 'https://example.com/cb' } });
    expect(lastForm()).toEqual({ To: [TO], From: [FROM], Url: ['https://example.com/voice.xml'], StatusCallback: ['https://example.com/cb'] });
    expect((await call({ operation: 'make', callFrom: FROM, callTo: TO, callSource: 'url', url: '' })).error?.message).toBe('TwiML URL is required');
    expect((await call({ operation: 'make', callFrom: FROM, callTo: TO, callSource: 'twiml', twiml: '' })).error?.message).toBe('TwiML is required');
    expect((await call({ operation: 'make', callFrom: FROM, callTo: 'nope', callSource: 'twiml', twiml: '<Response/>' })).error?.message).toContain('(code 21211)');
    expect(posts()).toHaveLength(2);
  });

  it('gets and lists calls', async () => {
    for (let i = 0; i < 3; i++) await call({ operation: 'make', callFrom: FROM, callTo: i ? TO : '+15557654321', callSource: 'twiml', twiml: `<Response><Say>${i}</Say></Response>` });
    const sid = twilio.calls[0].sid as string;
    expect(jsonOf(await call({ operation: 'get', callSid: sid }))).toEqual([expect.objectContaining({ sid, to: TO })]);
    expect((await call({ operation: 'get', callSid: 'CA00000000000000000000000000000000' })).error?.message).toContain('(code 20404)');
    twilio.requests.length = 0;
    const listed = await call({ operation: 'list', returnAll: true, callFilters: { to: TO, status: 'queued', startTime: new Date().toISOString().slice(0, 10) } });
    expect(jsonOf(listed)).toHaveLength(2);
    expect(Object.fromEntries(twilio.requests[0].query)).toEqual({ To: TO, Status: 'queued', StartTime: new Date().toISOString().slice(0, 10), PageSize: '100' });
    expect(jsonOf(await call({ operation: 'list', returnAll: false, limit: 1 }))).toHaveLength(1);
    expect((await call({ operation: 'hangup' })).error?.message).toBe('Operation "hangup" is not available for resource "call"');
  });
});

describe('MCP tools', () => {
  it('lists twilio_message_send with the right schema and annotations, and the other Twilio operations', () => {
    const tools = mcpToolsFromManifest(createDispatcher(plugin).manifest);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['twilio_message_send', 'twilio_message_sendMms', 'twilio_message_sendWhatsApp', 'twilio_message_get', 'twilio_message_list', 'twilio_call_make', 'twilio_call_get', 'twilio_call_list']));
    // The trigger is not a tool.
    expect(names.some((n) => n.startsWith('telegramTrigger'))).toBe(false);

    const send = tools.find((t) => t.name === 'twilio_message_send')!;
    expect(send.annotations).toEqual({ title: 'Twilio · Message · Send SMS', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(send.description).toContain('Send an SMS');
    const schema = send.inputSchema as { type: string; properties: Record<string, JsonObject>; required?: string[] };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['from', 'to', 'body', 'additionalFields']);
    expect(schema.required).toEqual(['from', 'to', 'body']);
    expect(schema.properties.to).toMatchObject({ type: 'string' });
    expect(JSON.stringify(schema)).not.toMatch(/authToken|apiKeySecret|accountSid/);
    expect(send.outputSchema).toMatchObject({ type: 'object', properties: { items: { type: 'array', items: { type: 'object', required: ['sid', 'to', 'status'] } } } });

    const mms = tools.find((t) => t.name === 'twilio_message_sendMms')!;
    expect(Object.keys((mms.inputSchema as JsonObject).properties as JsonObject)).toEqual(['from', 'to', 'body', 'mediaUrls', 'additionalFields']);
    expect(((mms.inputSchema as JsonObject).properties as JsonObject).mediaUrls).toMatchObject({ type: 'object', properties: { urls: { type: 'array' } } });

    const list = tools.find((t) => t.name === 'twilio_message_list')!;
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    const make = tools.find((t) => t.name === 'twilio_call_make')!;
    expect(make.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(make.outputSchema).toMatchObject({ properties: { items: { items: { required: ['sid', 'to', 'from', 'status'] } } } });
    expect(tools.find((t) => t.name === 'twilio_call_get')!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });

    // Every existing send/post tool is at most once; every read is idempotent.
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.idempotentHint]));
    expect(hints).toMatchObject({ telegram_message_sendMessage: false, slack_message_post: false, discord_message_send: false, whatsApp_message_send: false, emailSend: false, slack_channel_getAll: true, telegram_chat_get: true, discord_message_getAll: true });
  });

  it('serves the same tools on the SDK MCP face and calls twilio_message_send once against the fake', async () => {
    const dispatcher = createDispatcher(plugin);
    const face = createMcpFace({ dispatcher, manifest: dispatcher.manifest, loopback: true, credentials: { twilioApi: credentials().twilioApi } });
    try {
      const send = face.tools.find((t) => t.name === 'twilio_message_send')!;
      expect(send.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect((send as JsonObject)._meta).toBeUndefined();
      const response = await face.fetch(
        new Request('http://plugin/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'twilio_message_send' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'twilio_message_send',
              arguments: { from: FROM, to: TO, body: 'via mcp' },
              _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} },
            },
          }),
        }),
      );
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const payload = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:'))!.slice(5));
      expect(payload.result.isError).toBeFalsy();
      expect(payload.result.structuredContent.items[0]).toMatchObject({ body: 'via mcp', status: 'queued' });
      expect(posts()).toHaveLength(1);
      expect(text).not.toContain(twilio.authToken);
    } finally {
      await face.close();
    }
  });
});

/** A tiny proxy in front of the fake that forces `PageSize=<n>` on list requests, so paging through next_page_uri is exercised with few rows. */
async function startPageSizeProxy(upstream: string, pageSize: number): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', upstream);
    if (url.searchParams.has('PageSize')) url.searchParams.set('PageSize', String(pageSize));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host' && key !== 'content-length') headers[key] = value;
    const upstreamResponse = await fetch(url, { method: req.method, headers, ...(chunks.length && { body: Buffer.concat(chunks) }) });
    res.writeHead(upstreamResponse.status, { 'content-type': 'application/json', ...(upstreamResponse.headers.get('retry-after') && { 'retry-after': upstreamResponse.headers.get('retry-after')! }) });
    res.end(await upstreamResponse.text());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
