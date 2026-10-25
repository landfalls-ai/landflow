/**
 * The generic OAuth2 credential (`core.oAuth2Api`, n8n's oAuth2Api and field names). The credential dialog adds the
 * Connect button, the provider presets and the connection status; the host runs the flow and keeps the token fresh
 * (lib/server/credentials/oauth2.ts and the vault). Plugin types extend it with `extends: ['oAuth2Api']`, usually
 * fixing the URLs with `hidden` properties.
 */
import { defineCredentialType } from '@landflow/sdk';
import type { DisplayOptions } from '@landflow/protocol';

const codeGrants: DisplayOptions = { show: { grantType: ['pkce', 'authorizationCode'] } };

export const oAuth2ApiCredential = defineCredentialType({
  name: 'oAuth2Api',
  displayName: 'OAuth2 API',
  description: 'Any OAuth2 service: Connect signs in with the provider (authorization code with PKCE), or use client credentials. Tokens are refreshed for you.',
  icon: 'lucide:shield-check',
  documentationUrl: 'https://www.rfc-editor.org/rfc/rfc6749',
  properties: [
    {
      name: 'grantType',
      displayName: 'Grant Type',
      type: 'options',
      default: 'pkce',
      options: [
        { name: 'Authorization Code with PKCE', value: 'pkce', description: 'Sign in with the provider in a popup (recommended)' },
        { name: 'Authorization Code', value: 'authorizationCode', description: 'For providers that reject PKCE parameters' },
        { name: 'Client Credentials', value: 'clientCredentials', description: 'Machine to machine: no user, the client ID and secret get the token' },
      ],
    },
    { name: 'authUrl', displayName: 'Authorization URL', type: 'string', required: true, placeholder: 'https://example.com/oauth/authorize', displayOptions: codeGrants },
    { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'string', required: true, placeholder: 'https://example.com/oauth/token' },
    { name: 'clientId', displayName: 'Client ID', type: 'string', required: true },
    { name: 'clientSecret', displayName: 'Client Secret', type: 'string', default: '', typeOptions: { password: true }, description: 'Leave empty for a public client (PKCE only)' },
    { name: 'scope', displayName: 'Scope', type: 'string', default: '', placeholder: 'openid email', description: 'Space-separated; some providers (Slack) use commas' },
    {
      name: 'authQueryParameters',
      displayName: 'Auth URI Query Parameters',
      type: 'string',
      default: '',
      placeholder: 'access_type=offline&prompt=consent',
      description: 'Added to the authorization URL',
      displayOptions: codeGrants,
    },
    {
      name: 'authentication',
      displayName: 'Client Authentication',
      type: 'options',
      default: 'header',
      options: [
        { name: 'Send as Basic Auth Header', value: 'header' },
        { name: 'Send Credentials in Body', value: 'body' },
      ],
      description: 'How the client ID and secret reach the token endpoint',
    },
    {
      name: 'userInfoUrl',
      displayName: 'User Info URL',
      type: 'string',
      default: '',
      placeholder: 'https://example.com/userinfo',
      description: 'Optional: answers with the signed-in user, for “Connected as …” (an OpenID ID token works without it)',
      displayOptions: codeGrants,
    },
  ],
});
