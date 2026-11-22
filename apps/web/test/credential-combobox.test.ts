/** C23: the node panel's credential picker on the combobox: its options, the Create row, and what stays as it was. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { credentialCreation, credentialOptions, CredentialCombobox } from '../src/components/credentials/credential-combobox';
import { autoPickStep } from '../src/components/credentials/use-credentials';
import { visibleOptions } from '../src/components/ui/combobox-model';
import type { CredentialSummary } from '../src/lib/shared/types';

const cred = (id: string, name: string, project?: string, shared = false, type = 'core.httpHeaderAuth'): CredentialSummary & { ownership?: unknown } => ({
  id,
  name,
  type,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  usedBy: [],
  ...(project && { ownership: { projectId: `p_${project}`, projectName: project, projectType: 'team', access: 'edit', shared } }),
});

describe('credentialOptions', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => cred(`c${i}`, `${['prod', 'dev', 'stage'][i % 3]} key ${i + 1}`, i % 2 ? 'Payments' : 'Platform', i % 5 === 0));

  it('offers the credentials of the type with their project as the hint, “shared” where it is reached by a share', () => {
    const options = credentialOptions(sixty);
    expect(options).toHaveLength(60);
    expect(options[1]).toMatchObject({ value: 'c1', label: 'dev key 2', hint: 'Payments' });
    expect(options[0].hint).toBe('Platform · shared');
  });

  it('typing "prod" leaves only the matching ones', () => {
    const shown = visibleOptions(credentialOptions(sixty), 'prod').shown;
    expect(shown).toHaveLength(20);
    expect(shown.every((o) => o.label.startsWith('prod'))).toBe(true);
  });

  it('has no hint for a credential with no recorded project', () => {
    expect(credentialOptions([cred('a', 'Plain')])[0].hint).toBeUndefined();
  });

  it('groups by type only when a requirement takes several', () => {
    const mixed = [cred('a', 'One', 'P', false, 'core.httpHeaderAuth'), cred('b', 'Two', 'P', false, 'core.httpBearerAuth')];
    expect(credentialOptions(mixed, { groupBy: (c) => c.type === 'core.httpBearerAuth' ? 'Bearer Auth' : 'Header Auth' }).map((o) => o.group)).toEqual(['Header Auth', 'Bearer Auth']);
    expect(credentialOptions(mixed)[0].group).toBeUndefined();
  });
});

describe('Create “…”', () => {
  it('hands the typed name, trimmed, to the credential dialog', () => {
    const onCreate = vi.fn();
    const creation = credentialCreation(onCreate);
    creation.onCreate('  Billing API ');
    expect(onCreate).toHaveBeenCalledWith('Billing API');
    expect(creation.label?.('Billing API')).toBe('Create “Billing API”');
  });

  it('says No credential yet, and how to make one, for none; the trigger shows the picked name', () => {
    const props = { id: 'cred', label: 'Credential for Header Auth', onPick: () => {}, onCreate: () => {} };
    const none = renderToStaticMarkup(createElement(CredentialCombobox, { ...props, value: undefined, credentials: [] }));
    expect(none).toContain('No credential yet');
    const picked = renderToStaticMarkup(createElement(CredentialCombobox, { ...props, value: 'a', credentials: [cred('a', 'prod key', 'Payments')] }));
    expect(picked).toContain('prod key');
    expect(picked).toContain('role="combobox"');
    expect(picked).toContain('Payments');
    const unpicked = renderToStaticMarkup(createElement(CredentialCombobox, { ...props, value: undefined, credentials: [cred('a', 'prod key')] }));
    expect(unpicked).toContain('Select a credential…');
  });
});

describe('the node panel', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/components/credentials/node-credentials.tsx'), 'utf8');

  it('no longer uses the __create__ sentinel or a native select for the pick', () => {
    expect(source).not.toContain('__create__');
    expect(source).not.toContain('<Select');
    expect(source).toContain('CredentialCombobox');
  });

  it('still auto-picks exactly one fitting credential (the existing step)', () => {
    const requirements = [{ name: 'httpHeaderAuth' }];
    const step = autoPickStep({ nodeType: 'core.httpRequest', requirements, candidates: [cred('only', 'The one')], scoped: true, scopeKnown: true, settled: new Set(), value: undefined });
    expect(step.next).toEqual({ httpHeaderAuth: { id: 'only', name: 'The one' } });
    const two = autoPickStep({ nodeType: 'core.httpRequest', requirements, candidates: [cred('a', 'A'), cred('b', 'B')], scoped: true, scopeKnown: true, settled: new Set(), value: undefined });
    expect(two.next).toBeUndefined();
  });
});
