/**
 * A fake Attio REST API (v2): self, objects, lists, records and entries with query filters (created_at and the stage's
 * active_from, limit/offset), workspace members, notes, tasks and webhooks. Fake tokens and data only.
 */
import type { JsonObject } from '@landflow/sdk';
import type { FakeReply, FakeRequest } from './helpers';

export const TOKEN = 'attio-fake-token';
export const WORKSPACE_ID = 'ws-0000-0000';
export const OBJECTS = { companies: '11111111-1111-4111-8111-000000000001', people: '11111111-1111-4111-8111-000000000002', deals: '11111111-1111-4111-8111-000000000003' } as const;
export const LIST_ID = '22222222-2222-4222-8222-000000000001';
export const LIST_SLUG = 'sales_pipeline';
export const MEMBER_ID = 'member-ana-0001';

const slugs = Object.fromEntries(Object.entries(OBJECTS).map(([slug, id]) => [id, slug]));

/** Attio-shaped value entries. */
export const text = (value: string, from = '2026-11-01T10:00:00.000000000Z', actor?: string): JsonObject => ({
  active_from: from,
  active_until: null,
  created_by_actor: actor ? { type: 'workspace-member', id: actor } : { type: 'system', id: null },
  attribute_type: 'text',
  value,
});
export const status = (title: string, from: string, actor?: string): JsonObject => ({
  active_from: from,
  active_until: null,
  created_by_actor: actor ? { type: 'workspace-member', id: actor } : { type: 'system', id: null },
  attribute_type: 'status',
  status: { id: { status_id: `st-${title}` }, title },
});
export const reference = (object: string, id: string, from = '2026-11-01T10:00:00.000000000Z'): JsonObject => ({
  active_from: from,
  active_until: null,
  attribute_type: 'record-reference',
  target_object: object,
  target_record_id: id,
});

export interface FakeRecord {
  object: keyof typeof OBJECTS;
  id: string;
  created_at: string;
  values: Record<string, JsonObject[]>;
}
export interface FakeEntry {
  id: string;
  parent_object: string;
  parent_record_id: string;
  created_at: string;
  entry_values: Record<string, JsonObject[]>;
}
export interface FakeHook {
  id: string;
  target_url: string;
  subscriptions: Array<{ event_type: string; filter: JsonObject | null }>;
  secret: string;
}

const error = (status_code: number, code: string, message: string): FakeReply => ({ status: status_code, body: { status_code, type: status_code === 401 ? 'auth_error' : 'invalid_request_error', code, message } });
const id = (kind: string, value: string): JsonObject => ({ workspace_id: WORKSPACE_ID, [kind]: value });

export class FakeAttio {
  records: FakeRecord[] = [];
  entries: FakeEntry[] = [];
  members: JsonObject[] = [
    { id: { workspace_id: WORKSPACE_ID, workspace_member_id: MEMBER_ID }, first_name: 'Ana', last_name: 'Silva', email_address: 'Ana@Acme.example', access_level: 'admin', created_at: '2026-01-01T00:00:00.000000000Z', avatar_url: null },
    { id: { workspace_id: WORKSPACE_ID, workspace_member_id: 'member-ben-0001' }, first_name: 'Ben', last_name: 'Lee', email_address: 'ben@acme.example', access_level: 'member', created_at: '2026-02-01T00:00:00.000000000Z', avatar_url: null },
  ];
  notes: JsonObject[] = [];
  tasks: JsonObject[] = [];
  hooks: FakeHook[] = [];
  private hookCount = 0;
  /** Statuses to force on the next call to a path (for error tests). */
  fail = new Map<string, FakeReply>();

