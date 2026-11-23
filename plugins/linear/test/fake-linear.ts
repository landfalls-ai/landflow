/**
 * A fake Linear GraphQL endpoint. It does not parse GraphQL: it recognises the operation by name in the query text and
 * answers from in-memory data, with Linear's behaviour that matters here: `updatedAt.gt` filters, `orderBy: updatedAt`
 * newest first, `first`/`after` paging with `pageInfo`, webhooks that can be created, read and deleted, and the two
 * Authorization forms (a bare API key, `Bearer` for OAuth2). Fake keys and data only.
 */
import type { JsonObject } from '@landflow/sdk';
import { startFakeApi, type FakeApi, type FakeReply, type FakeRequest } from './helpers';

export const API_KEY = 'lin_api_fake_key';
export const OAUTH_TOKEN = 'lin_oauth_fake_token';

export interface FakeWebhook extends JsonObject {
  id: string;
  url: string;
  enabled: boolean;
  secret: string;
  resourceTypes: string[];
  allPublicTeams: boolean;
  teamId: string | null;
}

export class FakeLinear {
  issues: JsonObject[] = [];
  comments: JsonObject[] = [];
  projectUpdates: JsonObject[] = [];
  users: JsonObject[] = [];
  teams: JsonObject[] = [{ id: 'team-1', key: 'ENG', name: 'Engineering' }];
  webhooks: FakeWebhook[] = [];
  created: Array<{ kind: string; input: JsonObject }> = [];
  /** When set, the next GraphQL call answers 429 with this Retry-After (seconds). */
  rateLimitOnce: number | undefined;
  private nextId = 1;

  authorized = (request: FakeRequest) => request.headers.authorization === API_KEY || request.headers.authorization === `Bearer ${OAUTH_TOKEN}`;

