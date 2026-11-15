/**
 * A small client for LiteLLM's proxy API (docs/llm-gateway.md): health, models, spend logs, teams, customers (end users)
 * and virtual keys. Only the open-source build's endpoints: no organizations, no Customer Portal, no key rotation (all
 * Enterprise or unreleased). Requests go through safeFetch, so the outbound address policy applies.
 *
 * Shapes follow LiteLLM's docs (proxy_cost_tracking.md, proxy_users.md, proxy_virtual_keys.md) and are read
 * defensively: a field LiteLLM leaves out is undefined, JSON that arrives as a string is parsed, and a "does not exist"
 * answer is `undefined`, not an error. The live suites (LANDFLOW_INTEGRATION=litellm) check them against the container.
 *
 * Contract file of the LiteLLM wave (LL): every package of the wave adds it byte for byte. Change it only through the
 * integrator, together with test/fake-litellm.ts.
 */
import { createHash } from 'node:crypto';
import { safeFetch } from '../net/safe-fetch';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface LiteLlmEndpoint {
  /** The proxy's root, without /v1 (e.g. http://127.0.0.1:54100). */
  baseUrl: string;
  /** The key to send: the master key (or a proxy-admin key) for the management endpoints, a virtual key for /v1. */
  key?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

/** An HTTP error from LiteLLM, with its status and the start of its body. */
export class LiteLlmError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`LiteLLM answered ${status} on ${path}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'LiteLlmError';
  }
}

/** LiteLLM stores a virtual key as the SHA-256 (hex) of the key; spend logs carry that hash as `api_key`. */
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** `YYYY-MM-DD HH:MM:SS` in UTC, the form /spend/logs/v2 takes. */
export const spendLogTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export interface LiteLlmSpendLog {
  /** The response's id (`chatcmpl-…`); not the call id the proxy sends back in `x-litellm-call-id`. */
  request_id: string;
  /** The call id the proxy sent back in `x-litellm-call-id`, which Landflow keeps on its `ai_usage` row. */
  litellm_call_id?: string;
  call_type?: string;
  /** The hashed key the call used. */
  api_key?: string;
  spend?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  startTime?: string;
  endTime?: string;
  model?: string;
  model_group?: string;
  custom_llm_provider?: string;
  /** The internal user that owns the key. */
  user?: string;
  /** The customer (end user) the request named. */
  end_user?: string;
  team_id?: string;
  request_tags?: string[];
  status?: string;
  session_id?: string;
  metadata?: {
    user_api_key_alias?: string | null;
    user_api_key_team_id?: string | null;
    user_api_key_team_alias?: string | null;
    spend_logs_metadata?: Record<string, unknown> | null;
    usage_object?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
}

export interface LiteLlmSpendPage {
  data: LiteLlmSpendLog[];
  total?: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
  total_is_capped?: boolean;
}

export interface LiteLlmTeam {
  team_id: string;
  team_alias?: string | null;
  max_budget?: number | null;
  budget_duration?: string | null;
  spend?: number | null;
  blocked?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface LiteLlmCustomer {
  user_id: string;
  /** The budget object that holds the customer's budget (`/budget/update` changes it). */
  budget_id?: string | null;
  alias?: string | null;
  spend?: number | null;
  blocked?: boolean;
  max_budget?: number | null;
  budget_duration?: string | null;
}

export interface LiteLlmKey {
  /** The hashed key (`token`). */
  token?: string;
  key_alias?: string | null;
  team_id?: string | null;
  max_budget?: number | null;
  budget_duration?: string | null;
  spend?: number | null;
  blocked?: boolean | null;
  models?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface GeneratedKey extends LiteLlmKey {
  /** The key itself (`sk-…`): returned once, at generation. */
  key: string;
}

const NOT_FOUND = /not (?:be )?found|does not exist|doesn't exist|no (?:team|customer|end user|key) (?:with|found)/i;

const asObject = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
};

const asTags = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
  }
  return undefined;
};

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const callIdOf = (raw: Record<string, unknown>, metadata: Record<string, unknown> | undefined): string | undefined => {
  const id = raw.litellm_call_id ?? metadata?.litellm_call_id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
};

/** One spend-log row as the proxy sent it, with `metadata` and `request_tags` parsed and numbers made numbers. */
export function normalizeSpendLog(raw: Record<string, unknown>): LiteLlmSpendLog {
  const metadata = asObject(raw.metadata);
  if (metadata) {
    const spendLogs = asObject(metadata.spend_logs_metadata);
    if (spendLogs) metadata.spend_logs_metadata = spendLogs;
    const usage = asObject(metadata.usage_object);
    if (usage) metadata.usage_object = usage;
  }
  return {
    ...(raw as unknown as LiteLlmSpendLog),
    request_id: String(raw.request_id ?? ''),
    ...(callIdOf(raw, metadata) && { litellm_call_id: callIdOf(raw, metadata) }),
    spend: num(raw.spend),
    total_tokens: num(raw.total_tokens),
    prompt_tokens: num(raw.prompt_tokens),
    completion_tokens: num(raw.completion_tokens),
    request_tags: asTags(raw.request_tags),
    ...(metadata && { metadata: metadata as LiteLlmSpendLog['metadata'] }),
  };
}

/** The budget fields of a customer, wherever the build puts them (top level or `litellm_budget_table`). */
function customerOf(raw: Record<string, unknown>): LiteLlmCustomer {
  const budget = asObject(raw.litellm_budget_table) ?? {};
  return {
    user_id: String(raw.user_id ?? raw.end_user_id ?? ''),
    budget_id: (raw.budget_id ?? budget.budget_id ?? null) as string | null,
    alias: (raw.alias as string | null | undefined) ?? null,
    spend: num(raw.spend) ?? null,
    blocked: Boolean(raw.blocked),
    max_budget: num(budget.max_budget ?? raw.max_budget) ?? null,
    budget_duration: (budget.budget_duration ?? raw.budget_duration ?? null) as string | null,
  };
}

/** The team fields, from `/team/info` (`{ team_id, team_info }`) or a bare team object. */
function teamOf(raw: Record<string, unknown>): LiteLlmTeam {
  const info = asObject(raw.team_info) ?? raw;
  return {
    team_id: String(info.team_id ?? raw.team_id ?? ''),
    team_alias: (info.team_alias as string | null | undefined) ?? null,
    max_budget: num(info.max_budget) ?? null,
    budget_duration: (info.budget_duration as string | null | undefined) ?? null,
    spend: num(info.spend) ?? null,
    blocked: Boolean(info.blocked),
    metadata: asObject(info.metadata) ?? null,
  };
}

/** The key fields, from `/key/info` (`{ key, info }`) or a bare key object. */
function keyOf(raw: Record<string, unknown>): LiteLlmKey {
  const info = asObject(raw.info) ?? raw;
  return {
    token: (info.token ?? (typeof raw.key === 'string' && !raw.key.startsWith('sk-') ? raw.key : undefined)) as string | undefined,
    key_alias: (info.key_alias as string | null | undefined) ?? null,
    team_id: (info.team_id as string | null | undefined) ?? null,
    max_budget: num(info.max_budget) ?? null,
    budget_duration: (info.budget_duration as string | null | undefined) ?? null,
    spend: num(info.spend) ?? null,
    blocked: info.blocked === undefined ? null : Boolean(info.blocked),
    models: Array.isArray(info.models) ? info.models.map(String) : undefined,
    metadata: asObject(info.metadata) ?? null,
  };
}

export class LiteLlmClient {
  private readonly base: string;

  constructor(private readonly endpoint: LiteLlmEndpoint) {
    this.base = endpoint.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  /** One request. Throws LiteLlmError on an HTTP error, the fetch error on a network failure. */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const fetcher: Fetcher = this.endpoint.fetcher ?? ((input, init) => safeFetch(input, init, { span: false }));
    const response = await fetcher(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(this.endpoint.key && { authorization: `Bearer ${this.endpoint.key}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.endpoint.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    if (!response.ok) throw new LiteLlmError(response.status, path, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** `undefined` instead of an error when LiteLLM says the thing doesn't exist (404, or a 400 that says so). */
  private async maybe<T>(load: () => Promise<T>): Promise<T | undefined> {
    try {
      return await load();
    } catch (error) {
      if (error instanceof LiteLlmError && (error.status === 404 || (error.status === 400 && NOT_FOUND.test(error.body)))) return undefined;
      throw error;
    }
  }

  /** /health/liveliness (the process) and /health/readiness (with the database). Never throws. */
  async health(): Promise<{ live: boolean; ready: boolean; db?: string; version?: string; error?: string }> {
    let live = false;
    let error: string | undefined;
    try {
      await this.request('GET', '/health/liveliness');
      live = true;
    } catch (caught) {
      error = (caught as Error).message;
    }
    if (!live) return { live, ready: false, ...(error && { error }) };
    try {
      const ready = await this.request<Record<string, unknown> | string>('GET', '/health/readiness');
      const info = asObject(ready) ?? {};
      return { live, ready: true, ...(typeof info.db === 'string' && { db: info.db }), ...(typeof info.litellm_version === 'string' && { version: info.litellm_version }) };
    } catch (caught) {
      return { live, ready: false, error: (caught as Error).message };
    }
  }

  /** The models the key may call (GET /v1/models). */
  async models(): Promise<Array<{ id: string; owned_by?: string }>> {
    const reply = await this.request<{ data?: Array<{ id: string; owned_by?: string }> }>('GET', '/v1/models');
    return (reply?.data ?? []).filter((m) => typeof m?.id === 'string');
  }

  /** One page of spend logs between `start` and `end` (`YYYY-MM-DD HH:MM:SS`, UTC). Pages start at 1; up to 1000 rows a page. */
  async spendLogs(query: { start: string; end: string; page: number; pageSize: number }): Promise<LiteLlmSpendPage> {
    const params = new URLSearchParams({ start_date: query.start, end_date: query.end, page: String(query.page), page_size: String(Math.min(1000, query.pageSize)) });
    const reply = await this.request<Record<string, unknown> | unknown[]>('GET', `/spend/logs/v2?${params}`);
    const page = Array.isArray(reply) ? { data: reply } : (reply ?? {});
    const rows = Array.isArray((page as { data?: unknown }).data) ? ((page as { data: unknown[] }).data as Array<Record<string, unknown>>) : [];
    const meta = page as Record<string, unknown>;
    return {
      data: rows.map(normalizeSpendLog).filter((row) => row.request_id),
      total: num(meta.total),
      page: num(meta.page),
      page_size: num(meta.page_size),
      total_pages: num(meta.total_pages),
      total_is_capped: Boolean(meta.total_is_capped),
    };
  }

  /** One call's spend-log row (GET /spend/logs?request_id=), for matching a call id: the proxy's `x-litellm-call-id` or the response id. */
  async spendLog(requestId: string): Promise<LiteLlmSpendLog | undefined> {
    const reply = await this.maybe(() => this.request<unknown>('GET', `/spend/logs?request_id=${encodeURIComponent(requestId)}`));
    const rows = Array.isArray(reply) ? reply : asObject(reply) ? [reply] : [];
    const row = rows.map((r) => normalizeSpendLog(r as Record<string, unknown>)).find((r) => r.litellm_call_id === requestId || r.request_id === requestId);
    return row;
  }

  async teamInfo(teamId: string): Promise<LiteLlmTeam | undefined> {
    const reply = await this.maybe(() => this.request<Record<string, unknown>>('GET', `/team/info?team_id=${encodeURIComponent(teamId)}`));
    return reply ? teamOf(reply) : undefined;
  }

  async createTeam(team: { team_id: string; team_alias?: string; max_budget?: number | null; budget_duration?: string | null; metadata?: Record<string, unknown> }): Promise<LiteLlmTeam> {
    return teamOf(await this.request<Record<string, unknown>>('POST', '/team/new', team));
  }

  async updateTeam(team: { team_id: string; team_alias?: string; max_budget?: number | null; budget_duration?: string | null; metadata?: Record<string, unknown> }): Promise<LiteLlmTeam> {
    return teamOf(await this.request<Record<string, unknown>>('POST', '/team/update', team));
  }

  async customerInfo(customerId: string): Promise<LiteLlmCustomer | undefined> {
    const reply = await this.maybe(() => this.request<Record<string, unknown>>('GET', `/customer/info?end_user_id=${encodeURIComponent(customerId)}`));
    return reply ? customerOf(reply) : undefined;
  }

  async createCustomer(customer: { user_id: string; alias?: string; max_budget?: number | null; budget_duration?: string | null }): Promise<LiteLlmCustomer> {
    return customerOf(await this.request<Record<string, unknown>>('POST', '/customer/new', customer));
  }

  /**
   * Change a customer. `/customer/update` ignores budget fields (a null never clears one), so the budget goes through the
   * customer's budget object: `/budget/update` when it has one, else a new budget (`/budget/new`) linked by `budget_id`.
   */
  async updateCustomer(customer: { user_id: string; alias?: string; max_budget?: number | null; budget_duration?: string | null }): Promise<LiteLlmCustomer> {
    const { user_id, alias, max_budget, budget_duration } = customer;
    const touchesBudget = max_budget !== undefined || budget_duration !== undefined;
    let budgetId: string | null | undefined;
    if (touchesBudget) {
      const current = await this.customerInfo(user_id);
      if (!current) throw new LiteLlmError(404, "/customer/info", `End User Id=${user_id} does not exist`);
      const fields = { ...(max_budget !== undefined && { max_budget }), ...(budget_duration !== undefined && { budget_duration }) };
      if (current.budget_id) await this.request('POST', '/budget/update', { budget_id: current.budget_id, ...fields });
      else if (max_budget !== null && max_budget !== undefined) budgetId = String((await this.request<Record<string, unknown>>('POST', '/budget/new', fields)).budget_id ?? '') || undefined;
    }
    if (alias !== undefined || budgetId) await this.request('POST', '/customer/update', { user_id, ...(alias !== undefined && { alias }), ...(budgetId && { budget_id: budgetId }) });
    const after = await this.customerInfo(user_id);
    if (!after) throw new LiteLlmError(404, "/customer/info", `End User Id=${user_id} does not exist`);
    return after;
  }

  async generateKey(key: {
    key_alias: string;
    team_id?: string;
    models?: string[];
    max_budget?: number | null;
    budget_duration?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<GeneratedKey> {
    const reply = await this.request<Record<string, unknown>>('POST', '/key/generate', key);
    const value = typeof reply?.key === 'string' ? reply.key : '';
    if (!value) throw new LiteLlmError(200, '/key/generate', 'no key in the answer');
    return { ...keyOf(reply), key: value, token: (reply.token as string | undefined) ?? hashKey(value) };
  }

  /** A key's settings, by the key itself (`sk-…`) or its hash. */
  async keyInfo(key: string): Promise<LiteLlmKey | undefined> {
    const reply = await this.maybe(() => this.request<Record<string, unknown>>('GET', `/key/info?key=${encodeURIComponent(key)}`));
    return reply ? keyOf(reply) : undefined;
  }

  async updateKey(key: { key: string; team_id?: string | null; models?: string[]; max_budget?: number | null; budget_duration?: string | null; metadata?: Record<string, unknown> }): Promise<LiteLlmKey> {
    return keyOf(await this.request<Record<string, unknown>>('POST', '/key/update', key));
  }

  /** Stop a key without deleting it (an agent removed from kagent); unblockKey undoes it. */
  async blockKey(key: string): Promise<void> {
    await this.request('POST', '/key/block', { key });
  }

  async unblockKey(key: string): Promise<void> {
    await this.request('POST', '/key/unblock', { key });
  }
}
