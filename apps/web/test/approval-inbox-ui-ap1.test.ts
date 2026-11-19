// @vitest-environment happy-dom
/**
 * AP03 (wave ap1): the approver's view of the approval inbox in happy-dom: Home's panel, the Needs you list's InboxRow, the Run
 * Trace card, the publish lines and the agent page's session line. The routes are a stubbed fetch with made-up data (the server
 * half is AP01's); every check fails on the base, which has none of these components.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRequestView } from '../src/lib/shared/approval-inbox';
import { closedAnswer, MASK, settledLine, waitingLine } from '../src/lib/shared/approval-inbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ApprovalInboxPanel } = await import('../src/components/home/approval-inbox');
const { inboxClock, resetApprovalInboxClient } = await import('../src/lib/client/approval-inbox');
const { NeedsYouList } = await import('../src/components/run-trace/run-lists');
const { ApprovalCard } = await import('../src/components/run-trace/approval-card');
const { UnattendedLines } = await import('../src/components/editor/spotlight/unattended-line');
const { TimelineView } = await import('../src/components/agents/timeline');
const { foldJournal } = await import('../src/lib/shared/run-trace-model');

const iso = (minute: number) => new Date(Date.UTC(2026, 10, 19, 14, minute)).toISOString();
const view = (over: Partial<InboxRequestView> = {}): InboxRequestView => ({
  id: 'req1',
  executionId: 'ex1',
  callId: 'call1',
  workflowId: 'wf1',
  workflowName: 'Alert intake',
  workflowVersion: 4,
  nodeId: 'n1',
  nodeName: 'Agent',
  agentId: 'ag1',
  agentName: 'Alert mailer',
  agentVersion: 2,
  tool: 'Send Email',
  params: { to: 'oncall@landflow.test', subject: 'Disk on db-1', smtpPassword: 'hunter2-not-masked', headers: { 'x-api-key': 'k-123456' } },
  destination: 'oncall@landflow.test',
  trigger: 'webhook',
  status: 'waiting',
  requestedAt: iso(2),
  expiresAt: iso(12),
  canDecide: true,
  ...over,
});

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; url: string }>;
let routes: { list: InboxRequestView[]; byId: Record<string, InboxRequestView>; decide: (url: string) => Response | Promise<Response>; needsYou: unknown[] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  resetApprovalInboxClient();
  vi.stubGlobal('EventSource', class { onopen = null; onmessage = null; onerror = null; close() {} addEventListener() {} });
  calls = [];
  routes = {
    list: [],
    byId: {},
    decide: () => json(view({ status: 'approved', decidedByName: 'Owner', decidedVia: 'inbox', decidedAt: iso(5) })),
    needsYou: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ method, url: path });
      if (method === 'POST' && /\/api\/approval-inbox\/[^/]+\/(approve|deny)/.test(path)) return routes.decide(path);
      if (path.startsWith('/api/approval-inbox/')) {
        const found = routes.byId[decodeURIComponent(path.split('/')[3].split('?')[0])];
        return found ? json(found) : json({ error: 'Not found' }, 404);
      }
      if (path.startsWith('/api/approval-inbox')) return json(path.includes('executionId=') ? routes.list.filter((r) => path.includes(`executionId=${r.executionId}`)) : routes.list);
      if (path.startsWith('/api/runs/needs-you')) return json({ items: routes.needsYou });
      return json({});
    }),
  );
  window.history.pushState({}, '', '/');
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const mount = async (element: Parameters<Root['render']>[0]) => {
  await act(async () => root.render(element));
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
};
const button = (label: RegExp, scope: ParentNode = document.body) => [...scope.querySelectorAll('button')].find((b) => label.test((b.textContent ?? '').trim()));
const click = async (target: Element | undefined) => {
  expect(target).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const posts = () => calls.filter((c) => c.method === 'POST');

describe("Home's approvals panel", () => {
  it('renders nothing when no request waits', async () => {
    await mount(createElement(ApprovalInboxPanel));
    expect(host.querySelector('[data-testid="approval-inbox"]')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('a row says the tool, agent vN, workflow vM, the destination and the waiting line', async () => {
    routes.list = [view()];
    await mount(createElement(ApprovalInboxPanel));
    expect(host.textContent).toContain('Waiting for your approval · 1');
    const row = host.querySelector('[data-testid="inbox-row"]')!;
    expect(row.querySelector('[data-testid="inbox-tool"]')?.textContent).toBe('Send Email');
    expect(row.querySelector('[data-testid="inbox-versions"]')?.textContent).toContain('Alert mailer v2');
    expect(row.querySelector('[data-testid="inbox-versions"]')?.textContent).toContain('Alert intake v4');
    expect(row.querySelector('[data-testid="inbox-destination"]')?.textContent).toBe('oncall@landflow.test');
    expect(row.textContent).toContain(waitingLine(iso(2), iso(12), inboxClock));
    expect(button(/^Approve$/, row)).toBeTruthy();
    expect(button(/^Deny$/, row)).toBeTruthy();
  });

  it('never offers Approve all, a select-many or a key that approves', async () => {
    routes.list = [view(), view({ id: 'req2', callId: 'call2' })];
    await mount(createElement(ApprovalInboxPanel));
    expect(host.textContent).not.toMatch(/approve all|deny all/i);
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(host.querySelectorAll('[data-testid="inbox-row"]').length).toBe(2);
    expect(host.querySelector('[accesskey]')).toBeNull();
  });

  it('Details shows the masked parameters and never a secret key unmasked', async () => {
    routes.list = [view()];
    await mount(createElement(ApprovalInboxPanel));
    await click(button(/^Details$/));
    const sheet = document.body.querySelector('[data-testid="inbox-details"]')!;
    expect(sheet.textContent).toContain('subject');
    expect(sheet.textContent).toContain('Disk on db-1');
    expect(sheet.textContent).toContain('smtpPassword');
    expect(sheet.textContent).toContain(MASK);
    expect(sheet.textContent).not.toContain('hunter2-not-masked');
    expect(sheet.textContent).not.toContain('k-123456');
    expect(sheet.textContent).toContain('Alert mailer v2');
    expect(sheet.querySelector('a[href="/runs/ex1"]')?.textContent).toContain('Open the run');
    expect(sheet.querySelector('a[href="/agents/ag1"]')).toBeTruthy();
  });

  it('Approve posts once even on a double click, then the row reads the settled line', async () => {
    routes.list = [view()];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    routes.decide = async () => {
      await gate;
      return json(view({ status: 'approved', decidedByName: 'Owner', decidedVia: 'inbox', decidedAt: iso(5) }));
    };
    await mount(createElement(ApprovalInboxPanel));
    const approve = button(/^Approve$/)!;
    await click(approve);
    await click(approve);
    await click(button(/^Approve$/));
    expect(posts()).toEqual([{ method: 'POST', url: '/api/approval-inbox/req1/approve' }]);
    expect((button(/Deny/) as HTMLButtonElement).disabled).toBe(true);
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(posts().length).toBe(1);
    expect(host.querySelector('[data-testid="inbox-settled"]')?.textContent).toContain(settledLine(view({ status: 'approved', decidedByName: 'Owner', decidedVia: 'inbox', decidedAt: iso(5) }), inboxClock));
    expect(button(/^Approve$/)).toBeUndefined();
  });

  it('a 409 shows closedAnswer on the row and does not throw', async () => {
    routes.list = [view()];
    const lost = view({ status: 'approved', decidedByName: 'Owner', decidedAt: iso(5) });
    const answer = closedAnswer(lost, inboxClock);
    routes.decide = () => json({ error: answer.message }, answer.status);
    await mount(createElement(ApprovalInboxPanel));
    await click(button(/^Approve$/));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(host.querySelector('[data-testid="inbox-closed"]')?.textContent).toBe(answer.message);
    expect(answer.message).toMatch(/^Already approved by Owner at /);
  });

  it('shows no buttons when the caller cannot decide, and says who can', async () => {
    routes.list = [view({ canDecide: false })];
    await mount(createElement(ApprovalInboxPanel));
    expect(button(/^Approve$/)).toBeUndefined();
    expect(button(/^Deny$/)).toBeUndefined();
    expect(host.textContent).toContain('Only people who can run this workflow decide it');
    expect(button(/^Details$/)).toBeTruthy();
  });

  it('?approval=<id> opens that request\'s Details; one that is no longer waiting shows how it ended', async () => {
    routes.list = [view(), view({ id: 'req2', callId: 'call2', tool: 'Post Message' })];
    window.history.pushState({}, '', '/?approval=req2');
    await mount(createElement(ApprovalInboxPanel));
    const sheet = document.body.querySelector('[data-testid="inbox-details"]');
    expect(sheet?.parentElement?.textContent).toContain('Post Message');
    act(() => root.unmount());
    root = createRoot(host);
    routes.list = [];
    routes.byId = { gone: view({ id: 'gone', status: 'denied', decidedByName: 'Owner', decidedVia: 'inbox', decidedAt: iso(6) }) };
    window.history.pushState({}, '', '/?approval=gone');
    await mount(createElement(ApprovalInboxPanel));
    expect(host.querySelector('[data-testid="inbox-focus"]')?.textContent).toContain('Denied by Owner in Needs you');
  });
});

describe('the Needs you list', () => {
  it('renders an InboxRow for an inbox item and the old link for one without fields', async () => {
    routes.needsYou = [
      { executionId: 'ex1', workflowId: 'wf1', workflowName: 'Alert intake', kind: 'approval', title: 'Agent wants to run Send Email', since: iso(2), requestId: 'req1', tool: 'Send Email', agentName: 'Alert mailer', agentVersion: 2, workflowVersion: 4, destination: 'oncall@landflow.test', expiresAt: iso(12), canDecide: true },
      { executionId: 'ex9', workflowId: 'wf9', workflowName: 'Old flow', kind: 'approval', title: 'Planner wants to use publish', since: iso(1) },
    ];
    await mount(createElement(NeedsYouList));
    const rows = host.querySelectorAll('[data-testid="inbox-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Alert mailer v2');
    expect(button(/^Approve$/, rows[0])).toBeTruthy();
    const old = host.querySelector('a[href="/runs/ex9"]');
    expect(old?.textContent).toContain('Planner wants to use publish');
    expect(old?.parentElement?.querySelector('button')).toBeNull();
  });
});

describe('the Run Trace card', () => {
  const wait = {
    kind: 'wait' as const,
    spanId: 'run/wait:1',
    actor: { id: 'human', name: 'A person', type: 'human' as const },
    title: 'Approve Send Email',
    since: iso(2),
    attrs: { wait: 'approval', tool: 'Send Email', calls: [{ id: 'call1', tool: 'Send Email', input: { to: 'oncall@landflow.test' } }] },
  };
  const card = () => createElement(ApprovalCard, { wait: wait as never, model: foldJournal([]), executionId: 'ex1' });

  it('reads the waiting line, the versions and the destination for an inbox wait, and decides through the inbox', async () => {
    routes.list = [view()];
    await mount(card());
    expect(host.querySelector('[data-testid="approval-inbox-line"]')?.textContent).toBe(waitingLine(iso(2), iso(12), inboxClock));
    expect(host.textContent).not.toContain('waiting since');
    expect(host.querySelector('[data-testid="approval-inbox-facts"]')?.textContent).toContain('Alert mailer v2 · Alert intake v4 · goes to oncall@landflow.test');
    expect(host.querySelector('[data-testid="approval-edit"]')).toBeNull();
    await click(host.querySelector('[data-testid="approval-approve"]')!);
    expect(posts()).toEqual([{ method: 'POST', url: '/api/approval-inbox/req1/approve' }]);
  });

  it('after Approve the card shows the settled line and no buttons', async () => {
    routes.list = [view()];
    await mount(card());
    await click(host.querySelector('[data-testid="approval-approve"]')!);
    expect(host.querySelector('[data-testid="approval-inbox-line"]')?.textContent).toBe(settledLine(view({ status: 'approved', decidedByName: 'Owner', decidedVia: 'inbox', decidedAt: iso(5) }), inboxClock));
    expect(host.querySelector('[data-testid="approval-approve"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-deny"]')).toBeNull();
  });

  it('a request that expired reads as the expiry, with its time and no buttons', async () => {
    routes.list = [view({ status: 'expired', decidedAt: iso(12) })];
    await mount(card());
    const line = host.querySelector('[data-testid="approval-inbox-line"]')?.textContent ?? '';
    expect(line).toMatch(/^Expired at \d\d:\d\d: nobody approved “.+” in time, so it did not run$/);
    expect(line).not.toContain('Answered');
    expect(host.querySelector('[data-testid="approval-approve"]')).toBeNull();
  });

  it('after a 410 the card shows the closed message and no buttons', async () => {
    routes.list = [view()];
    routes.decide = () => json({ error: 'This approval expired at 14:12.' }, 410);
    await mount(card());
    await click(host.querySelector('[data-testid="approval-approve"]')!);
    expect(host.querySelector('[data-testid="approval-closed"]')?.textContent).toContain('expired');
    expect(host.querySelector('[data-testid="approval-approve"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-deny"]')).toBeNull();
  });

  it('a destination that already starts with "to" is not read "goes to to …"', async () => {
    routes.list = [view({ destination: 'to oncall@landflow.test' })];
    await mount(card());
    const facts = host.querySelector('[data-testid="approval-inbox-facts"]')?.textContent ?? '';
    expect(facts).toContain('goes to oncall@landflow.test');
    expect(facts).not.toMatch(/to to/);
  });

  it('an inbox wait offers no JSON edit, even before its request has loaded; a plain wait still does', async () => {
    routes.list = [];
    const inboxWait = { ...wait, attrs: { ...wait.attrs, inbox: true } };
    await mount(createElement(ApprovalCard, { wait: inboxWait as never, model: foldJournal([]), executionId: 'ex1' }));
    expect(host.querySelector('[data-testid="approval-approve"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="approval-edit"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mount(card());
    expect(host.querySelector('[data-testid="approval-edit"]')).toBeTruthy();
  });

  it('a 200 without a readable view reads Approved in a settled tone, not the warn closed one, and no buttons', async () => {
    routes.list = [view()];
    routes.decide = () => json({});
    await mount(card());
    await click(host.querySelector('[data-testid="approval-approve"]')!);
    const done = host.querySelector('[data-testid="approval-done"]');
    expect(done?.textContent).toBe('Approved');
    expect(done?.className).not.toContain('text-warn');
    expect(host.querySelector('[data-testid="approval-closed"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-approve"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-deny"]')).toBeNull();
  });

  it('a lost race says who won, and a wait without a request reads waiting since as before', async () => {
    routes.list = [view()];
    routes.decide = () => json({ error: 'Already denied by Owner at 14:05.' }, 409);
    await mount(card());
    await click(host.querySelector('[data-testid="approval-deny"]')!);
    expect(host.querySelector('[data-testid="approval-closed"]')?.textContent).toBe('Already denied by Owner at 14:05.');
    expect(host.querySelector('[data-testid="approval-approve"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-deny"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    routes.list = [];
    await mount(card());
    expect(host.textContent).toContain('waiting since');
    expect(host.querySelector('[data-testid="approval-inbox-line"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-edit"]')).toBeTruthy();
  });
});

describe('the publish lines', () => {
  it('draws a clock for waits and the shield for refuses, with the server\'s text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          { tool: 'Send Email', agent: 'Alert mailer', node: 'n1', trigger: 'webhook', outcome: 'waits', line: 'In production “Send Email” will wait for your approval in Needs you: a webhook run pauses until someone approves or denies it, and the request expires after 24 h.' },
          { tool: 'Post Message', agent: 'Alert mailer', node: 'n2', trigger: 'webhook', outcome: 'refuses', why: 'refuseSetting', line: 'In production “Post Message” is refused: a webhook run cannot wait for an approval here (Tool Approvals is set to Refuse on this step).' },
        ]),
      ),
    );
    await mount(createElement(UnattendedLines, { workflowId: 'wf1' }));
    const lines = [...host.querySelectorAll('[data-testid="unattended-lines"] > div')];
    expect(lines.length).toBe(2);
    expect(lines[0].querySelector('svg[data-outcome="waits"]')).toBeTruthy();
    expect(lines[0].textContent).toContain('will wait for your approval in Needs you');
    expect(lines[0].textContent).not.toMatch(/nobody approves/);
    expect(lines[1].querySelector('svg[data-outcome="refuses"]')).toBeTruthy();
    expect(lines[1].textContent).toContain('is refused: a webhook run cannot wait');
  });
});

describe("the agent page's session", () => {
  const tool = { id: 't1', type: 'tool' as const, callId: 'call1', tool: 'send_email', label: 'Send Email', kind: 'node' as const, input: { to: 'oncall@landflow.test' }, status: 'awaiting_approval' as const, at: iso(2) };
  it('says Waiting in Needs you with a link and no Approve or Deny for an inbox-backed session', async () => {
    await mount(createElement(TimelineView, { entries: [tool], onDecide: () => {}, onDecideAll: () => {}, inboxHref: '/?approval=req1' }));
    expect(host.querySelector('[data-testid="waiting-in-needs-you"]')?.textContent).toContain('Waiting in Needs you');
    expect(host.querySelector('a[href="/?approval=req1"]')).toBeTruthy();
    expect(button(/^Approve$/)).toBeUndefined();
    expect(button(/^Deny$/)).toBeUndefined();
  });
  it('keeps its buttons where nothing waits in the inbox', async () => {
    await mount(createElement(TimelineView, { entries: [tool], onDecide: () => {} }));
    expect(button(/^Approve$/)).toBeTruthy();
    expect(host.querySelector('[data-testid="waiting-in-needs-you"]')).toBeNull();
  });
});
