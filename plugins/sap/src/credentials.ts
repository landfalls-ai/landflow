/**
 * Credential types (spec 1.2): Basic (a communication user), OAuth 2.0 with PKCE (Public Edition, through the host's generic OAuth2
 * type), OAuth 2.0 client credentials (Private Edition), the API Hub sandbox key, and the shared secret of the event trigger. The
 * plugin reads `accessToken` from the data on every call and caches nothing.
 */
import { NodeOperationError, defineCredentialType, type GetCredentials, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { SapClient, type SapAuth } from './odata/client';
import { checkCustomPath } from './odata/query';

export const SANDBOX_URL = 'https://sandbox.api.sap.com/s4hanacloud';
export const SANDBOX_KEY_HEADER = 'APIKey';

export type Authentication = 'basic' | 'oAuth2' | 'oAuth2Client' | 'sandbox';

interface Common {
  baseUrl?: string;
  sapClient?: string;
  allowedServices?: string;
  environment?: string;
  testService?: string;
}
export interface BasicCredential extends Common {
  user?: string;
  password?: string;
}
export interface OAuthCredential extends Common {
  accessToken?: string;
  clientId?: string;
}
export interface SandboxCredential extends Common {
  apiKey?: string;
}
export interface EventCredential {
  headerName?: string;
  secret?: string;
}

const baseUrlField = (placeholder = 'https://my123456-api.s4hana.cloud.sap'): PropertyDescriptor => ({
  name: 'baseUrl',
  displayName: 'API Base URL',
  type: 'string',
  required: true,
  default: '',
  placeholder,
  description: 'The tenant API host (it carries -api in Public Edition), https only. Never computed: copy it from the communication arrangement. The operator can limit hosts with LANDFLOW_SAP_ALLOWED_HOSTS',
});
const common: PropertyDescriptor[] = [
  { name: 'sapClient', displayName: 'SAP Client', type: 'string', default: '', placeholder: '100', description: 'Private Edition only: the sap-client query parameter added to every call' },
  { name: 'allowedServices', displayName: 'Allowed Services', type: 'string', default: '', placeholder: 'API_BUSINESS_PARTNER, API_SALES_ORDER_SRV', description: 'Optional comma list that narrows what flows using this credential may reach (a service id or the last part of a custom path). Empty: any' },
  {
    name: 'environment',
    displayName: 'Environment',
    type: 'options',
    default: 'test',
    options: [
      { name: 'Test', value: 'test' },
      { name: 'Production', value: 'production', description: 'Labelled PROD in spans and errors' },
    ],
    description: 'A label only: the plugin does not know what the tenant really is. Use one credential per intent (a read-only arrangement and a separate write one)',
  },
  { name: 'testService', displayName: 'Service for Test Connection', type: 'string', default: 'API_BUSINESS_PARTNER', description: 'Test connection reads one row ($top=1) of this service, which also proves the communication arrangement exists' },
];
const hidden = (name: string, displayName: string, value: string): PropertyDescriptor => ({ name, displayName, type: 'hidden', default: value });

async function testRead(data: Common, auth: SapAuth, ctx: { http: ConstructorParameters<typeof SapClient>[0]['fetch'] }) {
  const service = String(data.testService || 'API_BUSINESS_PARTNER').trim();
  const path = /^\//.test(service) ? checkCustomPath(service) : `/sap/opu/odata/sap/${service}`;
  const entity = path.endsWith('API_BUSINESS_PARTNER') ? 'A_BusinessPartner' : '';
  const client = new SapClient({ baseUrl: String(data.baseUrl ?? ''), auth, fetch: ctx.http, ...(data.sapClient && { sapClient: data.sapClient }), timeoutMs: 15_000 });
  // The service root lists the entity sets; a known first set gets a $top=1 read, which is the cheapest proof of access.
  const target = entity ? `${path}/${entity}` : path;
  await client.get(target, { ...(entity && { query: '$top=1' }), context: { service, operation: 'test connection', ...(entity && { entitySet: entity }) } });
  return `Reached ${client.base.host}${environmentSuffix(data.environment)}`;
}
const environmentSuffix = (environment?: string) => (environment === 'production' ? ' (PROD)' : '');

export const sapS4hanaBasicApi = defineCredentialType<BasicCredential & JsonObject>({
  name: 'sapS4hanaBasicApi',
  displayName: 'SAP S/4HANA Cloud (communication user)',
  icon: 'file:sap.svg',
  documentationUrl: 'https://help.sap.com/docs/SAP_S4HANA_CLOUD',
  description: 'A communication user and password from a communication arrangement. Dedicate one least-privilege user per intent: a read-only arrangement and a separate one for writes.',
  properties: [
    baseUrlField(),
    { name: 'user', displayName: 'Communication User', type: 'string', required: true, default: '' },
    { name: 'password', displayName: 'Password', type: 'string', required: true, typeOptions: { password: true }, default: '' },
    ...common,
  ],
  test: (data, ctx) =>
    testRead(data, { headers: { authorization: `Basic ${Buffer.from(`${data.user ?? ''}:${data.password ?? ''}`).toString('base64')}` }, identity: String(data.user ?? '') }, ctx)
      .then((message) => ({ ok: true, message }))
      .catch((error: Error) => ({ ok: false, message: error.message })),
});

const oauthTest = (data: OAuthCredential & JsonObject, ctx: Parameters<typeof testRead>[2]) =>
  testRead(data, { headers: { authorization: `Bearer ${data.accessToken ?? ''}` }, identity: String(data.clientId ?? 'oauth') }, ctx)
    .then((message) => ({ ok: true, message }))
    .catch((error: Error) => ({ ok: false, message: error.message }));

/**
 * Public Edition: authorization code with PKCE; the user signs in with a personal SAP login (not the communication user). The
 * authorization and token URLs are fields to fill from the tenant host. The token URL pattern is from a third-party page and the
 * authorization path is a guess: UNVERIFIED (spec 1.2).
 */
export const sapS4hanaOAuth2Api = defineCredentialType<OAuthCredential & JsonObject>({
  name: 'sapS4hanaOAuth2Api',
  displayName: 'SAP S/4HANA Cloud OAuth2 (PKCE)',
  icon: 'file:sap.svg',
  documentationUrl: 'https://help.sap.com/docs/SAP_S4HANA_CLOUD',
  description:
    'Sign in with an SAP user through the arrangement\'s OAuth 2.0 client (public client, authorization code with PKCE). Add the redirect URL shown below to the communication system, then Connect. A run acts as that person and stops working when the refresh token does.',
  extends: ['oAuth2Api'],
  properties: [
    hidden('grantType', 'Grant Type', 'pkce'),
    hidden('authentication', 'Client Authentication', 'body'),
    { name: 'authUrl', displayName: 'Authorization URL', type: 'string', required: true, default: '', placeholder: 'https://my123456-api.s4hana.cloud.sap/sap/public/bc/sec/oauth2/authorize' },
    { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'string', required: true, default: '', placeholder: 'https://my123456-api.s4hana.cloud.sap/sap/public/bc/sec/oauth2/token' },
    baseUrlField(),
    ...common,
  ],
  test: oauthTest,
});

/** Private Edition: client credentials against the system's own OAuth setup (`/sap/bc/sec/oauth2/token?sap-client=<n>`, UNVERIFIED). */
export const sapS4hanaOAuth2ClientApi = defineCredentialType<OAuthCredential & JsonObject>({
  name: 'sapS4hanaOAuth2ClientApi',
  displayName: 'SAP S/4HANA OAuth2 (client credentials, Private Edition)',
  icon: 'file:sap.svg',
  documentationUrl: 'https://nango.dev/docs/api-integrations/sap-odata-oauth2-cc/connect',
  description: 'For S/4HANA Cloud Private Edition and on-premise systems, where a client is set up with SOAUTH2. Public Edition is said not to allow this grant: use the PKCE type there.',
  extends: ['oAuth2Api'],
  properties: [
    hidden('grantType', 'Grant Type', 'clientCredentials'),
    hidden('authentication', 'Client Authentication', 'header'),
    { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'string', required: true, default: '', placeholder: 'https://host:port/sap/bc/sec/oauth2/token?sap-client=100' },
    baseUrlField('https://s4.example.com:44300'),
    ...common,
  ],
  test: oauthTest,
});

export const sapSandboxApi = defineCredentialType<SandboxCredential & JsonObject>({
  name: 'sapSandboxApi',
  displayName: 'SAP API Business Hub sandbox',
  icon: 'file:sap.svg',
  documentationUrl: 'https://api.sap.com/',
  description: `The Business Accelerator Hub sandbox serves read-only sample data. The key goes in the ${SANDBOX_KEY_HEADER} header (the header name is UNVERIFIED). Needs a free SAP account: the user's decision, never used by a test.`,
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', required: true, typeOptions: { password: true }, default: '', description: 'A development key only' },
    { ...baseUrlField(SANDBOX_URL), default: SANDBOX_URL, required: false },
    { ...common[1] },
    { ...common[2], default: 'test' },
    common[3],
  ],
  test: (data, ctx) =>
    testRead({ ...data, baseUrl: data.baseUrl || SANDBOX_URL }, { headers: { [SANDBOX_KEY_HEADER]: String(data.apiKey ?? '') }, identity: 'sandbox' }, ctx)
      .then((message) => ({ ok: true, message }))
      .catch((error: Error) => ({ ok: false, message: error.message })),
});

