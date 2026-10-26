/**
 * `$secrets` in the credentials Landflow uses itself, outside nodes, against a fake Vault and a local echo server:
 * agents' models (the OpenAI model list and the model an agent runs with), agents' Slack channels (bot token and
 * signing secret) and the Telegram channel's node call, alert channels (Telegram credential, webhook URL and signing
 * secret; also the governance notices that use them), and the source control (Git) token. Each is resolved at use
 * time with the same cache, fails naming the reference, and is redacted from what Landflow keeps.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ExecuteRequest, type JsonObject } from '@landflow/protocol';
import type { SourceControlConfig } from '@/lib/shared/sync';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-secrets-outside-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_SECRETS_CACHE_TTL: '60' });
delete process.env.LANDFLOW_ENVIRONMENT;
delete process.env.LANDFLOW_GIT_TOKEN;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { credentials } = await import('@/lib/server/credentials/vault');
const secrets = await import('@/lib/server/secrets');
const { agentModel, modelOptions } = await import('@/lib/server/agents/models');
const { slackCredentialFor, slackCredentialsWithSecret, slackSignature, verifySlackRequest } = await import('@/lib/server/slack');
const { sendThrough, signature } = await import('@/lib/server/alerts/channels');
const { alertStore } = await import('@/lib/server/alerts/store');
const { testNotice } = await import('@/lib/server/alerts/message');
const { sendNotice } = await import('@/lib/server/governance/notify');
const { resolvedTokenFor, tokenFor, SourceControlError } = await import('@/lib/server/sync/git');
const { defineCredentialType, defineNode, definePlugin } = await import('@landflow/sdk');
const { fakeVault, echoServer } = await import('./fake-secret-stores');

const OPENAI_KEY = 'sk-from-vault-123456';
const SLACK_TOKEN = 'xoxb-from-vault-7890';
const SLACK_SIGNING = 'slack-signing-from-vault';
const BOT_TOKEN = '4242:bot-token-from-vault';
const HOOK_SECRET = 'hook-signing-from-vault';
const GIT_TOKEN = 'ghp_fromvault0000111122223333';

/** What the test Telegram node was given (the agent channel calls it through the registry, like this). */
let telegramGot: string | undefined;
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'messaging', name: 'Messaging (test)', version: '1.0.0', language: 'typescript' },
    credentialTypes: [
      defineCredentialType({
        name: 'slackApi',
        displayName: 'Slack API',
        properties: [
          { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
          { name: 'signingSecret', displayName: 'Signing Secret', type: 'string', default: '', typeOptions: { password: true } },
        ],
      }),
      defineCredentialType({
        name: 'telegramApi',
        displayName: 'Telegram API',
        properties: [
          { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.telegram.org' },
        ],
      }),
    ],
    nodes: [
      defineNode({
        description: { name: 'telegram', displayName: 'Telegram', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], credentials: [{ name: 'telegramApi', required: true }], properties: [] },
        async execute(ctx) {
          telegramGot = String(ctx.getCredentials<JsonObject>('telegramApi').accessToken);
          return [[{ json: { token: telegramGot } }]];
        },
      }),
    ],
  }),
);

let vault: Awaited<ReturnType<typeof fakeVault>>;
let echo: Awaited<ReturnType<typeof echoServer>>;

beforeAll(async () => {
  await ensureBootstrapped();
  vault = await fakeVault({ rootToken: 'root-token-abcdef' });
  echo = await echoServer();
  vault.kv.secret = {
    openai: { key: OPENAI_KEY },
    slack: { token: SLACK_TOKEN, signing: SLACK_SIGNING },
    telegram: { token: BOT_TOKEN },
    hook: { url: `${echo.url}/hook`, secret: HOOK_SECRET },
    git: { token: GIT_TOKEN },
  };
  secrets.externalSecrets.create({ name: 'vault', kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'root-token-abcdef' } });
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  await vault.close();
  await echo.close();
});

