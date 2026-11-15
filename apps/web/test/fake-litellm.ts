/**
 * A local fake of the LiteLLM proxy (docs/llm-gateway.md), so the gateway code is tested without the container:
 * /v1/messages (Anthropic format, plain and streamed, with a tool call), /v1/chat/completions (plain and streamed),
 * /v1/models, the health endpoints, /spend/logs/v2 and /spend/logs, teams, customers (end users) and virtual keys, with
 * customer, team and key budgets that refuse a call once spent. Every model call answers with `x-litellm-call-id` and
 * `x-litellm-response-cost` and writes a spend-log row the way the proxy does (hashed key, end user, tags, key and
 * request metadata).
 *
 * Shapes follow LiteLLM's docs; the live suites (LANDFLOW_INTEGRATION=litellm) check the real ones. Contract file of
 * the LiteLLM wave (LL): every package adds it byte for byte; change it only through the integrator, with
 * lib/server/llm-gateway/client.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLiteLlmRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface FakeKey {
  key: string;
  token: string;
  key_alias?: string;
  team_id?: string;
  max_budget?: number | null;
  budget_duration?: string | null;
  blocked?: boolean;
  models?: string[];
  metadata?: Record<string, unknown>;
  spend: number;
}

export interface FakeTeam {
  team_id: string;
  team_alias?: string;
  max_budget?: number | null;
  budget_duration?: string | null;
  metadata?: Record<string, unknown>;
  spend: number;
}

export interface FakeCustomer {
  user_id: string;
  alias?: string;
  /** As in the real proxy, a customer's budget lives on a budget object (`/budget/new`, `/budget/update`). */
  budget_id?: string;
  max_budget?: number | null;
  budget_duration?: string | null;
  blocked?: boolean;
  spend: number;
}

export interface FakeSpendLog {
  /** The response id (`chatcmpl-…`), as the real proxy writes it; the call id is `litellm_call_id`. */
  request_id: string;
  litellm_call_id?: string;
  call_type: string;
  api_key: string;
  spend: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  startTime: string;
  endTime: string;
  model: string;
  model_group: string;
  end_user: string;
  team_id: string;
  request_tags: string[];
  status: 'success' | 'failure';
  metadata: Record<string, unknown>;
}

export interface FakeLiteLlmOptions {
  /** The master key: the only key the management endpoints accept. */
  masterKey?: string;
  /** Model names the proxy serves (`/v1/models`); a call to another model gets a 400. */
  models?: string[];
  /** Dollars per call (sent as `x-litellm-response-cost` and written to the spend log). */
  costPerCall?: number;
  /** Tokens per call. */
  usage?: { input: number; output: number; cacheRead?: number };
  /** Answer text for a call (default: `Echo: <last user text>`). */
  answer?: (model: string, lastUserText: string) => string;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** The key a request carried (`authorization: Bearer`, or `x-api-key`, which the Anthropic SDK sends by default). */
export const sentLiteLlmKey = (headers: IncomingHttpHeaders): string =>
  String(headers['x-api-key'] ?? '') || String(headers.authorization ?? '').replace(/^Bearer\s+/i, '');

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const parts = message.content as Array<{ type?: string; text?: string; content?: unknown }>;
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
      if (text) return text;
      const result = parts.find((p) => p.type === 'tool_result');
      if (result) return `tool:${typeof result.content === 'string' ? result.content : JSON.stringify(result.content)}`;
    }
  }
  return '';
}

