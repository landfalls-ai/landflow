// @vitest-environment happy-dom
/**
 * The editor chat's wiring of an approval (docs/agents.md, Run an Agent): the call that waited for approval is one row that
 * reads Waiting for approval, then Done after Approve or Denied after Deny; the resumed run's chunks never start a second row.
 * The real ChatPanel in happy-dom; the host's run is a double that streams the chunks the agent node sends.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/w', useSearchParams: () => new URLSearchParams() }));

const { ChatPanel } = await import('@/components/editor/chat-panel');
type Chunk = Parameters<NonNullable<Parameters<typeof ChatPanel>[0]['onDecide']>>[3] extends (c: infer C) => void ? C : never;

// Motion uses the Web Animations API; happy-dom cancels its animations with an AbortError nobody awaits.
(Element.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null, addEventListener() {}, removeEventListener() {} });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tool = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'tool', tool: { id: 'c1', name: 'send_email', status, input: { to: 'oncall@landflow.test' }, ...extra } }) as unknown as Chunk;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const rows = () => [...container.querySelectorAll('details')].map((d) => d.querySelector('summary')?.textContent ?? '');
const button = (label: RegExp) => [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''))!;

async function sendAndWait(onDecide: (executionId: string, callId: string, approved: boolean, onChunk: (c: Chunk) => void) => Promise<Record<string, unknown>>) {
  await act(async () =>
    root.render(
      createElement(ChatPanel, {
        open: true,
        onClose: () => {},
        onSend: async (_m, _s, _f, onChunk) => {
          onChunk(tool('approval'));
          return { executionId: 'e1', approval: { nodeName: 'Agent', channel: 'chat', calls: [{ id: 'c1', tool: 'send_email', input: { to: 'oncall@landflow.test' } }] } };
        },
        onDecide: onDecide as never,
      }),
    ),
  );
  const box = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Email oncall');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => (container.querySelector('button[aria-label="Send"]') as HTMLButtonElement).click());
  await settle();
}

describe('the editor chat’s approval row', () => {
  it('Approve: one row, Waiting for approval, then Done; the reply has no second row', async () => {
    await sendAndWait(async (_e, _c, _a, onChunk) => {
      onChunk(tool('started'));
      onChunk(tool('finished', { output: 'sent' }));
      onChunk({ type: 'item', content: 'Sent.' } as unknown as Chunk);
      return { reply: 'Sent.' };
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Waiting for approval');
    await act(async () => button(/Approve/).click());
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Done');
    expect(rows()[0]).not.toContain('Waiting for approval');
    expect(container.textContent).toContain('Sent.');
  });

  it('Deny: one row reading Denied', async () => {
    await sendAndWait(async (_e, _c, _a, onChunk) => {
      onChunk(tool('denied'));
      onChunk({ type: 'item', content: 'I did not send it.' } as unknown as Chunk);
      return { reply: 'I did not send it.' };
    });
    await act(async () => button(/Deny/).click());
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Denied');
  });

  it('a Deny that fails leaves the row as it was', async () => {
    await sendAndWait(async () => {
      throw new Error('Already decided');
    });
    await act(async () => button(/Deny/).click());
    await settle();
    expect(rows().filter((r) => r.includes('send_email'))).toHaveLength(1);
    expect(rows()[0]).toContain('Waiting for approval');
  });
});