  seed() {
    this.records = [
      { object: 'companies', id: 'r-acme', created_at: '2026-10-01T09:00:00.000000000Z', values: { name: [text('Acme Inc', '2026-10-01T09:00:00.000000000Z')] } },
      { object: 'people', id: 'r-pat', created_at: '2026-10-02T09:00:00.000000000Z', values: { name: [{ ...text(''), attribute_type: 'personal-name', full_name: 'Pat Doe', active_from: '2026-10-02T09:00:00.000000000Z' }], company: [reference('companies', 'r-acme')] } },
      {
        object: 'deals',
        id: 'r-renewal',
        created_at: '2026-10-05T09:00:00.000000000Z',
        values: { name: [text('Acme renewal', '2026-10-05T09:00:00.000000000Z')], stage: [status('Won 🎉', '2026-11-10T12:00:00.000000000Z', MEMBER_ID)], associated_company: [reference('companies', 'r-acme')] },
      },
      {
        object: 'deals',
        id: 'r-pilot',
        created_at: '2026-11-11T09:00:00.000000000Z',
        values: { name: [text('Globex pilot', '2026-11-11T09:00:00.000000000Z')], stage: [status('In Progress', '2026-11-11T09:00:00.000000000Z')], associated_company: [reference('companies', 'r-acme')] },
      },
    ];
    this.entries = [
      {
        id: 'e-renewal',
        parent_object: 'deals',
        parent_record_id: 'r-renewal',
        created_at: '2026-10-06T09:00:00.000000000Z',
        entry_values: { stage: [status('Won', '2026-11-10T12:00:00.000000000Z', MEMBER_ID)] },
      },
      {
        id: 'e-pilot',
        parent_object: 'deals',
        parent_record_id: 'r-pilot',
        created_at: '2026-11-11T09:30:00.000000000Z',
        entry_values: { stage: [status('Proposal', '2026-11-11T09:30:00.000000000Z')] },
      },
    ];
    this.notes = [
      {
        id: id('note_id', 'n-1'),
        parent_object: 'deals',
        parent_record_id: 'r-renewal',
        title: 'Call recap',
        content_plaintext: 'Signed for two years; wants SSO.',
        content_markdown: 'Signed for two years; wants SSO.',
        created_by_actor: { type: 'workspace-member', id: MEMBER_ID },
        created_at: '2026-11-10T13:00:00.000000000Z',
      },
    ];
    this.tasks = [
      {
        id: id('task_id', 't-1'),
        content_plaintext: 'Send the SSO docs',
        deadline_at: '2026-11-20T09:00:00.000000000Z',
        is_completed: false,
        completed_at: null,
        linked_records: [{ target_object_id: OBJECTS.people, target_record_id: 'r-pat' }],
        assignees: [],
        created_by_actor: { type: 'workspace-member', id: MEMBER_ID },
        created_at: '2026-11-11T08:00:00.000000000Z',
      },
    ];
    this.hooks = [];
    this.hookCount = 0;
    this.fail.clear();
    return this;
  }

  private shape(record: FakeRecord): JsonObject {
    return { id: { ...id('object_id', OBJECTS[record.object]), record_id: record.id }, created_at: record.created_at, web_url: `https://app.attio.com/acme/${record.object}/${record.id}`, values: record.values };
  }
  private shapeEntry(entry: FakeEntry): JsonObject {
    return { id: { workspace_id: WORKSPACE_ID, list_id: LIST_ID, entry_id: entry.id }, parent_record_id: entry.parent_record_id, parent_object: entry.parent_object, created_at: entry.created_at, entry_values: entry.entry_values };
  }

  /** Does a row pass a created_at / stage.active_from filter? */
  private passes(row: { created_at: string; values: Record<string, JsonObject[]> }, filter: any): boolean {
    if (!filter) return true;
    const createdGte = filter.created_at?.$gte;
    if (createdGte && !(Date.parse(row.created_at) >= Date.parse(createdGte))) return false;
    const stageGte = filter.stage?.active_from?.$gte;
    if (stageGte) {
      const from = Date.parse(String(row.values.stage?.[0]?.active_from ?? ''));
      if (!(from >= Date.parse(stageGte))) return false;
    }
    return true;
  }