describe("agents' models", () => {
  it('lists OpenAI models and builds the agent’s model with a key read from the secret store', async () => {
    const openAi = credentials.create({ name: 'Vault OpenAI', type: 'core.openAiApi', data: { apiKey: '{{ $secrets.vault.openai.key }}', baseUrl: echo.url } });
    await modelOptions('openai', { credentialId: openAi.id });
    const sent = echo.requests.at(-1)!;
    expect(sent.path).toBe('/models');
    expect(sent.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    const model = await agentModel({ provider: 'openai', model: 'gpt-test', credential: { id: openAi.id, name: openAi.name } });
    expect(model.model).toBe('gpt-test');
    // The value is remembered for redaction; the saved credential keeps the reference.
    expect(secrets.redactText(`key ${OPENAI_KEY}`)).toBe(`key ${secrets.REDACTED}`);
    expect(JSON.stringify(credentials.get(openAi.id))).not.toContain(OPENAI_KEY);
  });

  it('fails naming the reference when the secret is missing', async () => {
    const broken = credentials.create({ name: 'Broken OpenAI', type: 'core.openAiApi', data: { apiKey: '{{ $secrets.vault.openai.nope }}', baseUrl: echo.url } });
    await expect(agentModel({ provider: 'openai', model: 'gpt-test', credential: { id: broken.id, name: broken.name } })).rejects.toThrow(/External secret \$secrets\.vault\.openai has no key “nope”/);
  });
});

describe("agents' channels", () => {
  it('reads a Slack channel’s bot token and signing secret from the store, and verifies requests with it', async () => {
    const app = credentials.create({ name: 'Vault Slack', type: 'messaging.slackApi', data: { accessToken: '{{ $secrets.vault.slack.token }}', baseUrl: echo.url, signingSecret: '{{ $secrets.vault.slack.signing }}' } });
    const resolved = await slackCredentialFor({ id: app.id, name: app.name });
    expect(resolved).toEqual({ accessToken: SLACK_TOKEN, baseUrl: echo.url, signingSecret: SLACK_SIGNING });
    const all = await slackCredentialsWithSecret();
    expect(all.find((c) => c.id === app.id)?.credential.signingSecret).toBe(SLACK_SIGNING);
    const body = 'payload=%7B%7D';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({ 'x-slack-request-timestamp': timestamp, 'x-slack-signature': slackSignature(SLACK_SIGNING, timestamp, body) });
    expect(verifySlackRequest(resolved.signingSecret!, headers, body).ok).toBe(true);
  });

  it('gives the Telegram channel’s node call the resolved bot token (through the node wrapper), redacted in its output', async () => {
    const bot = credentials.create({ name: 'Vault bot', type: 'messaging.telegramApi', data: { accessToken: '{{ $secrets.vault.telegram.token }}' } });
    const resolved = registry.resolve('messaging.telegram');
    if ('error' in resolved) throw new Error(resolved.error);
    // What lib/server/agents/triggers.ts sends: the credential's saved data, as the channel's node call.
    const request: ExecuteRequest = {
      protocol: PROTOCOL_VERSION,
      executionId: 'agch_test',
      workflowId: 'agent:test',
      mode: 'trigger',
      node: { id: 'ch1', name: 'Telegram', type: 'messaging.telegram', typeVersion: 1 },
      parameters: {},
      itemParameters: [{}],
      inputs: [[{ json: {} }]],
      credentials: { telegramApi: credentials.dataFor({ id: bot.id, name: bot.name }, 'messaging.telegramApi') },
    };
    const response = await resolved.execute(request);
    expect(telegramGot).toBe(BOT_TOKEN);
    expect(response.outputs[0][0].json.token).toBe(secrets.REDACTED);
  });
});

describe('alert channels', () => {
  it('sends Telegram alerts with the bot token from the store', async () => {
    const bot = credentials.create({ name: 'Alerts bot', type: 'messaging.telegramApi', data: { accessToken: '{{ $secrets.vault.telegram.token }}', baseUrl: echo.url } });
    const answer = await sendThrough({ id: 'ach_t', name: 'Ops', kind: 'telegram', config: { credentialId: bot.id, chatId: '42' } }, testNotice());
    expect(answer).toBe('Telegram accepted it');
    expect(echo.requests.at(-1)!.path).toBe(`/bot${BOT_TOKEN}/sendMessage`);
  });

  it('accepts a $secrets webhook URL and signing secret, resolves them when sending, and redacts a refusal', async () => {
    const channel = alertStore.createChannel({ name: 'TMP vault hook', kind: 'webhook', config: { url: '{{ $secrets.vault.hook.url }}', secret: '{{ $secrets.vault.hook.secret }}' } });
    const stored = alertStore.channelForSending(channel.id)!;
    expect(stored.config.url).toBe('{{ $secrets.vault.hook.url }}');
    await sendThrough(stored, testNotice());
    const sent = echo.requests.at(-1)!;
    expect(sent.path).toBe('/hook');
    expect(sent.headers['x-landflow-signature']).toBe(signature(HOOK_SECRET, String(sent.headers['x-landflow-timestamp']), sent.body));
    // Governance notices (publish and promotion requests) go through the same resolution.
    await sendNotice(channel.id, { subject: 'Approve', text: 'please', event: 'publish_request.created', payload: {} });
    expect(echo.requests.at(-1)!.path).toBe('/hook');
    // A missing reference fails with the reference, and nothing that quotes a value gets out.
    const broken = alertStore.createChannel({ name: 'TMP broken hook', kind: 'webhook', config: { url: '{{ $secrets.vault.hook.nope }}' } });
    await expect(sendThrough(alertStore.channelForSending(broken.id)!, testNotice())).rejects.toThrow(/External secret \$secrets\.vault\.hook has no key “nope”/);
    // A plain URL is still validated.
    expect(() => alertStore.createChannel({ name: 'TMP bad', kind: 'webhook', config: { url: 'not a url' } })).toThrow();
  });
});

describe('the source control token', () => {
  const config = (credentialId: string) => ({ repository: 'https://git.example.test/repo.git', branch: 'main', directory: '', credentialId, authorName: 'Landflow', authorEmail: 'landflow@example.test' }) as unknown as SourceControlConfig;

  it('reads the token from the store right before git runs; the view only names the credential', async () => {
    const gitCredential = credentials.create({ name: 'Vault git', type: 'core.httpBearerAuth', data: { token: '{{ $secrets.vault.git.token }}' } });
    expect(tokenFor(config(gitCredential.id))).toMatchObject({ source: 'credential', credentialName: 'Vault git', token: '{{ $secrets.vault.git.token }}' });
    expect(await resolvedTokenFor(config(gitCredential.id))).toEqual({ token: GIT_TOKEN, source: 'credential', credentialName: 'Vault git' });
    expect(secrets.redactText(`https://x-access-token:${GIT_TOKEN}@git.example.test`)).not.toContain(GIT_TOKEN);
  });

  it('fails as a source control error naming the reference', async () => {
    const broken = credentials.create({ name: 'Broken git', type: 'core.httpBearerAuth', data: { token: '{{ $secrets.vault.git.nope }}' } });
    const failure = resolvedTokenFor(config(broken.id));
    await expect(failure).rejects.toBeInstanceOf(SourceControlError);
    await expect(resolvedTokenFor(config(broken.id))).rejects.toThrow(/External secret \$secrets\.vault\.git has no key “nope”/);
  });
});
