/**
 * The authentication properties of the Webhook and Form Trigger nodes (n8n's names). lib/server/webhook-auth.ts
 * checks calls against them; this module stays free of host imports so node definitions can use it.
 */

export type WebhookAuthentication = 'none' | 'basicAuth' | 'headerAuth' | 'jwtAuth';

/** The `authentication` property: which callers the trigger accepts. */
export function authenticationProperty(variants: WebhookAuthentication[] = ['none', 'basicAuth', 'headerAuth', 'jwtAuth']) {
  const names: Record<WebhookAuthentication, { name: string; description: string }> = {
    none: { name: 'None', description: 'Anyone who knows the URL' },
    basicAuth: { name: 'Basic Auth', description: 'A user name and password (browsers ask for them)' },
    headerAuth: { name: 'Header Auth', description: 'A secret header, such as X-API-Key' },
    jwtAuth: { name: 'JWT Auth', description: 'A signed JWT as “Authorization: Bearer <token>”; its claims arrive as jwtPayload' },
  };
  return {
    name: 'authentication',
    displayName: 'Authentication',
    type: 'options' as const,
    default: 'none',
    noDataExpression: true,
    options: variants.map((value) => ({ value, ...names[value] })),
  };
}

/** The credential each authentication needs. */
export const webhookAuthCredentials = [
  { name: 'httpBasicAuth', required: true, displayOptions: { show: { authentication: ['basicAuth'] } } },
  { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
  { name: 'jwtAuth', required: true, displayOptions: { show: { authentication: ['jwtAuth'] } } },
];

/** `options.ipWhitelist` (n8n's name). */
export const ipWhitelistOption = {
  name: 'ipWhitelist',
  displayName: 'IP(s) Allowlist',
  type: 'string' as const,
  default: '',
  placeholder: '203.0.113.7, 10.0.0.0/8',
  description: 'Only these addresses or CIDR ranges may call (comma-separated; empty: any). Read from X-Forwarded-For, trusted up to LANDFLOW_TRUSTED_PROXIES proxies.',
};