  handle = (req: FakeRequest): FakeReply => {
    const forced = this.fail.get(`${req.method} ${req.path}`);
    if (forced) {
      this.fail.delete(`${req.method} ${req.path}`);
      return forced;
    }
    if (req.path === '/v2/self' && req.headers.authorization !== `Bearer ${TOKEN}`) return { body: { active: false } };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return error(401, 'unauthorized', 'Invalid token');
    const p = req.path.replace(/^\/v2/, '');
    const parts = p.split('/').filter(Boolean);
    const q = req.query;
    const limit = Number(q.get('limit') ?? req.body?.limit ?? 500);
    const offset = Number(q.get('offset') ?? req.body?.offset ?? 0);
    const page = <T>(rows: T[]) => rows.slice(offset, offset + limit);

    if (p === '/self') {
      return { body: { active: true, scope: 'record_permission:read note:read-write', token_type: 'Bearer', exp: null, token_level: 'workspace', workspace_id: WORKSPACE_ID, workspace_name: 'Acme CRM', workspace_slug: 'acme' } };
    }
    if (parts[0] === 'webhooks') {
      if (req.method === 'POST' && parts.length === 1) {
        const data = req.body?.data;
        if (!/^https:\/\//.test(String(data?.target_url ?? ''))) return error(400, 'validation_type', 'target_url must be an https URL');
        const key = (h: FakeHook) => `${h.target_url}|${h.subscriptions.map((s) => s.event_type).sort().join(',')}`;
        const hook: FakeHook = { id: `wh-${++this.hookCount}`, target_url: data.target_url, subscriptions: data.subscriptions, secret: `whsec-${this.hookCount}` };
        if (this.hooks.some((h) => key(h) === key(hook))) return error(409, 'uniqueness_conflict', 'A webhook with this URL and subscriptions already exists');
        this.hooks.push(hook);
        return { body: { data: { id: { workspace_id: WORKSPACE_ID, webhook_id: hook.id }, target_url: hook.target_url, subscriptions: hook.subscriptions, status: 'active', created_at: '2026-11-12T00:00:00.000000000Z', secret: hook.secret } } };
      }
      const hook = this.hooks.find((h) => h.id === parts[1]);
      if (!hook) return error(404, 'not_found', 'Webhook not found');
      if (req.method === 'DELETE') {
        this.hooks = this.hooks.filter((h) => h !== hook);
        return { body: {} };
      }
      return { body: { data: { id: { workspace_id: WORKSPACE_ID, webhook_id: hook.id }, target_url: hook.target_url, subscriptions: hook.subscriptions, status: 'active', created_at: '2026-11-12T00:00:00.000000000Z' } } };
    }
    if (parts[0] === 'objects') {
      const object = slugs[parts[1]] ?? parts[1];
      if (parts.length === 2) return object in OBJECTS ? { body: { data: { id: id('object_id', OBJECTS[object as keyof typeof OBJECTS]), api_slug: object } } } : error(404, 'not_found', 'Object not found');
      if (parts[2] !== 'records') return error(404, 'not_found', 'no route');
      if (parts[3] === 'query') {
        const rows = this.records.filter((r) => r.object === object && this.passes(r, req.body?.filter));
        return { body: { data: page(rows).map((r) => this.shape(r)) } };
      }
      const record = this.records.find((r) => r.object === object && r.id === parts[3]);
      return record ? { body: { data: this.shape(record) } } : error(404, 'not_found', 'Record not found');
    }
    if (parts[0] === 'lists') {
      if (parts[1] !== LIST_ID && parts[1] !== LIST_SLUG) return error(404, 'not_found', 'List not found');
      if (parts.length === 2) return { body: { data: { id: id('list_id', LIST_ID), api_slug: LIST_SLUG, name: 'Sales pipeline', parent_object: ['deals'] } } };
      if (parts[3] === 'query') {
        const rows = this.entries.filter((e) => this.passes({ created_at: e.created_at, values: e.entry_values }, req.body?.filter));
        return { body: { data: page(rows).map((e) => this.shapeEntry(e)) } };
      }
      if (req.method === 'POST' && parts.length === 3) {
        const data = req.body?.data;
        const entry: FakeEntry = { id: `e-new-${this.entries.length}`, parent_object: data.parent_object, parent_record_id: data.parent_record_id, created_at: '2026-11-12T10:00:00.000000000Z', entry_values: {} };
        this.entries.push(entry);
        return { body: { data: this.shapeEntry(entry) } };
      }
      const entry = this.entries.find((e) => e.id === parts[3]);
      return entry ? { body: { data: this.shapeEntry(entry) } } : error(404, 'not_found', 'Entry not found');
    }
    if (p === '/workspace_members') return { body: { data: this.members } };
    if (parts[0] === 'notes') {
      if (req.method === 'POST') {
        const data = req.body?.data;
        const note = { id: id('note_id', `n-${this.notes.length + 1}`), parent_object: data.parent_object, parent_record_id: data.parent_record_id, title: data.title, content_plaintext: data.content, content_markdown: data.content, created_by_actor: { type: 'api-token', id: 'tok' }, created_at: '2026-11-12T10:00:00.000000000Z' };
        this.notes.push(note);
        return { body: { data: note } };
      }
      if (parts.length === 1) return { body: { data: page(this.notes.filter((n) => (!q.get('parent_record_id') || n.parent_record_id === q.get('parent_record_id')) && (!q.get('parent_object') || n.parent_object === q.get('parent_object'))).slice(0, 50)) } };
      const note = this.notes.find((n) => (n.id as JsonObject).note_id === parts[1]);
      return note ? { body: { data: note } } : error(404, 'not_found', 'Note not found');
    }
    if (parts[0] === 'tasks') {
      if (req.method === 'POST') {
        const data = req.body?.data;
        const task = { id: id('task_id', `t-${this.tasks.length + 1}`), content_plaintext: data.content, deadline_at: data.deadline_at, is_completed: data.is_completed, completed_at: null, linked_records: [], assignees: [], created_by_actor: { type: 'api-token', id: 'tok' }, created_at: '2026-11-12T10:00:00.000000000Z' };
        this.tasks.push(task);
        return { body: { data: task } };
      }
      const task = this.tasks.find((t) => (t.id as JsonObject).task_id === parts[1]);
      return task ? { body: { data: task } } : error(404, 'not_found', 'Task not found');
    }
    return error(404, 'not_found', `no route ${req.method} ${req.path}`);
  };
}
