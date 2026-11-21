/**
 * C09: the memory list on the agent page (components/agents/memory-card.tsx) rendered to static HTML: static and version
 * badges, Forget on a live memory, Restore on a forgotten one, and a memory's text shown as text, never as markup.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentMemoryView } from '@/lib/shared/agents';
import { MemoryList } from '@/components/agents/memory-card';

const item = (over: Partial<AgentMemoryView>): AgentMemoryView => ({ id: 'm_1', text: 'Prefers email', static: false, version: 1, at: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-02T00:00:00.000Z', ...over });

describe('MemoryList', () => {
  it('shows Static, the version and Forget on live memories', () => {
    const html = renderToStaticMarkup(createElement(MemoryList, { items: [item({ static: true, text: 'My name is Dana' }), item({ id: 'm_2', version: 3, text: 'Prefers Slack' })], onForget: () => undefined, onRestore: () => undefined }));
    expect(html).toContain('Static');
    expect(html).toContain('Version 3');
    expect(html.match(/>Forget</g)).toHaveLength(2);
    expect(html).not.toContain('Restore');
    expect(html).toContain('Said 2026-11-01');
  });

  it('shows Restore and the reason on a forgotten memory, and no Forget', () => {
    const html = renderToStaticMarkup(createElement(MemoryList, { items: [item({ forgottenAt: '2026-11-10T00:00:00.000Z', forgetReason: 'not true any more' })], onForget: () => undefined, onRestore: () => undefined }));
    expect(html).toContain('>Restore<');
    expect(html).toContain('Forgotten 2026-11-10');
    expect(html).toContain('Reason: not true any more');
    expect(html).not.toContain('>Forget<');
  });

  it('renders a memory that holds markup as text', () => {
    const html = renderToStaticMarkup(createElement(MemoryList, { items: [item({ text: '<b>bold</b><img src=x onerror=alert(1)>' })] }));
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold');
    expect(html).not.toContain('<img');
  });
});
