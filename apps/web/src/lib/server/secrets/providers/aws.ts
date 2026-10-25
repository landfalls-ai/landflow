/**
 * AWS Secrets Manager over its JSON API (`ListSecrets`, `GetSecretValue`), signed with Signature Version 4 here
 * (node:crypto, no SDK): the provider only ever uses the keys in its settings, or with "environment" auth the
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN variables. It never reads ~/.aws or instance
 * metadata. An endpoint setting points it at LocalStack or another compatible server.
 *
 * Secret names may hold `/` (`prod/db`): `{{ $secrets.aws['prod/db'].password }}`. A secret string that is a JSON
 * object reads as its keys; anything else (and binary secrets, as base64) as text.
 */
import { createHash, createHmac } from 'node:crypto';
import { checkUrl, requestJson } from './http';
import { parseSecretText, SecretProviderError, str, withEnvironment, type ProviderConfig, type ProviderContext, type ProviderDefinition, type SecretsProvider, type SecretValue } from './types';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

export interface SigV4Input {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}

/** RFC 3986 encoding as SigV4 wants it (unreserved characters stay). */
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The request's headers with `x-amz-date`, `x-amz-security-token` (with a session token) and `authorization` added. */
export function signV4(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: url.host, 'x-amz-date': amzDate, ...(input.sessionToken && { 'x-amz-security-token': input.sessionToken }) };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signed = Object.keys(lower).sort();
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath = url.pathname.split('/').map((segment) => encode(decodeURIComponent(segment))).join('/') || '/';
  const canonical = [input.method.toUpperCase(), canonicalPath, canonicalQuery, ...signed.map((k) => `${k}:${lower[k]}`), '', signed.join(';'), sha256(input.body)].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` };
}

interface Keys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function keysOf(config: ProviderConfig): Keys {
  if (str(config, 'auth') === 'environment') {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) throw new SecretProviderError('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set on the host');
    return { accessKeyId, secretAccessKey, ...(process.env.AWS_SESSION_TOKEN?.trim() && { sessionToken: process.env.AWS_SESSION_TOKEN.trim() }) };
  }
  const accessKeyId = str(config, 'accessKeyId');
  const secretAccessKey = str(config, 'secretAccessKey');
  if (!accessKeyId || !secretAccessKey) throw new SecretProviderError('Enter the access key ID and the secret access key');
  return { accessKeyId, secretAccessKey, ...(str(config, 'sessionToken') && { sessionToken: str(config, 'sessionToken') }) };
}

class AwsSecretsManager implements SecretsProvider {
  private readonly region: string;
  private readonly endpoint: string;
  private readonly prefix: string;
  private readonly keys: Keys;

  constructor(
    config: ProviderConfig,
    private readonly context: ProviderContext,
  ) {
    this.region = str(config, 'region');
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(this.region)) throw new SecretProviderError('Enter an AWS region such as eu-west-1');
    this.endpoint = str(config, 'endpoint') ? checkUrl(str(config, 'endpoint'), 'The endpoint') : `https://secretsmanager.${this.region}.amazonaws.com`;
    this.prefix = withEnvironment(config.namePrefix, context.environment);
    this.keys = keysOf(config);
  }

  private async call<T>(action: string, payload: Record<string, unknown>, allow404 = false): Promise<T | undefined> {
    const body = JSON.stringify(payload);
    const url = `${this.endpoint}/`;
    const headers = signV4({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `secretsmanager.${action}` },
      body,
      region: this.region,
      service: 'secretsmanager',
      ...this.keys,
    });
    try {
      return await requestJson<T>(this.context.fetch, url, 'AWS Secrets Manager', { method: 'POST', headers, body });
    } catch (error) {
      // A missing secret is a 400 with ResourceNotFoundException.
      if (allow404 && error instanceof SecretProviderError && /ResourceNotFound|can.t find|not found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  async listNames(): Promise<string[]> {
    const names: string[] = [];
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await this.call<{ SecretList?: Array<{ Name?: string }>; NextToken?: string }>('ListSecrets', {
        MaxResults: 100,
        ...(next && { NextToken: next }),
        ...(this.prefix && { Filters: [{ Key: 'name', Values: [this.prefix] }] }),
      });
      for (const secret of response?.SecretList ?? []) if (secret.Name?.startsWith(this.prefix)) names.push(secret.Name.slice(this.prefix.length));
      next = response?.NextToken;
      if (!next) break;
    }
    return names.filter(Boolean).sort();
  }

  async getSecret(name: string): Promise<SecretValue | undefined> {
    const response = await this.call<{ SecretString?: string; SecretBinary?: string }>('GetSecretValue', { SecretId: `${this.prefix}${name}` }, true);
    if (!response) return undefined;
    if (typeof response.SecretString === 'string') return parseSecretText(response.SecretString);
    if (typeof response.SecretBinary === 'string') return response.SecretBinary;
    return undefined;
  }

  async test(): Promise<string> {
    const names = await this.listNames();
    return `${names.length} secret${names.length === 1 ? '' : 's'} in ${this.region}${this.prefix ? ` under ${this.prefix}` : ''}`;
  }
}

export const awsProvider: ProviderDefinition = {
  kind: 'awsSecretsManager',
  label: 'AWS Secrets Manager',
  description: 'Secrets of one region, signed with SigV4',
  defaultName: 'aws',
  fields: [
    { name: 'region', label: 'Region', type: 'string', required: true, placeholder: 'eu-west-1' },
    {
      name: 'auth',
      label: 'Credentials',
      type: 'options',
      default: 'accessKey',
      options: [
        { value: 'accessKey', label: 'Access key' },
        { value: 'environment', label: 'Host environment variables (AWS_ACCESS_KEY_ID …)' },
      ],
    },
    { name: 'accessKeyId', label: 'Access key ID', type: 'string', required: true, showWhen: { field: 'auth', values: ['accessKey'] } },
    { name: 'secretAccessKey', label: 'Secret access key', type: 'password', required: true, showWhen: { field: 'auth', values: ['accessKey'] } },
    { name: 'sessionToken', label: 'Session token', type: 'password', hint: 'For temporary credentials (optional)', showWhen: { field: 'auth', values: ['accessKey'] } },
    { name: 'namePrefix', label: 'Name prefix', type: 'string', placeholder: '{environment}/', hint: 'Only secrets whose names start with this; it is left out of the names' },
    { name: 'endpoint', label: 'Endpoint', type: 'string', placeholder: 'https://secretsmanager.<region>.amazonaws.com', hint: 'For LocalStack or another compatible server' },
  ],
  secretFields: ['secretAccessKey', 'sessionToken'],
  create: (config, context) => new AwsSecretsManager(config, context),
};
