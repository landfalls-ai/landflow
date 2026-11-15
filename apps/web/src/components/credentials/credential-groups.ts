import type { CredentialTypeInfo } from '@/lib/shared/types';

/** One credential type as the picker lists it: its name without the "API" suffix. */
export interface CredentialTypeRow {
  info: CredentialTypeInfo;
  label: string;
}

/** The types of one app (plugin), or of the built-in generic ones. */
export interface CredentialTypeGroup {
  app: string;
  rows: CredentialTypeRow[];
}

/** The group for the types the host itself ships (header auth, basic auth, OAuth2): no plugin to name. */
export const GENERIC_GROUP = 'Generic';
const CORE_PLUGIN = 'Landflow Core';

/** "Telegram API" -> "Telegram", "Slack OAuth2 API" -> "Slack OAuth2"; a name that is only "API" stays. */
export function stripApiSuffix(name: string): string {
  const stripped = name.replace(/\s+API$/i, '').trim();
  return stripped || name;
}

/**
 * The app a type belongs to: its plugin. The host's own plugin ("Landflow Core") ships both whole apps ("Anthropic API",
 * "Cohere API": each is its own app) and generic kinds of login (Basic Auth, OAuth2, IMAP): those go in the generic group.
 */
export function appOf(info: CredentialTypeInfo): string {
  if (info.pluginName !== CORE_PLUGIN) return info.pluginName;
  const name = info.descriptor.displayName;
  return /\sAPI$/i.test(name) && !/auth/i.test(name) ? stripApiSuffix(name) : GENERIC_GROUP;
}

/**
 * The picker's list: types matching `query`, grouped by app (alphabetical, the generic group last) and sorted by
 * name inside a group, with the "API" suffix stripped from each name.
 */
export function groupCredentialTypes(types: CredentialTypeInfo[], query = ''): CredentialTypeGroup[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, CredentialTypeRow[]>();
  for (const info of types) {
    const app = appOf(info);
    const label = stripApiSuffix(info.descriptor.displayName);
    if (needle && !`${label} ${info.descriptor.displayName} ${app} ${info.descriptor.description ?? ''}`.toLowerCase().includes(needle)) continue;
    groups.set(app, [...(groups.get(app) ?? []), { info, label }]);
  }
  return [...groups.entries()]
    .map(([app, rows]) => ({ app, rows: rows.sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => (a.app === GENERIC_GROUP ? 1 : b.app === GENERIC_GROUP ? -1 : a.app.localeCompare(b.app)));
}
