/**
 * C17: Settings → API keys, rendered to static HTML as the other UI tests do: the new-key form offers an address list and
 * a use cap (and says they can't change later), a key's details show the last address, "3 of 100 uses" and "used up", the
 * list is checked with the server's own rule (shared/ip-entry.ts), and no control edits a list or a cap (FR-11). No client
 * module builds a zod schema (the CSP forbids `eval`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiKeyView } from '../src/lib/shared/auth';
import { checkAllowList } from '../src/lib/shared/ip-entry';

const root = join(import.meta.dirname, '..', 'src');
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const key = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({ id: 'key_1', label: 'CI', hint: 'abcd', scopes: ['workflows:read'], createdAt: '2026-11-20T10:00:00.000Z', ...over });

describe('the new-key form', () => {
  it('offers an address list and a use cap, and says they are fixed', async () => {
    const { CreateKey } = await import('../src/components/settings/api-keys-settings');
    const out = html(createElement(CreateKey, { onCreated: () => {}, onCancel: () => {} }));
    expect(out).toContain('Only from these addresses');
    expect(out).toContain('Stop after');
    expect(out).toContain('Can’t be changed later');
    expect(out).toContain('<textarea');
  });

  it('checks a line as it is typed with the server rule', () => {
    expect(checkAllowList(['300.1.1.1'])).toMatchObject({ ok: false, problem: expect.stringContaining('300.1.1.1') });
    expect(checkAllowList(['10.0.0.0/8', '2001:db8::/32', '::ffff:10.1.2.3']).ok).toBe(true);
    expect(checkAllowList(['10.0.0.0/33']).ok).toBe(false);
    expect(checkAllowList(['1::2::3']).ok).toBe(false);
  });
});

describe('a key row', () => {
  it('shows the last address, the allow-list and the uses so far', async () => {
    const { KeyDetails } = await import('../src/components/settings/api-keys-settings');
    const out = html(createElement(KeyDetails, { apiKey: key({ lastUsedAt: new Date().toISOString(), lastUsedIp: '10.1.2.3', allowedIps: ['10.0.0.0/8'], maxUses: 100, uses: 3 }) }));
    expect(out).toContain('from 10.1.2.3');
    expect(out).toContain('only from 10.0.0.0/8');
    expect(out).toContain('3 of 100 uses');
  });

  it('says "used up" at the cap', async () => {
    const { KeyDetails } = await import('../src/components/settings/api-keys-settings');
    expect(html(createElement(KeyDetails, { apiKey: key({ maxUses: 3, uses: 3, usedUp: true }) }))).toContain('used up');
  });

  it('shows nothing extra for a key made before the change', async () => {
    const { KeyDetails } = await import('../src/components/settings/api-keys-settings');
    const out = html(createElement(KeyDetails, { apiKey: key() }));
    expect(out).not.toContain('only from');
    expect(out).not.toContain('uses');
    expect(out).not.toContain('from ');
  });
});

describe('the source', () => {
  it('has no control that edits a list or a cap, and builds no zod schema', () => {
    const source = readFileSync(join(root, 'components/settings/api-keys-settings.tsx'), 'utf8');
    expect(source).not.toMatch(/method: 'PATCH'/);
    expect(source).not.toMatch(/from 'zod'/);
    expect(readFileSync(join(root, 'lib/shared/ip-entry.ts'), 'utf8')).not.toMatch(/node:|zod/);
  });
});
