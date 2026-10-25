/**
 * Google Cloud Secret Manager over REST: `projects/{project}/secrets` lists the names, `versions/latest:access`
 * reads a value. Auth is a service account key (the JSON file): a signed JWT is exchanged for an access token at the
 * key's `token_uri` (OAuth 2.0 JWT bearer grant), kept until shortly before it expires. The endpoint can point at an
 * emulator or a private endpoint.
 */
import { createSign } from 'node:crypto';
import { checkUrl, requestJson } from './http';
import { parseSecretText, SecretProviderError, str, withEnvironment, type ProviderConfig, type ProviderContext, type ProviderDefinition, type SecretsProvider, type SecretValue } from './types';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
  private_key_id?: string;
}

function parseKey(text: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(text) as Partial<ServiceAccountKey>;
  } catch {
    throw new SecretProviderError('The service account key is not JSON: paste the whole key file');
  }
  if (!key.client_email || !key.private_key) throw new SecretProviderError('The service account key has no client_email or private_key');
  return key as ServiceAccountKey;
}

/** The JWT a service account signs for the token endpoint. */
export function serviceAccountAssertion(key: ServiceAccountKey, audience: string, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id && { kid: key.private_key_id }) }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: audience, iat: now, exp: now + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

class GcpSecretManager implements SecretsProvider {
  private readonly key: ServiceAccountKey;
  private readonly project: string;
  private readonly endpoint: string;
  private readonly tokenUri: string;
  private readonly prefix: string;
  private access?: { token: string; expiresAt: number };

  constructor(
    config: ProviderConfig,
    private readonly context: ProviderContext,
  ) {
    this.key = parseKey(str(config, 'serviceAccountKey'));
    this.project = str(config, 'projectId') || this.key.project_id || '';
    if (!this.project) throw new SecretProviderError('Enter the project ID (the key file names none)');
    this.endpoint = checkUrl(str(config, 'endpoint') || 'https://secretmanager.googleapis.com', 'The endpoint');
    this.tokenUri = checkUrl(this.key.token_uri || 'https://oauth2.googleapis.com/token', 'The key’s token_uri');
    this.prefix = withEnvironment(config.namePrefix, context.environment);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(this.key, this.tokenUri) }).toString();
    const response = await requestJson<{ access_token?: string; expires_in?: number }>(this.context.fetch, this.tokenUri, 'Google sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response?.access_token) throw new SecretProviderError('Google sign-in answered without an access token');
    this.access = { token: response.access_token, expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000 };
    return this.access.token;
  }

  private async get<T>(path: string, allow404 = false) {
    return requestJson<T>(this.context.fetch, `${this.endpoint}/v1/projects/${encodeURIComponent(this.project)}/${path}`, 'Google Secret Manager', {
      headers: { authorization: `Bearer ${await this.token()}` },
      ...(allow404 && { allow: [404] }),
    });
  }

  async listNames(): Promise<string[]> {
    const names: string[] = [];
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await this.get<{ secrets?: Array<{ name?: string }>; nextPageToken?: string }>(`secrets?pageSize=250${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`);
      for (const secret of response?.secrets ?? []) {
        const name = secret.name?.slice(secret.name.lastIndexOf('/') + 1) ?? '';
        if (name.startsWith(this.prefix)) names.push(name.slice(this.prefix.length));
      }
      next = response?.nextPageToken;
      if (!next) break;
    }
    return names.filter(Boolean).sort();
  }

  async getSecret(name: string): Promise<SecretValue | undefined> {
    if (!/^[\w-]+$/.test(`${this.prefix}${name}`)) return undefined;
    const response = await this.get<{ payload?: { data?: string } }>(`secrets/${encodeURIComponent(`${this.prefix}${name}`)}/versions/latest:access`, true);
    const data = response?.payload?.data;
    return typeof data === 'string' ? parseSecretText(Buffer.from(data, 'base64').toString('utf8')) : undefined;
  }

  async test(): Promise<string> {
    const names = await this.listNames();
    return `${names.length} secret${names.length === 1 ? '' : 's'} in project ${this.project}`;
  }
}

export const gcpProvider: ProviderDefinition = {
  kind: 'gcpSecretManager',
  label: 'Google Cloud Secret Manager',
  description: 'The latest version of each secret in a project, with a service account key',
  defaultName: 'gcp',
  fields: [
    { name: 'serviceAccountKey', label: 'Service account key (JSON)', type: 'textarea', required: true, hint: 'The key file of a service account with the Secret Manager Secret Accessor and Viewer roles' },
    { name: 'projectId', label: 'Project ID', type: 'string', placeholder: 'From the key file' },
    { name: 'namePrefix', label: 'Name prefix', type: 'string', placeholder: '{environment}_', hint: 'Only secrets whose names start with this; it is left out of the names' },
    { name: 'endpoint', label: 'Endpoint', type: 'string', placeholder: 'https://secretmanager.googleapis.com' },
  ],
  secretFields: ['serviceAccountKey'],
  create: (config, context) => new GcpSecretManager(config, context),
};
