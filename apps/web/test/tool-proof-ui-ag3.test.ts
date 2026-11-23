// @vitest-environment happy-dom
/**
 * AG14 (wave ag3): the three surfaces read a tool's target and a knowledge search's passages the same way. The editor chat
 * shows "via Mailpit SMTP · SMTP 127.0.0.1:51183" under the tool's name and the passages with their source chips (the raw
 * JSON behind Raw); the Run Trace's span sheet has a Reached row; a chunk without a target renders as before.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/w', useSearchParams: () => new URLSearchParams() }));
(Element.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null, addEventListener() {}, removeEventListener() {} });

const { ChatPanel } = await import('@/components/editor/chat-panel');
const { DetailSheet } = await import('@/components/run-trace/sheet');
type Chunk = Parameters<NonNullable<Parameters<typeof ChatPanel>[0]['onDecide']>>[3] extends (c: infer C) => void ? C : never;

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

const target = { name: 'Mailpit SMTP', system: 'SMTP', endpoint: '127.0.0.1:51183', credentialId: 'cred_1' };
const chunk = (tool: Record<string, unknown>) => ({ type: 'tool', tool: { id: 'c1', name: 'send_email', status: 'finished', ...tool } }) as unknown as Chunk;
const results = JSON.stringify({ results: [{ pageContent: 'Disk full: rotate the logs and expand the volume.\nThen check the alert again.', metadata: { source: 'runbooks/disk-full.md', page: 2 }, score: 0.8123 }, { pageContent: 'Other.', metadata: { fileName: 'upload.pdf' } }] });

async function chat(chunks: Chunk[]) {
  await act(async () =>
    root.render(
      createElement(ChatPanel, {
        open: true,
        onClose: () => {},
        onSend: async (_m, _s, _f, onChunk) => {
          chunks.forEach(onChunk);
          return { reply: 'Done.' };
        },
        onDecide: (async () => ({})) as never,
      }),
    ),
  );
  const box = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Go');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => (container.querySelector('button[aria-label="Send"]') as HTMLButtonElement).click());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('the editor chat', () => {
  it('shows the via line under the tool’s name, with its input and output as before', async () => {
    await chat([chunk({ input: { to: 'oncall@landflow.test' }, output: 'sent', target })]);
    expect(container.querySelector('[data-testid="tool-via"]')?.textContent).toBe('via Mailpit SMTP · SMTP 127.0.0.1:51183');
    expect(container.querySelector('[data-testid="tool-via"] strong')?.textContent).toBe('Mailpit SMTP');
    expect(container.textContent).toContain('oncall@landflow.test');
    expect(container.textContent).toContain('sent');
  });

  it('shows a knowledge call’s passages with their source chips, and the raw JSON only behind Raw', async () => {
    await chat([chunk({ name: 'search_runbooks', input: { query: 'disk' }, output: results, target: { name: 'runbooks', system: 'Knowledge base', knowledge: { collection: 'runbooks', store: 'SQLite', embeddings: 'keyword search (BM25, built in)', documents: 4 } } })]);
    const sources = [...container.querySelectorAll('[data-testid="passage-source"]')].map((n) => n.textContent);
    expect(sources).toEqual(['runbooks/disk-full.md', 'upload.pdf']);
    expect(container.textContent).toContain('0.81');
    expect(container.textContent).toContain('page 2');
    expect(container.textContent).not.toContain('"pageContent"');
    const raw = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Raw')!;
    await act(async () => raw.click());
    expect(container.textContent).toContain('"pageContent"');
  });

  it('a chunk without a target renders as on the base: no via line', async () => {
    await chat([chunk({ input: { to: 'a@b.c' }, output: 'sent' })]);
    expect(container.querySelector('[data-testid="tool-via"]')).toBeNull();
    expect(container.textContent).toContain('send_email');
  });
});

describe('the Run Trace span sheet', () => {
  const agent: RunActor = { id: 'agent:ag_1', name: 'Mailer', type: 'agent' };
  let seq = 0;
  const ev = (e: Record<string, unknown>) => ({ seq: ++seq, executionId: 'ex_ui', at: new Date(Date.UTC(2026, 10, 17, 9, 0, seq)).toISOString(), ...e }) as unknown as JournalEvent;
  const model = (attrs: Record<string, unknown>, output: unknown) =>
    foldJournal([
      ev({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Run', actor: { id: 'workflow', name: 'Flow', type: 'system' } }),
      ev({ type: 'span.started', spanId: 'run/step:c1', parentSpanId: 'run', kind: 'tool', name: 'Send Email', actor: agent, input: { to: 'a@b.c' }, attrs }),
      ev({ type: 'span.ended', spanId: 'run/step:c1', status: 'success', output }),
    ]);
  const sheet = (m: ReturnType<typeof model>) => renderToStaticMarkup(createElement(DetailSheet, { target: { kind: 'span', id: 'run/step:c1' }, model: m, onClose: () => {}, open: () => {}, onJump: () => {} }));

  it('has a Reached row from the span’s target, and no raw target in Details', () => {
    const html = sheet(model({ tool: 'send_email', target }, { sent: true }));
    expect(html).toContain('Reached');
    expect(html).toContain('Mailpit SMTP');
    expect(html).toContain('SMTP 127.0.0.1:51183');
    expect(html).not.toContain('credentialId');
  });

  it('shows a knowledge span’s passages under Came back', () => {
    const html = sheet(model({ tool: 'search_runbooks', target: { name: 'runbooks', knowledge: { collection: 'runbooks', store: 'SQLite', embeddings: 'keyword search (BM25, built in)' } } }, JSON.parse(results)));
    expect(html).toContain('runbooks/disk-full.md');
    expect(html).toContain('upload.pdf');
  });

  it('a span without a target has no Reached row', () => {
    expect(sheet(model({ tool: 'send_email' }, { sent: true }))).not.toContain('Reached');
  });
});
