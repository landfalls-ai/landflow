// @vitest-environment happy-dom
/**
 * NB07: the project's Brain card, the Brain page's chip, "Open in Notion", "Your notes", the Notion sync problems and the
 * knowledge option, in happy-dom with a stubbed fetch that answers with the contract's shapes. Real components; the keys are
 * made-up: the marker secret is built at run time (no key-shaped literal in this file).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/brain', useSearchParams: () => new URLSearchParams() }));

const { BrainCard } = await import('@/components/projects/brain-card');
const { NotionChip, NotionProblems, chipText } = await import('@/components/brain/wiki/notion-status');
const { PageDoc } = await import('@/components/brain/wiki/page-doc');
const { statusItems } = await import('@/components/brain/wiki/workbench');
const { ProjectAgentSettingsView } = await import('@/components/projects/project-agent-settings');
const { useCredentialStore } = await import('@/components/credentials/use-credentials');
const { NEVER_PUSHED } = await import('@/lib/shared/notion-brain');
const { BACKGROUND_HEADER } = await import('@/lib/shared/auth');

const P = 'proj_1';
const BASE = `/api/projects/${P}/brain/notion`;
const NOW = Date.now();
const key = { id: 'cred_1', name: 'Acme Notion', type: 'productivity.notionApi' };
const notionType = {
  type: 'productivity.notionApi',
  pluginId: 'productivity',
  pluginName: 'Productivity',
  available: true,
  nodeTypes: ['productivity.notion'],
  descriptor: { name: 'notionApi', displayName: 'Notion API', testable: true, properties: [{ name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } }, { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' }] },
};
const link = (over: Record<string, unknown> = {}) => ({
  linked: true,
  id: 'nbl_1',
  projectId: P,
  status: 'active',
  credential: { id: key.id, name: key.name },
  rootPageId: 'root-id',
  rootUrl: 'https://www.notion.so/rootid',
  rootTitle: 'Acme wiki',
  brainPageId: 'brain-id',
  brainUrl: 'https://www.notion.so/brainid',
  workspaceName: 'Acme',
  botName: 'Landflow',
  knowledgeScope: 'brain',
  rps: 2,
  waiting: 0,
  problems: 0,
  lastPushAt: new Date(NOW - 2 * 60_000).toISOString(),
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  canManage: true,
  ...over,
});
const checkAnswer = { title: 'Acme wiki', url: 'https://www.notion.so/rootid', workspaceName: 'Acme', botName: 'Landflow', existingBrain: { found: false }, counts: { pages: 14, facts: 16, practices: 2, notes: 3 }, estimateMinutes: 2 };

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  background: boolean;
}
let calls: Call[];
let container: HTMLDivElement;
let root: Root;
let current: Record<string, unknown>;
let keys: Array<typeof key>;
let problems: Array<Record<string, unknown>>;
let checkReply: { status: number; body: unknown };
let types: unknown[];

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  calls = [];
  current = { linked: false, canManage: true };
  keys = [key];
  problems = [];
  types = [notionType];
  checkReply = { status: 200, body: checkAnswer };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useCredentialStore.setState({ credentials: undefined, types: undefined } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, path: url.pathname + url.search, body, background: headers[BACKGROUND_HEADER] === '1' });
      const path = url.pathname;
      if (path === BASE && method === 'GET') return reply(200, current);
      if (path === `${BASE}/problems` && method === 'GET') return reply(200, problems);
      if (path === `${BASE}/check`) return reply(checkReply.status, checkReply.body);
      if (path === BASE && method === 'POST') return reply(202, link({ status: 'setting_up' }));
      if (path === BASE && method === 'PATCH') return reply(200, link(body?.credentialId ? { status: 'active', credential: { id: String(body.credentialId), name: 'Second key' } } : {}));
      if (path === BASE && method === 'DELETE') {
        current = { linked: false, canManage: true };
        return reply(200, { ok: true, linked: false, message: 'Disconnected.' });
      }
      if (path === `${BASE}/sync`) return reply(202, link());
      if (path.startsWith(`${BASE}/problems/`)) return reply(200, { id: 'x', resolved: true, action: body?.action });
      if (path === '/api/credentials' && method === 'POST') return reply(200, { credential: { ...key, id: 'cred_new', name: 'Notion API account', data: body?.data ?? {}, secrets: ['apiKey'], usedBy: [], usedByAgents: [] } });
      if (path === '/api/credentials/test') return reply(200, { ok: true, message: 'Authenticated as Landflow' });
      if (path === '/api/credentials') return reply(200, { credentials: url.search ? keys : keys });
      if (path === '/api/credential-types') return reply(200, { types });
      return reply(404, { error: `unexpected ${method} ${path}` });
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const mount = async (element: ReturnType<typeof createElement>) => {
  await act(async () => root.render(element));
  await settle();
};
const card = (canEdit = false) => mount(createElement(BrainCard, { projectId: P, canEdit }));
const text = () => document.body.textContent ?? '';
const button = (label: string | RegExp) => [...document.body.querySelectorAll('button')].find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')));
const click = async (label: string | RegExp) => {
  const b = button(label);
  if (!b) throw new Error(`no button ${String(label)} in: ${text()}`);
  await act(async () => b.click());
  await settle();
};
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const pick = async (name: string, value: string) => {
  const el = document.body.querySelector(`select[aria-label="${name}"]`) as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const toNotion = async () => {
  await click('Notion');
};

describe('an admin with no link', () => {
  it('sees where the brain lives: Landflow, with Notion one click away', async () => {
    await card(true);
    expect(text()).toContain('Where this project’s brain lives');
    expect(text()).toContain('Lives in Landflow');
    expect(button('Landflow')).toBeTruthy();
    expect(button('Notion')).toBeTruthy();
    expect(button('Connect and copy')).toBeUndefined();
  });

  it('Notion shows the key list by name, with the only key picked, and the help line', async () => {
    await card();
    await toNotion();
    const select = document.body.querySelector('select[aria-label="Notion key"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a key…', 'Acme Notion']);
    expect(select.value).toBe(key.id);
    expect(text()).toContain('a workspace owner makes a connection with Read, Update and Insert content');
    expect(calls.some((c) => c.path === `/api/credentials?projectId=${P}`)).toBe(true);
  });

  it('with two keys picks none; with the plugin offline says how to start it and still lists the keys', async () => {
    keys = [key, { id: 'cred_2', name: 'Other Notion', type: 'productivity.notionOAuth2Api' }];
    types = [{ ...notionType, available: false }];
    await card();
    await toNotion();
    const select = document.body.querySelector('select[aria-label="Notion key"]') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a key…', 'Acme Notion', 'Other Notion']);
    expect(text()).toContain('Start the productivity plugin to add a Notion key');
    expect((button(/New Notion key/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('New Notion key opens the credential dialog for productivity.notionApi, and a typed secret is in no state or DOM after save', async () => {
    const secret = ['ntn', 'a'.repeat(8), 'marker', String(Date.now())].join('_');
    await card();
    await toNotion();
    await click(/New Notion key/);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('Notion API');
    const field = dialog!.querySelector('input[type="password"]') as HTMLInputElement;
    expect(field).toBeTruthy();
    await type(field, secret);
    expect(field.value).toBe(secret);
    await click('Create');
    // The dialog is gone with its copy of the secret; the card holds the key's id and name only.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(secret);
    expect([...document.body.querySelectorAll('input')].some((i) => i.value.includes(secret))).toBe(false);
    const post = calls.find((c) => c.method === 'POST' && c.path === `/api/credentials?projectId=${P}`);
    expect(post?.body).toMatchObject({ type: 'productivity.notionApi' });
    expect(calls.filter((c) => c.method === 'GET').every((c) => !c.path.includes(secret))).toBe(true);
  });

  it('a page that is not shared shows the Add connections words and no Connect', async () => {
    checkReply = { status: 404, body: { error: 'Landflow can’t see this page: open it in Notion → ••• → Add connections → Landflow' } };
    await card();
    await toNotion();
    await type(document.body.querySelector('input[aria-label="Notion page"]') as HTMLInputElement, 'https://www.notion.so/Acme-wiki-0123456789abcdef0123456789abcdef');
    await click('Check');
    expect(text()).toContain('Add connections');
    expect(button('Connect and copy')).toBeUndefined();
  });

  it('a good page shows its title, the counts, what never leaves and the estimate; Connect posts the choice and polls', async () => {
    await card();
    await toNotion();
    const page = 'https://www.notion.so/Acme-wiki-0123456789abcdef0123456789abcdef';
    await type(document.body.querySelector('input[aria-label="Notion page"]') as HTMLInputElement, page);
    await click('Check');
    expect(sent('POST', `${BASE}/check`)[0].body).toEqual({ credentialId: key.id, page });
    const t = text();
    expect(t).toContain('Acme wiki');
    expect(t).toContain('14 pages, 16 facts, 2 practices, 3 notes');
    expect(t).toContain(NEVER_PUSHED);
    expect(t).toContain('about 2 minutes');
    expect(t).toContain('Pages you add under Landflow brain');
    expect(t).toContain('Every page under Acme wiki');
    await act(async () => (document.body.querySelector('[data-testid="scope-root"]') as HTMLInputElement).click());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    current = link({ status: 'copying', copy: { phase: 'rows', done: 120, total: 300 } });
    await click('Connect and copy');
    expect(sent('POST', BASE)[0].body).toEqual({ credentialId: key.id, page, knowledgeScope: 'root' });
    expect(text()).toContain('Copying the pages · 120 of 300');
    expect(text()).toContain('You can leave this page');
    const before = sent('GET', BASE).length;
    await act(async () => { vi.advanceTimersByTime(3_100); });
    await settle();
    const after = sent('GET', BASE);
    expect(after.length).toBeGreaterThan(before);
    expect(after.at(-1)!.background).toBe(true);
    // Hidden tabs poll nothing.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const hiddenAt = sent('GET', BASE).length;
    await act(async () => { vi.advanceTimersByTime(9_000); });
    expect(sent('GET', BASE).length).toBe(hiddenAt);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
});

describe('a linked project', () => {
  it('active: the status, Open in Notion, Sync now, Pause, the speed and Disconnect, which confirms first', async () => {
    current = link();
    await card();
    expect(text()).toContain('In sync · synced 2 minutes ago · 0 waiting · 0 problems');
    const open = [...document.body.querySelectorAll('a')].find((a) => a.textContent?.includes('Open in Notion'));
    expect(open?.getAttribute('href')).toBe('https://www.notion.so/brainid');
    expect(button('Sync now')).toBeTruthy();
    expect(button('Pause')).toBeTruthy();
    expect(text()).toContain('8 if your Notion is on Business or Enterprise');
    await click('Sync now');
    expect(sent('POST', `${BASE}/sync`)).toHaveLength(1);
    await click('Pause');
    expect(sent('PATCH', BASE)[0].body).toEqual({ paused: true });
    await pick('Requests a second', '8');
    expect(sent('PATCH', BASE)[1].body).toEqual({ rps: 8 });
    // Disconnect asks first.
    await click('Disconnect');
    expect(sent('DELETE', BASE)).toHaveLength(0);
    expect(text()).toContain('Landflow stops syncing. Your Notion pages stay as they are, and the brain stays in Landflow.');
    await click('Keep it');
    expect(sent('DELETE', BASE)).toHaveLength(0);
    await click('Disconnect');
    const confirm = document.body.querySelector('[data-testid="notion-disconnect-confirm"]')!;
    await act(async () => ([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Disconnect') as HTMLButtonElement).click());
    await settle();
    expect(sent('DELETE', BASE)).toHaveLength(1);
    expect(text()).toContain('Lives in Landflow');
  });

  it('paused offers Resume', async () => {
    current = link({ status: 'paused', reason: 'Paused by an admin' });
    await card();
    expect(text()).toContain('Nothing syncs while it is paused');
    await click('Resume');
    expect(sent('PATCH', BASE)[0].body).toEqual({ paused: false });
  });

  it('unauthorized offers Pick another key, which shows the keys and PATCHes credentialId', async () => {
    current = link({ status: 'unauthorized', reason: 'Notion refused the key' });
    keys = [key, { id: 'cred_2', name: 'Second key', type: 'productivity.notionApi' }];
    await card();
    expect(text()).toContain('Notion refused the key');
    await click('Pick another key');
    expect(document.body.querySelector('[data-testid="notion-pick-key"]')).toBeTruthy();
    expect(button(/New Notion key/)).toBeTruthy();
    await pick('Notion key', 'cred_2');
    await click('Use this key');
    expect(sent('PATCH', BASE)[0].body).toEqual({ credentialId: 'cred_2' });
    await click('Check again');
    expect(sent('PATCH', BASE)[1].body).toEqual({ paused: false });
  });

  it('unshared offers Check again', async () => {
    current = link({ status: 'unshared', reason: 'Share the page again' });
    await card();
    expect(text()).toContain('share it with the connection again');
    await click('Check again');
    expect(sent('PATCH', BASE)[0].body).toEqual({ paused: false });
  });

  it('needs_repair offers Repair, which resolves the schema_changed problem', async () => {
    current = link({ status: 'needs_repair', reason: 'A property was removed', problems: 1 });
    problems = [{ id: 'nbp_1', kind: 'schema_changed', detail: 'A property was removed.', at: new Date().toISOString(), actions: ['dismiss', 'repair'] }];
    await card();
    const fix = document.body.querySelector('[data-testid="notion-fix"]')!;
    await act(async () => ([...fix.querySelectorAll('button')].find((b) => b.textContent === 'Repair') as HTMLButtonElement).click());
    await settle();
    expect(sent('POST', `${BASE}/problems/nbp_1`)[0].body).toEqual({ action: 'repair' });
  });

  it('shows the link’s problems with the buttons an editor may press, never an admin one', async () => {
    current = link({ problems: 2, canManage: false });
    problems = [
      { id: 'nbp_1', kind: 'trashed_in_notion', notionUrl: 'https://www.notion.so/rowid', detail: 'A page was deleted in Notion.', at: new Date().toISOString(), actions: ['dismiss', 'putBack', 'deleteLocal'] },
      { id: 'nbp_2', kind: 'landflow_part_edited', detail: 'A person changed the page.', at: new Date().toISOString(), actions: ['dismiss', 'keepAsFact'] },
    ];
    await card(true);
    expect(button('Put back')).toBeTruthy();
    expect(button('Keep as a fact')).toBeTruthy();
    expect(button('Delete in Landflow')).toBeUndefined();
    await click('Put back');
    expect(sent('POST', `${BASE}/problems/nbp_1`)[0].body).toEqual({ action: 'putBack' });
  });

  it('a member sees the status line and the link, and nothing to change', async () => {
    current = link({ canManage: false });
    await card(false);
    expect(text()).toContain('In sync · synced 2 minutes ago');
    expect([...document.body.querySelectorAll('a')].some((a) => a.textContent?.includes('Open in Notion'))).toBe(true);
    for (const label of ['Sync now', 'Pause', 'Disconnect', 'Check', 'Connect and copy']) expect(button(label)).toBeUndefined();
    expect(document.body.querySelector('select')).toBeNull();
    expect(document.body.querySelector('input')).toBeNull();
    // An unlinked project a member sees: where it lives, and nothing else.
    current = { linked: false, canManage: false };
    await act(async () => root.render(createElement(BrainCard, { projectId: 'other' })));
    expect(button('Notion')).toBeUndefined();
  });

  it('on a phone every button and the key and page fields are 44 px tall behind md, and nothing is a fixed width', async () => {
    await card();
    await toNotion();
    for (const b of document.body.querySelectorAll('button')) {
      if (['Landflow', 'Notion'].includes(b.textContent ?? '')) continue; // the Segmented control sizes itself
      expect(b.className, b.textContent ?? '').toContain('max-md:min-h-11');
    }
    expect((document.body.querySelector('select[aria-label="Notion key"]') as HTMLElement).className).toContain('max-md:h-11');
    expect((document.body.querySelector('input[aria-label="Notion page"]') as HTMLElement).className).toContain('max-md:h-11');
    expect(container.innerHTML).not.toMatch(/(?<![-\w])w-\[[0-9]{3,}px\]/);
  });
});

describe('the Brain page', () => {
  const view = (over: Record<string, unknown> = {}) => link(over) as never;

  it('the chip says how it syncs, in the status’s tone: amber for problems, red for a refused key', async () => {
    await mount(createElement(NotionChip, { view: view({ problems: 1 }) }));
    const chip = document.body.querySelector('[data-testid="notion-chip"]')!;
    expect(chip.textContent).toContain('In Notion');
    expect(chip.textContent).toContain('synced 2 minutes ago');
    expect(chip.getAttribute('data-tone')).toBe('warning');
    await mount(createElement(NotionChip, { view: view({ status: 'unauthorized', reason: 'Notion refused the key' }) }));
    expect(document.body.querySelector('[data-testid="notion-chip"]')!.getAttribute('data-tone')).toBe('danger');
    await mount(createElement(NotionChip, { view: undefined }));
    expect(document.body.querySelector('[data-testid="notion-chip"]')).toBeNull();
    expect(chipText(view({ status: 'paused', reason: 'Paused by an admin' }))).toBe('Paused · Paused by an admin');
  });

  it('the Problems panel’s Notion sync group lists the two problems with their actions, and the status bar adds them', async () => {
    const two = [
      { id: 'nbp_1', kind: 'trashed_in_notion', notionUrl: 'https://www.notion.so/rowid', detail: 'A page was deleted in Notion.', at: 'x', actions: ['dismiss', 'putBack', 'deleteLocal'] },
      { id: 'nbp_2', kind: 'landflow_part_edited', detail: 'A person changed the page.', at: 'x', actions: ['dismiss', 'keepAsFact'] },
    ];
    await mount(createElement(NotionProblems, { projectId: P, problems: two as never, viewer: { canEdit: true, canManage: false }, onChanged: () => {} }));
    expect(document.body.querySelectorAll('[data-testid="notion-sync-problem"]')).toHaveLength(2);
    expect(text()).toContain('Notion sync');
    expect(button('Put back')).toBeTruthy();
    expect(button('Delete in Landflow')).toBeUndefined();
    expect([...document.body.querySelectorAll('a')].find((a) => a.textContent?.includes('Open in Notion'))?.getAttribute('href')).toBe('https://www.notion.so/rowid');
    expect(statusItems(14, 0 + two.length)).toEqual(['14 pages', '2 problems']);
    await mount(createElement(NotionProblems, { projectId: P, problems: [], viewer: { canEdit: true, canManage: true }, onChanged: () => {} }));
    expect(document.body.querySelector('[data-testid="notion-sync-group"]')).toBeNull();
  });

  const wiki = (extra: Record<string, unknown> = {}) =>
    ({
      entity: { type: 'customer', id: 'kestrel-bank', name: 'Kestrel Bank', attrs: {}, source: 'ui', createdAt: 'x', updatedAt: 'x', projectId: P },
      facts: [],
      proposals: [],
      work: [],
      people: [],
      related: [],
      teams: [],
      mentionedIn: [],
      canEdit: true,
      ...extra,
    }) as never;

  it('a mapped page has Open in Notion, "Your notes" as text, and the “changed in Notion” line; an unmapped one has none', async () => {
    const notes = 'Pays on the 5th <script>window.pwned = 1</script>';
    await mount(createElement(PageDoc, { page: wiki({ notion: { url: 'https://www.notion.so/rowid', notes }, changedInNotion: { by: 'Ana Ruiz', at: new Date().toISOString() } }), onChanged: () => {}, onSummary: () => {} }));
    const open = document.body.querySelector('[data-testid="open-in-notion"]') as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe('https://www.notion.so/rowid');
    const mine = document.body.querySelector('[data-testid="your-notes"]')!;
    expect(mine.textContent).toContain('Your notes (from Notion)');
    expect(mine.textContent).toContain(notes);
    expect(mine.querySelector('script')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(text()).toContain('Changed in Notion by Ana Ruiz, replacing your edit');
    await mount(createElement(PageDoc, { page: wiki(), onChanged: () => {}, onSummary: () => {} }));
    expect(document.body.querySelector('[data-testid="open-in-notion"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="your-notes"]')).toBeNull();
    expect(text()).not.toContain('Changed in Notion');
  });
});

describe('the project’s knowledge choice', () => {
  const state = { canEdit: true, available: [], form: { agents: { mode: 'off', ids: [] }, agentTools: { mode: 'off', kinds: [] } } } as never;
  const render = (notionActive: boolean, onForm = vi.fn()) =>
    mount(createElement(ProjectAgentSettingsView, { state, form: (state as { form: never }).form, saved: (state as { form: never }).form, onForm, notionActive }));

  it('offers the project’s Notion brain only with an active link, and picking it sets { source: "notion-brain" }', async () => {
    await render(false);
    expect(button('This project’s Notion brain')).toBeUndefined();
    expect(button('Choose…')).toBeTruthy();
    const onForm = vi.fn();
    await render(true, onForm);
    expect(button('Choose…')).toBeTruthy();
    await click('This project’s Notion brain');
    expect(onForm).toHaveBeenCalledTimes(1);
    expect(onForm.mock.calls[0][0].knowledge).toMatchObject({ enabled: true, tool: { source: 'notion-brain', type: 'knowledge' } });
  });
});

describe('the Governance card is untouched', () => {
  it('its code is the base’s, byte for byte (the Brain card is mounted beside it, never in it)', () => {
    const source = readFileSync(join(__dirname, '..', 'src/components/projects/project-page.tsx'), 'utf8');
    const start = source.indexOf('function GovernanceCard');
    const block = source.slice(start, source.indexOf('\n}\n', start) + 3);
    expect(createHash('sha256').update(block).digest('hex').slice(0, 16)).toBe('2e45c097413c5c6a');
    expect(source.match(/<BrainCard /g)).toHaveLength(2);
    expect(source.indexOf('<BrainCard ')).toBeGreaterThan(source.indexOf('<GovernanceCard '));
  });

  it('the browser modules keep zod out', () => {
    for (const file of ['src/lib/client/notion-brain.ts', 'src/components/projects/brain-card.tsx', 'src/components/brain/wiki/notion-status.tsx']) {
      expect(readFileSync(join(__dirname, '..', file), 'utf8'), file).not.toMatch(/from 'zod'/);
    }
    for (const [contract, file] of [['notion-brain-client.ts', 'src/lib/client/notion-brain.ts'], ['notion-urls.ts', 'src/lib/server/brain/notion/urls.ts'], ['notion-brain.ts', 'src/lib/shared/notion-brain.ts']]) {
      const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS;
      if (dir) expect(readFileSync(join(__dirname, '..', file), 'utf8')).toBe(readFileSync(join(dir, 'nb', contract), 'utf8'));
    }
  });
});
