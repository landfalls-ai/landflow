/** `login`, `logout` and `whoami`. */
import { Client } from '../client';
import { flag, type Command, type Context } from '../command';
import { DEFAULT_URL, maskKey, normalizeUrl, readConfig, removeConfig, writeConfig } from '../config';
import { CliError } from '../errors';
import { fields } from '../output';

interface Viewer {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface Identity {
  user: Viewer | null;
  via: string | null;
  scopes: string[] | null;
  /** The host has sign-in (an older one has no /api/auth/me). */
  auth: boolean;
}

/** Who the connection is: GET /api/auth/me; a host without sign-in answers 404 (no route). */
async function identify(client: Client): Promise<Identity> {
  try {
    const me = await client.get<{ user: Viewer; via?: string; apiKey?: { scopes?: string[] } }>('/api/auth/me');
    return { user: me.user, via: me.via ?? null, scopes: me.apiKey?.scopes ?? null, auth: true };
  } catch (caught) {
    if (caught instanceof CliError && caught.code === 'not_supported') return { user: null, via: null, scopes: null, auth: false };
    throw caught;
  }
}

const describeUser = (identity: Identity) =>
  identity.user ? `${identity.user.name} <${identity.user.email}> (${identity.user.role})${identity.via ? ` via ${identity.via}` : ''}` : identity.auth ? '-' : 'no sign-in on this host';

export const login: Command = {
  name: 'login',
  summary: 'Save the host URL and API key to the config file',
  usage: '[--url <url>] [--api-key <key>] [--no-verify]',
  details: 'Values come from the flags, then LANDFLOW_URL / LANDFLOW_API_KEY, then a prompt when interactive. The key is checked against the host unless --no-verify.',
  flags: { 'no-verify': flag.boolean('Save without checking the key against the host') },
  args: { max: 0 },
  async run(ctx: Context) {
    const { io, connection } = ctx;
    const stored = readConfig(connection.configPath);
    let url = (ctx.flags.url as string | undefined) ?? io.env.LANDFLOW_URL;
    if (!url && io.interactive) url = (await io.prompt(`Landflow URL [${stored.url ?? DEFAULT_URL}]: `)).trim() || stored.url || DEFAULT_URL;
    url = normalizeUrl(url ?? stored.url ?? DEFAULT_URL);
    let apiKey = (ctx.flags['api-key'] as string | undefined) ?? io.env.LANDFLOW_API_KEY;
    if (apiKey === undefined && io.interactive) apiKey = (await io.prompt('API key (lf_…, empty for none): ', { secret: true })).trim();
    apiKey = apiKey?.trim() || undefined;

    let identity: Identity | null = null;
    if (!ctx.flags['no-verify']) {
      identity = await identify(new Client(url, apiKey, io.fetch));
      if (!identity.auth) await new Client(url, apiKey, io.fetch).get('/api/health');
    }
    writeConfig(connection.configPath, { url, ...(apiKey && { apiKey }) });
    const data = { url, apiKey: maskKey(apiKey), configPath: connection.configPath, verified: Boolean(identity), user: identity?.user ?? null };
    return {
      data,
      human: () => `Saved ${connection.configPath}\n${fields([['URL', url], ['API key', data.apiKey ?? 'none'], ['User', identity ? describeUser(identity) : 'not checked']])}`,
    };
  },
};

export const logout: Command = {
  name: 'logout',
  summary: 'Remove the saved URL and API key',
  args: { max: 0 },
  async run(ctx) {
    const removed = removeConfig(ctx.connection.configPath);
    return { data: { configPath: ctx.connection.configPath, removed }, human: () => (removed ? `Removed ${ctx.connection.configPath}` : `Nothing saved at ${ctx.connection.configPath}`) };
  },
};

export const whoami: Command = {
  name: 'whoami',
  summary: 'Show the host, where the settings come from, and who the API key belongs to',
  args: { max: 0 },
  async run(ctx) {
    const { connection, client } = ctx;
    const health = await client.get<Record<string, unknown>>('/api/health');
    const identity = await identify(client);
    const data = {
      url: connection.url,
      urlSource: connection.urlSource,
      apiKey: maskKey(connection.apiKey),
      keySource: connection.keySource,
      user: identity.user,
      via: identity.via,
      scopes: identity.scopes,
      host: { status: String(health.status ?? 'unknown'), workflows: Number(health.workflows ?? 0), nodeTypes: Number(health.nodeTypes ?? 0), plugins: Number(health.plugins ?? 0) },
    };
    return {
      data,
      human: () =>
        fields([
          ['URL', `${connection.url} (${connection.urlSource})`],
          ['API key', data.apiKey ? `${data.apiKey} (${connection.keySource})` : 'none'],
          ['User', describeUser(identity)],
          ['Scopes', identity.scopes?.join(', ') ?? null],
          ['Host', `${data.host.status}, ${data.host.workflows} workflows, ${data.host.nodeTypes} node types`],
        ]),
    };
  },
};

export const authCommands = [login, logout, whoami];
