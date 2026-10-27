/**
 * OAuth2 credentials, shared by the host and the credential dialog: the generic type's name, the provider presets
 * (they only fill in URLs and scopes) and the connection status the API reports. No runtime imports.
 */

/** The generic OAuth2 credential type of the core plugin; plugin types extend it with `extends: ['oAuth2Api']`. */
export const OAUTH2_CREDENTIAL = 'core.oAuth2Api';

/** The credential of an OAuth-protected MCP server (RFC 9728 discovery, dynamic client registration, `resource`): it extends the generic type. */
export const MCP_OAUTH2_CREDENTIAL = 'core.mcpOAuth2Api';

/** Where providers send the browser back after consent. Public (the sign-in guard lets it through); the state is signed. */
export const OAUTH2_CALLBACK_PATH = '/api/oauth2/callback';

/** The BroadcastChannel (and postMessage `source`) the callback page announces the result on. */
export const OAUTH2_MESSAGE_CHANNEL = 'landflow-oauth2';

/** n8n's grant types: authorization code with PKCE (the default), plain authorization code, client credentials. */
export type OAuth2GrantType = 'pkce' | 'authorizationCode' | 'clientCredentials';

/** What the callback page posts to the window that opened it (and on the BroadcastChannel). */
export interface OAuth2CallbackMessage {
  source: typeof OAUTH2_MESSAGE_CHANNEL;
  credentialId?: string;
  ok: boolean;
  message: string;
  account?: string;
}

/** A credential's connection, as GET /api/credentials reports it. Tokens themselves never leave the host. */
export interface OAuth2Status {
  grantType: OAuth2GrantType;
  /** An access token is stored. */
  connected: boolean;
  /** Who the token belongs to ("Connected as …"), from the ID token, the user info URL or the token response. */
  account?: string;
  connectedAt?: string;
  /** When the access token expires; absent when the provider didn't say. */
  expiresAt?: string;
  /** The access token is past its expiry. */
  expired: boolean;
  /** A new access token can be had without the user: a refresh token, or the client credentials grant. */
  refreshable: boolean;
  scope?: string;
  /** The last refresh or token request failed with this; Reconnect usually fixes it. */
  error?: string;
}

export interface OAuth2Preset {
  id: string;
  name: string;
  /** Fields of the OAuth2 API credential the preset fills in. */
  values: {
    authUrl: string;
    accessTokenUrl: string;
    scope: string;
    authQueryParameters?: string;
    authentication?: 'header' | 'body';
    userInfoUrl?: string;
  };
  /** Where to register the OAuth app (and its redirect URL). */
  docsUrl: string;
  hint?: string;
}

/** Providers whose URLs and usual scopes the dialog can fill in. Scopes are a starting point: add what your nodes need. */
export const OAUTH2_PRESETS: OAuth2Preset[] = [
  {
    id: 'google',
    name: 'Google',
    values: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      accessTokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'openid email profile',
      // A refresh token is only issued with offline access, and again on a repeated consent only with prompt=consent.
      authQueryParameters: 'access_type=offline&prompt=consent',
      authentication: 'body',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    },
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    hint: 'Create an OAuth client ID of type “Web application”. Add API scopes such as https://www.googleapis.com/auth/spreadsheets.',
  },
  {
    id: 'github',
    name: 'GitHub',
    values: {
      authUrl: 'https://github.com/login/oauth/authorize',
      accessTokenUrl: 'https://github.com/login/oauth/access_token',
      scope: 'read:user repo',
      authentication: 'body',
      userInfoUrl: 'https://api.github.com/user',
    },
    docsUrl: 'https://github.com/settings/developers',
    hint: 'Register an OAuth App (Settings → Developer settings). Its tokens do not expire unless you enable expiring tokens on a GitHub App.',
  },
  {
    id: 'slack',
    name: 'Slack',
    values: {
      authUrl: 'https://slack.com/oauth/v2/authorize',
      accessTokenUrl: 'https://slack.com/api/oauth.v2.access',
      scope: 'chat:write,channels:read',
      authentication: 'body',
    },
    docsUrl: 'https://api.slack.com/apps',
    hint: 'Bot scopes are comma-separated. With token rotation on, Slack issues refresh tokens and Landflow refreshes them.',
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    values: {
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      accessTokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scope: 'openid profile email offline_access User.Read',
      authentication: 'body',
      userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    },
    docsUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    hint: 'Register an app (platform: Web). Replace “common” with your tenant ID for single-tenant apps; offline_access gives a refresh token.',
  },
  {
    id: 'notion',
    name: 'Notion',
    values: {
      authUrl: 'https://api.notion.com/v1/oauth/authorize',
      accessTokenUrl: 'https://api.notion.com/v1/oauth/token',
      scope: '',
      authQueryParameters: 'owner=user',
      authentication: 'header',
    },
    docsUrl: 'https://www.notion.so/profile/integrations',
    hint: 'Create a public integration. Notion has no scopes: the user picks the pages to share on the consent screen.',
  },
  {
    id: 'discord',
    name: 'Discord',
    values: {
      authUrl: 'https://discord.com/oauth2/authorize',
      accessTokenUrl: 'https://discord.com/api/oauth2/token',
      scope: 'identify',
      authentication: 'body',
      userInfoUrl: 'https://discord.com/api/users/@me',
    },
    docsUrl: 'https://discord.com/developers/applications',
    hint: 'Add the redirect URL under OAuth2 in your application. Bots in servers use a bot token (Discord Bot API credential) instead.',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    values: {
      authUrl: 'https://app.hubspot.com/oauth/authorize',
      accessTokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      scope: 'oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read crm.objects.deals.write',
      authentication: 'body',
    },
    docsUrl: 'https://developers.hubspot.com/docs/api/oauth-quickstart-guide',
    hint: 'Create a public app (Developer account → Apps) and add the redirect URL. HubSpot access tokens last 30 minutes; Landflow refreshes them.',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    values: {
      authUrl: 'https://airtable.com/oauth2/v1/authorize',
      accessTokenUrl: 'https://airtable.com/oauth2/v1/token',
      scope: 'data.records:read data.records:write schema.bases:read user.email:read',
      authentication: 'header',
      userInfoUrl: 'https://api.airtable.com/v0/meta/whoami',
    },
    docsUrl: 'https://airtable.com/create/oauth',
    hint: 'Register an OAuth integration and add the redirect URL. Airtable requires PKCE; access tokens last 60 minutes and refresh tokens rotate.',
  },
];
