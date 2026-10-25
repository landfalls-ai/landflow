/**
 * Azure Key Vault secrets over REST (API version 7.4), with a Microsoft Entra app registration: client credentials
 * at `{authority}/{tenant}/oauth2/v2.0/token` for the Key Vault scope. Secret names are the vault's (letters, digits
 * and dashes: `{{ $secrets.azure['db-password'] }}`); a value that is a JSON object reads as its keys. The authority
 * host covers sovereign clouds (and the tests' fake).
 */
import { checkUrl, requestJson } from './http';
import { parseSecretText, SecretProviderError, str, withEnvironment, type ProviderConfig, type ProviderContext, type ProviderDefinition, type SecretsProvider, type SecretValue } from './types';

const API_VERSION = '7.4';

/** The Key Vault resource scope for a vault URL: `https://vault.azure.net/.default`, or the sovereign cloud's. */
function scopeOf(vaultUrl: string): string {
  const host = new URL(vaultUrl).hostname;
  const suffix = /\.vault\.(.+)$/.exec(host)?.[1];
  return `https://vault.${suffix ?? 'azure.net'}/.default`;
}

class AzureKeyVault implements SecretsProvider {
  private readonly vaultUrl: string;
  private readonly authority: string;
  private readonly tenant: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly prefix: string;
  private access?: { token: string; expiresAt: number };

  constructor(
    config: ProviderConfig,
    private readonly context: ProviderContext,
  ) {
    this.vaultUrl = checkUrl(str(config, 'vaultUrl'), 'The vault URL');
    this.authority = checkUrl(str(config, 'authorityHost') || 'https://login.microsoftonline.com', 'The authority host');
    this.tenant = str(config, 'tenantId');
    this.clientId = str(config, 'clientId');
    this.clientSecret = str(config, 'clientSecret');
    if (!this.tenant || !this.clientId || !this.clientSecret) throw new SecretProviderError('Enter the tenant ID, client ID and client secret');
    this.prefix = withEnvironment(config.namePrefix, context.environment);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret, scope: scopeOf(this.vaultUrl) }).toString();
    const response = await requestJson<{ access_token?: string; expires_in?: number | string }>(
      this.context.fetch,
      `${this.authority}/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`,
      'Microsoft Entra sign-in',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    );
    if (!response?.access_token) throw new SecretProviderError('Microsoft Entra sign-in answered without an access token');
    this.access = { token: response.access_token, expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000 };
    return this.access.token;
  }

  private async get<T>(url: string, allow404 = false) {
    return requestJson<T>(this.context.fetch, url, 'Azure Key Vault', { headers: { authorization: `Bearer ${await this.token()}` }, ...(allow404 && { allow: [404] }) });
  }

  async listNames(): Promise<string[]> {
    const names: string[] = [];
    let url: string | undefined = `${this.vaultUrl}/secrets?api-version=${API_VERSION}&maxresults=25`;
    for (let page = 0; url && page < 200; page++) {
      const response: { value?: Array<{ id?: string; attributes?: { enabled?: boolean } }>; nextLink?: string | null } | undefined = await this.get(url);
      for (const secret of response?.value ?? []) {
        if (secret.attributes?.enabled === false) continue;
        const name = secret.id?.slice(secret.id.lastIndexOf('/') + 1) ?? '';
        if (name.startsWith(this.prefix)) names.push(name.slice(this.prefix.length));
      }
      // Only follow next links on the vault itself.
      url = response?.nextLink && response.nextLink.startsWith(`${this.vaultUrl}/`) ? response.nextLink : undefined;
    }
    return names.filter(Boolean).sort();
  }

  async getSecret(name: string): Promise<SecretValue | undefined> {
    if (!/^[0-9A-Za-z-]+$/.test(`${this.prefix}${name}`)) return undefined;
    const response = await this.get<{ value?: string }>(`${this.vaultUrl}/secrets/${encodeURIComponent(`${this.prefix}${name}`)}?api-version=${API_VERSION}`, true);
    return typeof response?.value === 'string' ? parseSecretText(response.value) : undefined;
  }

  async test(): Promise<string> {
    const names = await this.listNames();
    return `${names.length} secret${names.length === 1 ? '' : 's'} in ${new URL(this.vaultUrl).hostname}`;
  }
}

export const azureProvider: ProviderDefinition = {
  kind: 'azureKeyVault',
  label: 'Azure Key Vault',
  description: 'Secrets of one key vault, with an app registration’s client secret',
  defaultName: 'azure',
  fields: [
    { name: 'vaultUrl', label: 'Vault URL', type: 'string', required: true, placeholder: 'https://my-vault.vault.azure.net' },
    { name: 'tenantId', label: 'Tenant ID', type: 'string', required: true },
    { name: 'clientId', label: 'Client ID', type: 'string', required: true },
    { name: 'clientSecret', label: 'Client secret', type: 'password', required: true },
    { name: 'namePrefix', label: 'Name prefix', type: 'string', placeholder: '{environment}-', hint: 'Only secrets whose names start with this; it is left out of the names' },
    { name: 'authorityHost', label: 'Authority host', type: 'string', placeholder: 'https://login.microsoftonline.com', hint: 'For sovereign clouds' },
  ],
  secretFields: ['clientSecret'],
  create: (config, context) => new AzureKeyVault(config, context),
};
