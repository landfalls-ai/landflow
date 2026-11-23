/**
 * The OpenID Connect client credential (`core.oidcClient`): an OAuth client of a sign-in provider (Google Workspace by default), used by
 * "Sign in with Google" for people without a Landflow account (lib/server/access/outside). It is a sign-in client, not an API token:
 * nothing here reaches a node. The client secret is read at sign-in from the vault, never stored in a setting or sent to a page.
 * The discovery URL is for a provider the host reaches at another address than its issuer (a test double, Docker).
 */
import { defineCredentialType } from '@landflow/sdk';

/** The type as the vault stores it. */
export const OIDC_CLIENT_TYPE = 'core.oidcClient';
export const GOOGLE_ISSUER = 'https://accounts.google.com';

export const oidcClientCredential = defineCredentialType({
  name: 'oidcClient',
  displayName: 'OpenID Connect client (sign-in)',
  description: 'An OAuth client of an OpenID Connect provider such as Google. Landflow uses it to sign people in with Google who have no Landflow account. Register the redirect URL shown in Access settings.',
  icon: 'lucide:log-in',
  documentationUrl: 'https://developers.google.com/identity/openid-connect/openid-connect',
  properties: [
    { name: 'issuer', displayName: 'Issuer', type: 'string', default: GOOGLE_ISSUER, required: true, placeholder: GOOGLE_ISSUER, description: 'The provider’s issuer URL: its ID tokens name it.' },
    { name: 'clientId', displayName: 'Client ID', type: 'string', default: '', required: true },
    { name: 'clientSecret', displayName: 'Client Secret', type: 'string', default: '', required: true, typeOptions: { password: true } },
    { name: 'discoveryUrl', displayName: 'Discovery URL', type: 'string', default: '', description: 'Only when the host reaches the provider at another address than its issuer. Empty: the issuer’s /.well-known/openid-configuration.' },
  ],
});
