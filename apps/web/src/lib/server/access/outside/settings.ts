/**
 * The settings of access requests from people without a Landflow account (docs/access-requests.md#signing-in-without-an-account): on or off
 * (off by default), the email domains that may ask, and Google sign-in with its OpenID Connect client credential. Own settings key
 * (`access_outside`): `access_requests` is rewritten whole by C35's setup. Only an instance admin reads or changes them; everything the
 * public routes learn from here is `outsideSettings()` read at call time, so a switch-off takes effect on the next request.
 */
import { auditedTransaction, recordAudit } from '../../audit';
import { mailConfigured } from '../../auth/mail';
import { publicUrl } from '../../config';
import { credentials } from '../../credentials/vault';
import { database } from '../../db';
import { OIDC_CLIENT_TYPE } from '../../nodes/oidc-client-credential';
import { canResource, isInstanceAdmin, type Actor } from '../../projects/access';
import { AccessError } from '../errors';
import { auditActorOf } from '../rules';
import { parseJson } from '../store';

export const OUTSIDE_SETTINGS_KEY = 'access_outside';
/** Most domains one instance lists. */
export const MAX_DOMAINS = 50;
/** Where the page lives, and where Google sends the browser back: one prefix, so one cookie path covers the page and its routes. */
export const OUTSIDE_PAGE_PATH = '/request-access';
export const GOOGLE_CALLBACK_PATH = '/request-access/api/sign-in/google/callback';

export interface OutsideSettings {
  enabled: boolean;
  domains: string[];
  google: { enabled: boolean; credentialId?: string };
}

/** Free mail providers: a domain anyone can register an address on proves nothing about who is asking. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com',
]);

/** A host name with a dot and an alphabetic top level (an IP address, a wildcard and a bare word all fail it). */
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?!\d+$)[a-z0-9-]{2,63}$/;

export function outsideSettings(): OutsideSettings {
  const raw = parseJson<Record<string, unknown>>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', OUTSIDE_SETTINGS_KEY)?.value, {});
  const google = (raw.google && typeof raw.google === 'object' ? raw.google : {}) as Record<string, unknown>;
  const credentialId = typeof google.credentialId === 'string' && google.credentialId ? google.credentialId : undefined;
  return {
    enabled: raw.enabled === true,
    domains: Array.isArray(raw.domains) ? raw.domains.filter((d): d is string => typeof d === 'string') : [],
    google: { enabled: google.enabled === true, ...(credentialId && { credentialId }) },
  };
}

/** The domain of an address, lower case (empty when it has none). */
export const domainOf = (email: string): string => (email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase() : '');

/** Whether the address's domain is one an admin listed (the domain itself: a subdomain is another domain). */
export function domainAllowed(email: string, settings: OutsideSettings = outsideSettings()): boolean {
  const domain = domainOf(email);
  return Boolean(domain) && settings.domains.includes(domain);
}

/** Whether Google sign-in can start: switched on, and its credential is still there and still an OpenID Connect client. */
export function googleReady(settings: OutsideSettings = outsideSettings()): boolean {
  return settings.google.enabled && Boolean(settings.google.credentialId) && credentials.get(settings.google.credentialId!)?.type === OIDC_CLIENT_TYPE;
}

const adminOnly = (actor: Actor) => {
  if (!isInstanceAdmin(actor)) throw new AccessError('Only an owner or admin changes who can ask without a Landflow account', 403);
};

/** What the settings card shows: the settings, the page link, the redirect URL to register at Google, whether mail can go out. */
export interface OutsideSettingsView extends OutsideSettings {
  pageUrl: string;
  redirectUrl: string;
  mail: boolean;
  google: OutsideSettings['google'] & { credentialName?: string };
}

export function outsideSettingsView(actor: Actor): OutsideSettingsView {
  adminOnly(actor);
  const settings = outsideSettings();
  const credentialName = settings.google.credentialId ? credentials.get(settings.google.credentialId)?.name : undefined;
  return {
    ...settings,
    google: { ...settings.google, ...(credentialName && { credentialName }) },
    pageUrl: `${publicUrl()}${OUTSIDE_PAGE_PATH}`,
    redirectUrl: `${publicUrl()}${GOOGLE_CALLBACK_PATH}`,
    mail: mailConfigured(),
  };
}

export interface OutsideSettingsPatch {
  enabled?: boolean;
  domains?: string[];
  google?: { enabled?: boolean; credentialId?: string | null };
}

/** The domains as the settings keep them: lower case, trimmed, without repeats; a refused one names itself. */
function cleanDomains(list: string[]): string[] {
  const domains = [...new Set(list.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (domains.length > MAX_DOMAINS) throw new AccessError(`List at most ${MAX_DOMAINS} domains`, 400, { field: 'domains' });
  for (const domain of domains) {
    if (PUBLIC_MAIL_DOMAINS.has(domain)) throw new AccessError(`Only your organization’s domains: ${domain} is a free mail provider`, 400, { field: 'domains' });
    if (!DOMAIN.test(domain)) throw new AccessError(`“${domain}” is not a domain name (write it like partner.example, without * or @)`, 400, { field: 'domains' });
  }
  return domains;
}

/** Save the settings (instance admins), audited with before and after. A turned-on feature needs a domain; Google needs a usable credential. */
export function saveOutsideSettings(actor: Actor, patch: OutsideSettingsPatch): OutsideSettingsView {
  adminOnly(actor);
  const before = outsideSettings();
  const domains = patch.domains ? cleanDomains(patch.domains) : before.domains;
  const enabled = patch.enabled ?? before.enabled;
  const credentialId = patch.google && 'credentialId' in patch.google ? (patch.google.credentialId ?? undefined) : before.google.credentialId;
  const googleOn = patch.google?.enabled ?? before.google.enabled;
  if (enabled && !domains.length) throw new AccessError('List at least one email domain before switching this on', 400, { field: 'domains' });
  if (googleOn) {
    if (!credentialId) throw new AccessError('Choose the OpenID Connect client credential for Google sign-in', 400, { field: 'google' });
    const credential = credentials.get(credentialId);
    if (credential?.type !== OIDC_CLIENT_TYPE || !canResource(actor, 'credential', credentialId, 'use')) {
      throw new AccessError('Choose an OpenID Connect client credential you can use', 400, { field: 'google' });
    }
  }
  const after: OutsideSettings = { enabled, domains, google: { enabled: googleOn, ...(credentialId && { credentialId }) } };
  auditedTransaction(() => {
    database().upsert('settings', { key: OUTSIDE_SETTINGS_KEY, value: JSON.stringify(after) });
    recordAudit({
      action: 'access.outside.settings',
      actor: auditActorOf(actor),
      target: { type: 'access_outside', id: 'settings', name: 'People without a Landflow account' },
      project: null,
      summary: `${enabled ? 'Allowed' : 'Switched off'} access requests from people without a Landflow account${enabled ? ` (${domains.join(', ')})` : ''}`,
      details: { from: JSON.stringify(before), to: JSON.stringify(after) },
    });
  });
  return outsideSettingsView(actor);
}
