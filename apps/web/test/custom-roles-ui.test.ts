/**
 * C32: Settings → Users → Custom roles, rendered to static HTML as the other UI tests do: the card lists roles with an
 * action chip each and the holder count, the editor disables what the viewer may not grant and says why (Manage users
 * and Create admin API keys: only the owner; Manage projects: never; an action the viewer doesn't hold), a viewer with
 * `grants` sees the controls the gate shows (the Audit log tab), and no client module builds a zod schema.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { can, type Viewer } from '../src/lib/shared/auth';
import type { CustomRoleView } from '../src/lib/shared/roles';

const root = join(import.meta.dirname, '..', 'src');
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const role = (over: Partial<CustomRoleView> = {}): CustomRoleView => ({ id: 'role_1', name: 'Platform', description: 'Plugins and MCP', rules: [{ action: 'plugins:manage', effect: 'allow' }, { action: 'mcp:manage', effect: 'allow' }], holders: 2, createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z', ...over });
const viewerOf = (over: Partial<Viewer> = {}): Viewer => ({ id: 'u1', name: 'Olive', email: 'o@example.test', role: 'owner', sso: false, hasPassword: true, ...over });

async function withViewer(viewer: Viewer | null, node: Parameters<typeof renderToStaticMarkup>[0]) {
  const { ViewerProvider } = await import('../src/components/auth/viewer');
  return html(createElement(ViewerProvider, { viewer, children: node }));
}

describe('the roles card', () => {
  it('lists a role with its chips, description and holder count', async () => {
    const { RolesSettings } = await import('../src/components/settings/roles-settings');
    const out = await withViewer(viewerOf(), createElement(RolesSettings, { roles: [role()] }));
    expect(out).toContain('Platform');
    expect(out).toContain('Plugins and MCP');
    expect(out).toContain('Manage plugins');
    expect(out).toContain('Manage MCP');
    expect(out).toContain('2 people');
    expect(out).toContain('New role');
    expect(out).toContain('aria-label="Edit Platform"');
    expect(out).toContain('aria-label="Delete Platform"');
  });

  it('says so when there are none, and a viewer without users:manage gets no buttons', async () => {
    const { RolesSettings } = await import('../src/components/settings/roles-settings');
    expect(await withViewer(viewerOf(), createElement(RolesSettings, { roles: [] }))).toContain('No custom roles yet');
    const out = await withViewer(viewerOf({ role: 'member' }), createElement(RolesSettings, { roles: [role()] }));
    expect(out).not.toContain('New role');
    expect(out).not.toContain('aria-label="Edit Platform"');
  });
});

describe('what the editor lets a viewer grant', () => {
  it('the owner may tick everything but Manage projects', async () => {
    const { whyNotGrantable } = await import('../src/components/settings/roles-settings');
    const owner = viewerOf();
    expect(whyNotGrantable(owner, 'users:manage')).toBeUndefined();
    expect(whyNotGrantable(owner, 'apiKeys:admin')).toBeUndefined();
    expect(whyNotGrantable(owner, 'projects:manage')).toMatch(/sees every project/);
  });
  it('an admin may not grant users:manage or apiKeys:admin', async () => {
    const { whyNotGrantable } = await import('../src/components/settings/roles-settings');
    const admin = viewerOf({ role: 'admin' });
    expect(whyNotGrantable(admin, 'users:manage')).toBe('Only the owner can grant this.');
    expect(whyNotGrantable(admin, 'apiKeys:admin')).toBe('Only the owner can grant this.');
    expect(whyNotGrantable(admin, 'mcp:manage')).toBeUndefined();
  });
  it('a holder may grant only what they hold', async () => {
    const { whyNotGrantable } = await import('../src/components/settings/roles-settings');
    const holder = viewerOf({ role: 'member', grants: ['mcp:manage'] });
    expect(whyNotGrantable(holder, 'mcp:manage')).toBeUndefined();
    expect(whyNotGrantable(holder, 'variables:manage')).toBe('You can only grant actions you hold.');
    expect(whyNotGrantable(holder, 'plugins:manage')).toBe('Only the owner can grant this.');
  });
  it('hides Edit and Delete on a role the viewer couldn’t have made, and reads manage through can()', () => {
    const source = readFileSync(join(root, 'components/settings/roles-settings.tsx'), 'utf8');
    expect(source).toContain("can(viewer, 'users:manage')");
    expect(source).toContain('{mayChange(role) && (');
  });
  it('hides Stop all, Source control, Environments, Security, External secrets and Transports from anyone but the built-in admin role', () => {
    const page = readFileSync(join(root, 'app/settings/page.tsx'), 'utf8');
    for (const id of ['security', 'source-control', 'environments', 'external-secrets', 'transports']) expect(page).toMatch(new RegExp(`id: '${id}'[^\\n]*admin: true`));
    expect(page).toContain('isBuiltInAdmin(viewer)');
    expect(readFileSync(join(root, 'components/runs/runs-list.tsx'), 'utf8')).toContain('isBuiltInAdmin(viewer)');
    expect(readFileSync(join(root, 'components/settings/environments-settings.tsx'), 'utf8')).toContain('isBuiltInAdmin(viewer)');
  });
  it('the editor disables a box it may not grant and prints the reason under it', () => {
    // The dialog portals to <body>, which a server render has none of: checked through its source.
    const source = readFileSync(join(root, 'components/settings/roles-settings.tsx'), 'utf8');
    expect(source).toContain('disabled={Boolean(why)}');
    expect(source).toContain('why ?? note');
  });
});

describe('the member row and the gate', () => {
  it('Users shows a custom-role select per member, disabled for roles the viewer may not hand out', () => {
    const source = readFileSync(join(root, 'components/settings/users-settings.tsx'), 'utf8');
    expect(source).toContain('Custom role of ${user.name}');
    expect(source).toContain('No custom role');
    expect(source).toContain("user.role === 'member'");
  });

  it('a viewer with grants sees the tab its action gates (Audit log), and not the one it does not (Users)', () => {
    const holder = viewerOf({ role: 'member', grants: ['audit:read'] });
    expect(can(holder, 'audit:read')).toBe(true);
    expect(can(holder, 'users:manage')).toBe(false);
    const page = readFileSync(join(root, 'app/settings/page.tsx'), 'utf8');
    expect(page).toContain("role: 'audit:read'");
    expect(page).toContain('can(viewer, s.role)');
  });
});

describe('no client module builds a zod schema (the CSP forbids eval)', () => {
  it.each(['components/settings/roles-settings.tsx', 'components/settings/users-settings.tsx', 'lib/shared/roles.ts', 'lib/shared/auth.ts'])('%s', (file) => {
    expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/from 'zod'|z\.object|z\.strictObject/);
  });
});