  private page(list: JsonObject[], variables: JsonObject) {
    const filter = (variables.filter ?? {}) as JsonObject;
    const gt = (filter.updatedAt as JsonObject | undefined)?.gt as string | undefined;
    const teamKey = ((filter.team as JsonObject | undefined)?.key as JsonObject | undefined)?.eq;
    let rows = list.filter((r) => (gt ? Date.parse(String(r.updatedAt)) > Date.parse(gt) : true));
    if (teamKey) rows = rows.filter((r) => (r.team as JsonObject | undefined)?.key === teamKey);
    rows = [...rows].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const first = Math.min(Number(variables.first ?? 50), 250);
    const start = variables.after ? Number(String(variables.after).replace('c', '')) : 0;
    const nodes = rows.slice(start, start + first);
    const hasNextPage = start + first < rows.length;
    return { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? `c${start + first}` : null } };
  }

  handle = (request: FakeRequest): FakeReply => {
    if (request.method !== 'POST' || request.path !== '/graphql') return { status: 404, body: { error: 'not found' } };
    if (this.rateLimitOnce !== undefined) {
      const retry = this.rateLimitOnce;
      this.rateLimitOnce = undefined;
      return { status: 429, headers: { 'retry-after': String(retry) }, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } };
    }
    if (!this.authorized(request)) return { status: 401, body: { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] } };
    const { query = '', variables = {} } = (request.body ?? {}) as { query?: string; variables?: JsonObject };
    const data = (value: JsonObject) => ({ body: { data: value } });
    const error = (message: string) => ({ body: { errors: [{ message }] } });
    const input = (variables.input ?? {}) as JsonObject;

    if (/\bviewer\b/.test(query)) return data({ viewer: { id: 'u-me', name: 'Dana Fake', email: 'dana@acme.example' } });
    if (/teams\(first: 100\)/.test(query)) return data({ teams: { nodes: this.teams } });
    if (/\bissues\(/.test(query)) {
      const page = this.page(this.issues, variables);
      // Like GraphQL, return only the selected fields that matter to a test: no needs unless asked for.
      if (!/needs\(/.test(query)) page.nodes = page.nodes.map(({ needs: _needs, ...rest }) => rest);
      return data({ issues: page });
    }
    if (/\bcomments\(filter/.test(query)) return data({ comments: this.page(this.comments, variables) });
    if (/\bprojectUpdates\(/.test(query)) return data({ projectUpdates: this.page(this.projectUpdates, variables) });
    if (/\bissue\(id/.test(query)) {
      const id = String(variables.id);
      const issue = this.issues.find((i) => i.id === id || i.identifier === id);
      return data({ issue: issue ?? null });
    }
    if (/\bcomment\(id/.test(query)) return data({ comment: this.comments.find((c) => c.id === variables.id) ?? null });
    if (/\bprojectUpdate\(id/.test(query)) return data({ projectUpdate: this.projectUpdates.find((c) => c.id === variables.id) ?? null });
    if (/\busers\(/.test(query)) {
      const rows = this.users.filter((u) => variables.includeDisabled === true || u.active !== false);
      return data({ users: this.page(rows.map((u) => ({ ...u, updatedAt: u.updatedAt ?? '2026-01-01T00:00:00.000Z' })), variables) });
    }
    if (/\bwebhook\(id/.test(query)) {
      const hook = this.webhooks.find((w) => w.id === variables.id);
      return hook ? data({ webhook: { id: hook.id, enabled: hook.enabled, url: hook.url } }) : error('Entity not found: Webhook');
    }
    if (/\bwebhookCreate\b/.test(query)) {
      if (!input.url || !Array.isArray(input.resourceTypes)) return error('Argument Validation Error');
      if (!input.teamId && input.allPublicTeams !== true) return error('teamId or allPublicTeams is required');
      const hook: FakeWebhook = {
        id: `wh-${this.nextId++}`,
        url: String(input.url),
        enabled: true,
        secret: String(input.secret ?? 'server-made-secret'),
        resourceTypes: input.resourceTypes as string[],
        allPublicTeams: input.allPublicTeams === true,
        teamId: (input.teamId as string | undefined) ?? null,
      };
      this.webhooks.push(hook);
      this.created.push({ kind: 'webhook', input });
      return data({ webhookCreate: { success: true, webhook: { id: hook.id, enabled: true, secret: hook.secret } } });
    }
    if (/\bwebhookDelete\b/.test(query)) {
      const at = this.webhooks.findIndex((w) => w.id === variables.id);
      if (at < 0) return error('Entity not found: Webhook');
      this.webhooks.splice(at, 1);
      return data({ webhookDelete: { success: true } });
    }
    if (/\bissueCreate\b/.test(query)) {
      this.created.push({ kind: 'issue', input });
      const n = this.nextId++;
      return data({ issueCreate: { success: true, issue: { id: `iss-new-${n}`, identifier: `ENG-${100 + n}`, title: input.title, url: `https://linear.app/acme/issue/ENG-${100 + n}` } } });
    }
    if (/\bcommentCreate\b/.test(query)) {
      this.created.push({ kind: 'comment', input });
      return data({ commentCreate: { success: true, comment: { id: `c-new-${this.nextId++}`, url: 'https://linear.app/acme/issue/ENG-1#comment-x', body: input.body, createdAt: '2026-11-12T12:00:00.000Z' } } });
    }
    if (/\battachmentCreate\b/.test(query)) {
      this.created.push({ kind: 'attachment', input });
      return data({ attachmentCreate: { success: true, attachment: { id: `a-new-${this.nextId++}`, url: input.url, title: input.title, subtitle: input.subtitle ?? null } } });
    }
    return error(`fake: unknown operation: ${query.slice(0, 60)}`);
  };
}

export async function startFakeLinear(fake: FakeLinear): Promise<FakeApi> {
  return startFakeApi(fake.handle);
}

/** An issue as the API returns it, `seconds` after 2026-11-12T10:00:00Z. */
export const issue = (n: number, seconds: number, extra: JsonObject = {}): JsonObject => ({
  id: `iss-${n}`,
  identifier: `ENG-${n}`,
  title: `Issue ${n}`,
  description: `Description of issue ${n}`,
  url: `https://linear.app/acme/issue/ENG-${n}/issue-${n}`,
  createdAt: new Date(Date.parse('2026-11-12T09:00:00Z')).toISOString(),
  updatedAt: new Date(Date.parse('2026-11-12T10:00:00Z') + seconds * 1000).toISOString(),
  priority: 2,
  state: { name: 'Todo', type: 'unstarted' },
  team: { key: 'ENG', name: 'Engineering' },
  project: { name: 'Export' },
  assignee: { email: 'lee@acme.example' },
  creator: { email: 'Dana@Acme.example' },
  labels: { nodes: [] },
  needs: { nodes: [] },
  comments: { nodes: [] },
  ...extra,
});