export const sapEventApi = defineCredentialType<EventCredential & JsonObject>({
  name: 'sapEventApi',
  displayName: 'SAP event delivery secret',
  icon: 'file:sap.svg',
  description: 'The shared secret the SAP Event trigger checks on every delivery. Configure the same header and value on the event broker delivery point (an SAP Event Mesh or Advanced Event Mesh webhook).',
  properties: [
    { name: 'headerName', displayName: 'Header Name', type: 'string', default: 'x-sap-event-secret', description: 'The request header the broker sends the secret in' },
    { name: 'secret', displayName: 'Secret', type: 'string', required: true, typeOptions: { password: true }, default: '', description: 'At least 16 characters' },
  ],
});

export const CREDENTIAL_TYPES = [sapS4hanaBasicApi, sapS4hanaOAuth2Api, sapS4hanaOAuth2ClientApi, sapSandboxApi, sapEventApi];

/** The credential type name of an `authentication` value. */
export const CREDENTIAL_OF: Record<Authentication, string> = {
  basic: 'sapS4hanaBasicApi',
  oAuth2: 'sapS4hanaOAuth2Api',
  oAuth2Client: 'sapS4hanaOAuth2ClientApi',
  sandbox: 'sapSandboxApi',
};

export interface Resolved {
  baseUrl: string;
  auth: SapAuth;
  sapClient?: string;
  allowedServices: string[];
  environment: string;
}

