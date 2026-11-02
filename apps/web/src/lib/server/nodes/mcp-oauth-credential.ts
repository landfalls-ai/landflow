/**
 * The OAuth2 credential of an MCP server (`core.mcpOAuth2Api`): Connect discovers the server's authorization server,
 * registers Landflow with it when the credential names no client, and signs in with PKCE (lib/server/mcp/oauth.ts). It
 * extends `oAuth2Api`, so the popup, the status, the encrypted token and its refresh are the generic OAuth2 ones.
 */
import { defineCredentialType } from '@landflow/sdk';
import type { PropertyDescriptor } from '@landflow/protocol';

const fixed = (name: string, displayName: string, value: string): PropertyDescriptor => ({ name, displayName, type: 'hidden', default: value });

export const mcpOAuth2ApiCredential = defineCredentialType({
  name: 'mcpOAuth2Api',
  displayName: 'MCP OAuth2 API',
  description:
    'For an MCP server that signs users in with OAuth (the MCP authorization spec): Connect finds the server\'s authorization server, registers Landflow there (dynamic client registration) unless you give a Client ID, and signs in with PKCE. The access token is renewed for you.',
  icon: 'brand:mcp',
  documentationUrl: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization',
  extends: ['oAuth2Api'],
  properties: [
    { name: 'serverUrl', displayName: 'MCP Server URL', type: 'string', default: '', required: true, placeholder: 'https://mcp.example.com/mcp', description: 'The MCP endpoint, as in the MCP Client node' },
    fixed('grantType', 'Grant Type', 'pkce'),
    fixed('authUrl', 'Authorization URL', ''),
    fixed('accessTokenUrl', 'Access Token URL', ''),
    fixed('authentication', 'Client Authentication', ''),
    { name: 'clientId', displayName: 'Client ID', type: 'string', default: '', description: 'Leave empty to register Landflow with the server automatically; fill in for a server that needs a pre-registered client' },
    { name: 'clientSecret', displayName: 'Client Secret', type: 'string', default: '', typeOptions: { password: true }, description: 'Leave empty for a public client' },
    { name: 'scope', displayName: 'Scope', type: 'string', default: '', description: 'Leave empty to use what the server asks for' },
  ],
});
