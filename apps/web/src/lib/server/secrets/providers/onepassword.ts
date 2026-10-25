/**
 * 1Password through a Connect server's REST API (`/v1/vaults`, `/v1/vaults/{id}/items`), with a Connect token.
 * Secret names are item titles (in the vaults the token can read, or the ones listed); a value is the item's fields
 * by label (`$secrets.onepassword['Stripe'].credential`), with `password`, `username` and `credential` also
 * available under those names when a field has that purpose or id. Two items with one title: the first vault wins.
 */
import { checkUrl, requestJson } from './http';
import { SecretProviderError, str, withEnvironment, type ProviderConfig, type ProviderContext, type ProviderDefinition, type SecretsProvider, type SecretValue } from './types';

interface Vault {
  id: string;
  name: string;
}

interface ItemSummary {
  id: string;
  title: string;
  vault?: { id: string };
}

interface Item {
  id: string;
  title: string;
  fields?: Array<{ id?: string; label?: string; value?: string; purpose?: string; type?: string }>;
}

const INDEX_TTL_MS = 60_000;

class OnePasswordConnect implements SecretsProvider {
  private readonly url: string;
  private readonly token: string;
  private readonly vaultFilter: string[];
  private index?: { at: number; items: Map<string, { vaultId: string; itemId: string }> };

  constructor(
    config: ProviderConfig,
    private readonly context: ProviderContext,
  ) {
    this.url = checkUrl(str(config, 'url'), 'The Connect server URL');
    this.token = str(config, 'token');
    if (!this.token) throw new SecretProviderError('Enter the Connect token');
    this.vaultFilter = withEnvironment(config.vaults, context.environment)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private get<T>(path: string, allow404 = false) {
    return requestJson<T>(this.context.fetch, `${this.url}/v1/${path}`, '1Password Connect', { headers: { authorization: `Bearer ${this.token}` }, ...(allow404 && { allow: [404] }) });
  }

  private async vaults(): Promise<Vault[]> {
    const all = (await this.get<Vault[]>('vaults')) ?? [];
    if (!this.vaultFilter.length) return all;
    const wanted = all.filter((v) => this.vaultFilter.includes(v.id) || this.vaultFilter.includes(v.name));
    const missing = this.vaultFilter.filter((f) => !all.some((v) => v.id === f || v.name === f));
    if (missing.length) throw new SecretProviderError(`The Connect token can’t read vault${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);
    return wanted;
  }

  private async items(fresh = false) {
    if (!fresh && this.index && Date.now() - this.index.at < INDEX_TTL_MS) return this.index.items;
    const items = new Map<string, { vaultId: string; itemId: string }>();
    for (const vault of await this.vaults()) {
      for (const item of (await this.get<ItemSummary[]>(`vaults/${encodeURIComponent(vault.id)}/items`)) ?? []) {
        if (item.title && !items.has(item.title)) items.set(item.title, { vaultId: vault.id, itemId: item.id });
      }
    }
    this.index = { at: Date.now(), items };
    return items;
  }

  async listNames(): Promise<string[]> {
    return [...(await this.items(true)).keys()].sort();
  }

  async getSecret(name: string): Promise<SecretValue | undefined> {
    let found = (await this.items()).get(name);
    // Created since the index was built.
    if (!found) found = (await this.items(true)).get(name);
    if (!found) return undefined;
    const item = await this.get<Item>(`vaults/${encodeURIComponent(found.vaultId)}/items/${encodeURIComponent(found.itemId)}`, true);
    if (!item) return undefined;
    const value: Record<string, string> = {};
    for (const field of item.fields ?? []) {
      if (field.value === undefined || field.value === null) continue;
      const label = field.label || field.id;
      if (label && !(label in value)) value[label] = field.value;
    }
    // Well-known fields under fixed keys, whatever their labels say.
    for (const field of item.fields ?? []) {
      if (field.value === undefined || field.value === null) continue;
      const key = field.purpose === 'PASSWORD' ? 'password' : field.purpose === 'USERNAME' ? 'username' : field.id === 'credential' ? 'credential' : undefined;
      if (key && !(key in value)) value[key] = field.value;
    }
    return value;
  }

  async test(): Promise<string> {
    const vaults = await this.vaults();
    const names = await this.listNames();
    return `${names.length} item${names.length === 1 ? '' : 's'} in ${vaults.length} vault${vaults.length === 1 ? '' : 's'}`;
  }
}

export const onePasswordProvider: ProviderDefinition = {
  kind: 'onePassword',
  label: '1Password',
  description: 'Items through a 1Password Connect server',
  defaultName: 'onepassword',
  fields: [
    { name: 'url', label: 'Connect server URL', type: 'string', required: true, placeholder: 'http://localhost:8080' },
    { name: 'token', label: 'Connect token', type: 'password', required: true },
    { name: 'vaults', label: 'Vaults', type: 'string', placeholder: 'All vaults the token can read', hint: 'Vault names or ids, comma-separated; {environment} is the instance’s environment' },
  ],
  secretFields: ['token'],
  create: (config, context) => new OnePasswordConnect(config, context),
};