const splitList = (text: unknown) =>
  String(text ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The connection details of the credential the `authentication` parameter names; when only another type was sent (a load-options call
 * does not see the parameter) that one is used.
 */
export function resolveCredentials(getCredentials: GetCredentials, authentication: unknown): Resolved {
  const order: Authentication[] = ['basic', 'oAuth2', 'oAuth2Client', 'sandbox'];
  const wanted = (order.includes(authentication as Authentication) ? authentication : 'basic') as Authentication;
  let kind: Authentication | undefined;
  let data: (Common & JsonObject) | undefined = getCredentials<Common & JsonObject>(CREDENTIAL_OF[wanted], { optional: true });
  if (data) kind = wanted;
  else {
    for (const other of order) {
      data = getCredentials<Common & JsonObject>(CREDENTIAL_OF[other], { optional: true });
      if (data) {
        kind = other;
        break;
      }
    }
  }
  if (!data || !kind) getCredentials(CREDENTIAL_OF[wanted]); // throws "No ... credentials were provided"
  const d = data as Common & JsonObject;
  const base = {
    ...(String(d.sapClient ?? '').trim() && { sapClient: String(d.sapClient).trim() }),
    allowedServices: splitList(d.allowedServices),
    environment: d.environment === 'production' ? 'production' : 'test',
  };
  if (kind === 'basic') {
    const user = String(d.user ?? '');
    const password = String(d.password ?? '');
    if (!user || !password) throw new NodeOperationError('The SAP credential has no user or password');
    return { ...base, baseUrl: String(d.baseUrl ?? ''), auth: { headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }, identity: user, environment: base.environment } };
  }
  if (kind === 'sandbox') {
    const key = String(d.apiKey ?? '').trim();
    if (!key) throw new NodeOperationError('The sandbox credential has no API key');
    return { ...base, baseUrl: String(d.baseUrl || SANDBOX_URL), auth: { headers: { [SANDBOX_KEY_HEADER]: key }, identity: 'sandbox', environment: base.environment } };
  }
  const token = String(d.accessToken ?? '');
  if (!token) throw new NodeOperationError('The SAP OAuth2 credential is not connected', { description: 'Open the credential and press Connect (or Get token).' });
  return { ...base, baseUrl: String(d.baseUrl ?? ''), auth: { headers: { authorization: `Bearer ${token}` }, identity: String(d.clientId ?? 'oauth'), environment: base.environment } };
}
