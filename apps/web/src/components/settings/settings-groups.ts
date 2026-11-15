/**
 * The settings sections in five groups, and where an old link goes. Plain data and pure functions: the page and the
 * tests share them.
 */

export type SettingsGroupId = 'workspace' | 'people' | 'governance' | 'ai' | 'infrastructure';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  sections: readonly string[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'workspace', label: 'Workspace', sections: ['general', 'company', 'variables', 'alerts', 'environments', 'source-control'] },
  { id: 'people', label: 'People & access', sections: ['users', 'api-keys', 'security', 'audit'] },
  { id: 'governance', label: 'Governance', sections: ['governance', 'external-secrets'] },
  { id: 'ai', label: 'AI', sections: ['ai-prices', 'ai-caps', 'llm-gateway', 'mcp'] },
  { id: 'infrastructure', label: 'Infrastructure', sections: ['workers', 'transports'] },
];

/** Where the API reference lives now. */
export const API_REFERENCE_HREF = '/developers#api-reference';

/** Old section ids that moved: `#api` and `?section=api` open the API reference on Developers. */
export const LEGACY_SECTIONS: Record<string, { href: string }> = {
  api: { href: API_REFERENCE_HREF },
};

export type SectionTarget = { kind: 'section'; id: string } | { kind: 'redirect'; href: string } | { kind: 'none' };

/** What a `#hash` or `?section=` value means: a settings section, a page elsewhere, or nothing (the first section). */
export function resolveSection(raw: string | null | undefined, known: readonly string[]): SectionTarget {
  const id = (raw ?? '').replace(/^#/, '').trim();
  if (!id) return { kind: 'none' };
  const moved = LEGACY_SECTIONS[id];
  if (moved) return moved.href.startsWith('/settings#') ? { kind: 'section', id: moved.href.slice('/settings#'.length) } : { kind: 'redirect', href: moved.href };
  return known.includes(id) ? { kind: 'section', id } : { kind: 'none' };
}

/** `/settings?section=x#y` → the section id to open: the query wins over the hash. */
export function sectionFromLocation(search: string, hash: string): string {
  return new URLSearchParams(search).get('section') || hash.replace(/^#/, '');
}