export async function startFakeLiteLlm(options: FakeLiteLlmOptions = {}) {
  const masterKey = options.masterKey ?? 'sk-fake-master';
  const models = options.models ?? ['qwen3-coder:30b', 'qwen3.8'];
  const costPerCall = options.costPerCall ?? 0.001;
  const usage = options.usage ?? { input: 12, output: 8 };
  const requests: FakeLiteLlmRequest[] = [];
  const keys = new Map<string, FakeKey>();
  const teams = new Map<string, FakeTeam>();
  const customers = new Map<string, FakeCustomer>();
  const budgets = new Map<string, { max_budget: number | null; budget_duration: string | null }>();
  const spendLogs: FakeSpendLog[] = [];
  let down = false;

  const keyOf = (value: string): FakeKey | undefined => (value === masterKey ? undefined : (keys.get(value) ?? [...keys.values()].find((k) => k.token === value)));
  const publicKey = (k: FakeKey) => ({
    token: k.token,
    key_alias: k.key_alias ?? null,
    team_id: k.team_id ?? null,
    max_budget: k.max_budget ?? null,
    budget_duration: k.budget_duration ?? null,
    blocked: k.blocked ?? false,
    models: k.models ?? [],
    metadata: k.metadata ?? {},
    spend: k.spend,
  });
  const publicCustomer = (c: FakeCustomer) => ({
    user_id: c.user_id,
    alias: c.alias ?? null,
    spend: c.spend,
    blocked: c.blocked ?? false,
    budget_id: c.budget_id ?? null,
    litellm_budget_table: c.max_budget === undefined || c.max_budget === null ? null : { max_budget: c.max_budget, budget_duration: c.budget_duration ?? null },
  });

  /** Who a model call is from, or an error to send. */
  function admit(headers: IncomingHttpHeaders, body: Record<string, unknown>): { error?: [number, unknown]; key?: FakeKey; endUser?: string } {
    const sent = sentLiteLlmKey(headers);
    const key = keyOf(sent);
    if (sent !== masterKey && !key) return { error: [401, { error: { message: 'Authentication Error, Invalid proxy server token passed.', type: 'auth_error', code: '401' } }] };
    if (key?.blocked) return { error: [401, { error: { message: 'Authentication Error, Key is blocked.', type: 'auth_error', code: '401' } }] };
    const model = String(body.model ?? '');
    if (!models.includes(model)) return { error: [400, { error: { message: `Invalid model name passed in model=${model}`, type: 'invalid_request_error', code: '400' } }] };
    if (key?.models?.length && !key.models.includes(model)) return { error: [401, { error: { message: `key not allowed to access model ${model}`, type: 'key_model_access_denied', code: '401' } }] };
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    const endUser =
      String(headers['x-litellm-customer-id'] ?? '') || String(headers['x-litellm-end-user-id'] ?? '') || String(body.user ?? '') || String(metadata.user_id ?? '') || undefined;
    const over = (spent: number, max: number | null | undefined) => typeof max === 'number' && spent >= max;
    if (key && over(key.spend, key.max_budget)) return { error: [400, { error: { message: `ExceededTokenBudget: Current spend for token: ${key.spend}; Max Budget for Token: ${key.max_budget}`, type: 'budget_exceeded', code: '400' } }] };
    const team = key?.team_id ? teams.get(key.team_id) : undefined;
    if (team && over(team.spend, team.max_budget)) return { error: [400, { error: { message: `Budget has been exceeded! Team=${team.team_id} Current cost: ${team.spend}, Max budget: ${team.max_budget}`, type: 'budget_exceeded', code: '400' } }] };
    const customer = endUser ? customers.get(endUser) : undefined;
    if (customer?.blocked) return { error: [403, { error: { message: `End User=${endUser} blocked.`, type: 'auth_error', code: '403' } }] };
    if (customer && over(customer.spend, customer.max_budget)) return { error: [400, { error: { message: `ExceededBudget: End User=${endUser} over budget. Spend=${customer.spend}, Budget=${customer.max_budget}`, type: 'budget_exceeded', code: '400' } }] };
    return { key, ...(endUser && { endUser }) };
  }

  /** Charge a call and write its spend-log row; returns the call id. */
  function charge(headers: IncomingHttpHeaders, model: string, callType: string, who: { key?: FakeKey; endUser?: string }): string {
    // As the proxy does, a caller's own `x-litellm-call-id` is taken (so two calls can share one).
    const callId = String(headers['x-litellm-call-id'] ?? '') || randomUUID();
    const now = new Date().toISOString();
    if (who.key) who.key.spend += costPerCall;
    const team = who.key?.team_id ? teams.get(who.key.team_id) : undefined;
    if (team) team.spend += costPerCall;
    if (who.endUser) {
      const customer = customers.get(who.endUser) ?? { user_id: who.endUser, spend: 0 };
      customer.spend += costPerCall;
      customers.set(who.endUser, customer);
    }
    let requestMetadata: Record<string, unknown> = {};
    try {
      const raw = headers['x-litellm-spend-logs-metadata'];
      if (typeof raw === 'string' && raw) requestMetadata = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      requestMetadata = {};
    }
    const keyMetadata = (who.key?.metadata?.spend_logs_metadata ?? {}) as Record<string, unknown>;
    const tags = String(headers['x-litellm-tags'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    spendLogs.push({
      request_id: `chatcmpl-${randomUUID()}`,
      litellm_call_id: callId,
      call_type: callType,
      api_key: sha(sentLiteLlmKey(headers)),
      spend: costPerCall,
      total_tokens: usage.input + usage.output,
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      startTime: now,
      endTime: now,
      model,
      model_group: model,
      end_user: who.endUser ?? '',
      team_id: who.key?.team_id ?? '',
      request_tags: tags,
      status: 'success',
      metadata: {
        user_api_key_alias: who.key?.key_alias ?? null,
        user_api_key_team_id: who.key?.team_id ?? null,
        spend_logs_metadata: { ...keyMetadata, ...requestMetadata },
        usage_object: { prompt_tokens: usage.input, completion_tokens: usage.output, ...(usage.cacheRead && { cache_read_input_tokens: usage.cacheRead }) },
      },
    });
    return callId;
  }

  const callHeaders = (callId: string) => ({ 'x-litellm-call-id': callId, 'x-litellm-response-cost': String(costPerCall), 'x-litellm-model-id': 'fake-deployment' });

  function sse(res: ServerResponse, headers: Record<string, string>, events: Array<{ event?: string; data: unknown }>) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
    for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
    res.end();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function messages(res: ServerResponse, headers: IncomingHttpHeaders, body: any) {
    const who = admit(headers, body);
    if (who.error) return send(res, who.error[0], who.error[1]);
    const model = String(body.model);
    const last = lastUserText(body.messages);
    const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name: string }>) : [];
    const useTool = tools.length > 0 && !last.startsWith('tool:');
    const text = useTool ? '' : (options.answer?.(model, last) ?? `Echo: ${last}`);
    const content = useTool ? [{ type: 'tool_use', id: 'toolu_1', name: tools[0].name, input: { expression: '6*7' } }] : [{ type: 'text', text }];
    const stop = useTool ? 'tool_use' : 'end_turn';
    const callId = charge(headers, model, 'anthropic_messages', who);
    const usageBody = { input_tokens: usage.input, output_tokens: usage.output, ...(usage.cacheRead && { cache_read_input_tokens: usage.cacheRead }) };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', ...callHeaders(callId) });
      return res.end(JSON.stringify({ id: `msg_${callId.slice(0, 8)}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: usageBody }));
    }
    const events: Array<{ event?: string; data: unknown }> = [
      { event: 'message_start', data: { type: 'message_start', message: { id: `msg_${callId.slice(0, 8)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usageBody, output_tokens: 1 } } } },
    ];
    if (useTool) {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: tools[0].name, input: {} } } });
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"expression":"6*7"}' } } });
    } else {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      for (const piece of text.match(/.{1,8}/gs) ?? []) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
    events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } } });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return sse(res, callHeaders(callId), events);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function chat(res: ServerResponse, headers: IncomingHttpHeaders, body: any) {
    const who = admit(headers, body);
    if (who.error) return send(res, who.error[0], who.error[1]);
    const model = String(body.model);
    const last = lastUserText(body.messages);
    const text = options.answer?.(model, last) ?? `Echo: ${last}`;
    const callId = charge(headers, model, 'acompletion', who);
    const usageBody = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', ...callHeaders(callId) });
      return res.end(JSON.stringify({ id: `chatcmpl-${callId.slice(0, 8)}`, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: usageBody }));
    }
    const events: Array<{ data: unknown }> = (text.match(/.{1,8}/gs) ?? []).map((piece) => ({ data: { id: 'chatcmpl-1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] } }));
    events.push({ data: { id: 'chatcmpl-1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
    if (body.stream_options?.include_usage) events.push({ data: { id: 'chatcmpl-1', object: 'chat.completion.chunk', model, choices: [], usage: usageBody } });
    events.push({ data: '[DONE]' });
    return sse(res, callHeaders(callId), events);
  }

  function send(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain' : 'application/json' });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = new URL(req.url ?? '/', 'http://fake');
    const path = parsed.pathname;
    let body: Record<string, unknown> | undefined;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    } catch {
      return send(res, 400, { error: { message: 'Invalid JSON' } });
    }
    requests.push({ method: req.method ?? 'GET', path, query: parsed.searchParams, headers: req.headers, body });
    if (down) return send(res, 503, { error: { message: 'Service Unavailable' } });

    if (path === '/health/liveliness') return send(res, 200, "I'm alive!");
    if (path === '/health/readiness') return send(res, 200, { status: 'healthy', db: 'connected', litellm_version: 'fake' });
    if (path === '/v1/models' || path === '/models') {
      if (!sentLiteLlmKey(req.headers) || (sentLiteLlmKey(req.headers) !== masterKey && !keyOf(sentLiteLlmKey(req.headers)))) return send(res, 401, { error: { message: 'Authentication Error', type: 'auth_error', code: '401' } });
      return send(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'openai' })) });
    }
    if (path === '/v1/messages') return messages(res, req.headers, body ?? {});
    if (path === '/v1/chat/completions' || path === '/chat/completions') return chat(res, req.headers, body ?? {});

    // Management endpoints: the master key only.
    if (sentLiteLlmKey(req.headers) !== masterKey) return send(res, 401, { error: { message: 'Authentication Error, only proxy admin can call this route', type: 'auth_error', code: '401' } });
    const b = body ?? {};
    const q = parsed.searchParams;

    if (path === '/spend/logs/v2') {
      const start = q.get('start_date') ?? '0000';
      const end = q.get('end_date') ?? '9999';
      const page = Math.max(1, Number(q.get('page') ?? 1));
      const size = Math.min(1000, Math.max(1, Number(q.get('page_size') ?? 50)));
      const iso = (t: string) => t.replace(' ', 'T');
      const rows = spendLogs.filter((r) => r.startTime >= iso(start) && r.startTime <= `${iso(end)}.999Z`);
      return send(res, 200, { data: rows.slice((page - 1) * size, page * size), total: rows.length, page, page_size: size, total_pages: Math.max(1, Math.ceil(rows.length / size)), total_is_capped: false });
    }
    if (path === '/spend/logs') {
      const id = q.get('request_id');
      return send(res, 200, id ? spendLogs.filter((r) => r.request_id === id || r.litellm_call_id === id) : spendLogs);
    }

    if (path === '/team/new') {
      const id = String(b.team_id ?? randomUUID());
      if (teams.has(id)) return send(res, 400, { error: { message: `Team id = ${id} already exists. Please use a different team id.`, type: 'bad_request', code: '400' } });
      const team: FakeTeam = { team_id: id, ...(typeof b.team_alias === 'string' && { team_alias: b.team_alias }), max_budget: (b.max_budget as number | null | undefined) ?? null, budget_duration: (b.budget_duration as string | null | undefined) ?? null, metadata: (b.metadata as Record<string, unknown> | undefined) ?? {}, spend: 0 };
      teams.set(id, team);
      return send(res, 200, team);
    }
    if (path === '/team/update') {
      const team = teams.get(String(b.team_id));
      if (!team) return send(res, 404, { detail: { error: `Team not found, passed team_id=${String(b.team_id)}` } });
      for (const field of ['team_alias', 'max_budget', 'budget_duration', 'metadata'] as const) if (field in b) (team as unknown as Record<string, unknown>)[field] = b[field];
      return send(res, 200, { data: team, team_id: team.team_id });
    }
    if (path === '/team/info') {
      const team = teams.get(q.get('team_id') ?? '');
      if (!team) return send(res, 404, { detail: { error: `Team not found, passed team_id=${q.get('team_id')}` } });
      return send(res, 200, { team_id: team.team_id, team_info: team, keys: [...keys.values()].filter((k) => k.team_id === team.team_id).map(publicKey) });
    }
    if (path === '/team/list') return send(res, 200, [...teams.values()]);

    if (path === '/customer/new') {
      const id = String(b.user_id ?? '');
      if (!id) return send(res, 400, { error: { message: 'user_id is required' } });
      // A customer exists once it was created or once a call named it (as the proxy tracks end users): create only new ones.
      if (customers.has(id)) return send(res, 400, { error: { message: `Customer already exists, passed user_id=${id}`, type: 'bad_request', code: '400' } });
      const max = (b.max_budget as number | null | undefined) ?? null;
      const customer: FakeCustomer = { user_id: id, ...(typeof b.alias === 'string' && { alias: b.alias }), ...(max !== null && { budget_id: randomUUID() }), max_budget: max, budget_duration: (b.budget_duration as string | null | undefined) ?? null, spend: 0 };
      customers.set(id, customer);
      return send(res, 200, publicCustomer(customer));
    }
    if (path === '/customer/update') {
      const customer = customers.get(String(b.user_id ?? ''));
      if (!customer) return send(res, 400, { error: { message: `End User Id=${String(b.user_id)} does not exist in db`, type: 'bad_request', code: '400' } });
      // Like the pinned proxy: budget fields here are ignored (a null never clears one); the budget object holds them.
      for (const field of ['alias', 'blocked'] as const) if (field in b) (customer as unknown as Record<string, unknown>)[field] = b[field];
      if (typeof b.budget_id === 'string') {
        const budget = budgets.get(b.budget_id);
        if (!budget) return send(res, 400, { error: { message: `Budget not found, passed budget_id=${b.budget_id}` } });
        Object.assign(customer, { budget_id: b.budget_id, max_budget: budget.max_budget, budget_duration: budget.budget_duration });
      }
      return send(res, 200, publicCustomer(customer));
    }
    if (path === '/budget/new') {
      const budget_id = typeof b.budget_id === 'string' ? b.budget_id : randomUUID();
      const budget = { max_budget: (b.max_budget as number | null | undefined) ?? null, budget_duration: (b.budget_duration as string | null | undefined) ?? null };
      budgets.set(budget_id, budget);
      return send(res, 200, { budget_id, ...budget });
    }
    if (path === '/budget/update') {
      const budget_id = String(b.budget_id ?? '');
      const linked = [...customers.values()].filter((c) => c.budget_id === budget_id);
      const budget = budgets.get(budget_id) ?? (linked[0] ? { max_budget: linked[0].max_budget ?? null, budget_duration: linked[0].budget_duration ?? null } : undefined);
      if (!budget) return send(res, 400, { error: { message: `Budget not found, passed budget_id=${budget_id}` } });
      for (const field of ['max_budget', 'budget_duration'] as const) if (field in b) budget[field] = (b[field] as never) ?? null;
      budgets.set(budget_id, budget);
      for (const c of linked) Object.assign(c, budget);
      return send(res, 200, { budget_id, ...budget });
    }
    if (path === '/customer/info') {
      const customer = customers.get(q.get('end_user_id') ?? '');
      if (!customer) return send(res, 400, { error: { message: `End User Id=${q.get('end_user_id')} does not exist in db`, type: 'bad_request', code: '400' } });
      return send(res, 200, publicCustomer(customer));
    }
    if (path === '/customer/list') return send(res, 200, [...customers.values()].map(publicCustomer));

    if (path === '/key/generate') {
      if (b.team_id && !teams.has(String(b.team_id))) return send(res, 400, { error: { message: `Team not found for team_id=${String(b.team_id)}`, type: 'bad_request', code: '400' } });
      const value = `sk-${randomUUID().replace(/-/g, '')}`;
      const key: FakeKey = {
        key: value,
        token: sha(value),
        ...(typeof b.key_alias === 'string' && { key_alias: b.key_alias }),
        ...(typeof b.team_id === 'string' && { team_id: b.team_id }),
        max_budget: (b.max_budget as number | null | undefined) ?? null,
        budget_duration: (b.budget_duration as string | null | undefined) ?? null,
        models: Array.isArray(b.models) ? (b.models as string[]) : [],
        metadata: (b.metadata as Record<string, unknown> | undefined) ?? {},
        spend: 0,
      };
      keys.set(value, key);
      return send(res, 200, { key: value, ...publicKey(key) });
    }
    if (path === '/key/info') {
      const key = keyOf(q.get('key') ?? '');
      if (!key) return send(res, 404, { detail: { error: 'Key not found' } });
      return send(res, 200, { key: key.token, info: publicKey(key) });
    }
    if (path === '/key/update') {
      const key = keyOf(String(b.key ?? ''));
      if (!key) return send(res, 404, { detail: { error: 'Key not found' } });
      if (b.team_id && !teams.has(String(b.team_id))) return send(res, 400, { error: { message: `Team not found for team_id=${String(b.team_id)}` } });
      for (const field of ['team_id', 'max_budget', 'budget_duration', 'models', 'metadata', 'key_alias'] as const) if (field in b) (key as unknown as Record<string, unknown>)[field] = b[field];
      return send(res, 200, publicKey(key));
    }
    if (path === '/key/block' || path === '/key/unblock') {
      const key = keyOf(String(b.key ?? ''));
      if (!key) return send(res, 404, { detail: { error: 'Key not found' } });
      key.blocked = path === '/key/block';
      return send(res, 200, publicKey(key));
    }
    send(res, 404, { detail: 'Not Found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    /** The proxy's root (what the credential's Base URL is for /v1/messages; add /v1 for an OpenAI API credential). */
    origin,
    port,
    masterKey,
    requests,
    keys,
    teams,
    customers,
    spendLogs,
    last: (path: string) => [...requests].reverse().find((request) => request.path === path),
    /** A virtual key, as if an admin made it in LiteLLM (for a client outside Landflow). */
    addKey: (key: Partial<Omit<FakeKey, 'key' | 'token' | 'spend'>> = {}): FakeKey => {
      const value = `sk-${randomUUID().replace(/-/g, '')}`;
      const made: FakeKey = { key: value, token: sha(value), spend: 0, ...key };
      keys.set(value, made);
      return made;
    },
    /** Make every request answer 503 (or come back). */
    setDown: (value: boolean) => {
      down = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeLiteLlm = Awaited<ReturnType<typeof startFakeLiteLlm>>;
