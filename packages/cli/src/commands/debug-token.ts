/**
 * `debug-token`: a short-lived, read-only token for ONE execution (docs/specs/19-debug-token.md), to hand to a coding agent
 * (a local Claude Code) so it can explain a failed remote run without your API key. It opens three tools of the host's
 * `/api/mcp` (explain_failure, get_run_trace, get_execution) for that execution, redacted of credentials and `$vars`, and
 * is audited per call. `--list` shows an execution's tokens, `--revoke <id>` closes one.
 */
import { seg } from '../client';
import { flag, type Command } from '../command';
import { CliError, usage } from '../errors';
import { fields, table, time } from '../output';

interface TokenRecord {
  id: string;
  hint: string;
  label: string;
  executionId: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  uses: number;
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600 };
const MIN_SECONDS = 60;
const MAX_SECONDS = 86_400;

/** `90s`, `30m`, `1h`, `2h30m`; a bare number is seconds. At least a minute, at most 24 hours (the host checks too). */
export function parseTtl(text: string): number {
  const trimmed = text.trim().toLowerCase();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
  else if (/^(\d+[hms])+$/.test(trimmed)) seconds = [...trimmed.matchAll(/(\d+)([hms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * UNITS[unit], 0);
  else throw usage(`--ttl “${text}”: write a lifetime like 30m, 1h or 2h30m`);
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) throw usage('--ttl must be between 1 minute and 24 hours');
  return seconds;
}

const state = (t: TokenRecord, now = Date.now()) => (t.revokedAt ? 'revoked' : Date.parse(t.expiresAt) <= now ? 'expired' : 'live');

export const debugToken: Command = {
  name: 'debug-token',
  summary: 'Mint a short-lived read-only token for one execution, for an agent that explains a failed run',
  usage: '--execution <id> [--ttl 1h] [--scopes executions:read,trace:read] [--label text] | --execution <id> --list | --revoke <token id> --execution <id>',
  details:
    'The token (lf_dbg_…) is shown once. It is bound to the one execution: with it an agent can call explain_failure, get_run_trace and\n' +
    'get_execution at the host’s /api/mcp (the host’s MCP server must be on) and nothing else: every other tool and every REST route refuses it.\n' +
    'Everything it returns is redacted of credential values, $vars and secret-named keys; every call is in the audit log. It expires (default 1 h,\n' +
    'at most 24 h) and stops at once when revoked, or when you lose access to the workflow. Scopes: executions:read (get_execution, explain_failure),\n' +
    'trace:read (get_run_trace); both by default.\n' +
    'Give it to the agent as the bearer token of the MCP server:  claude mcp add --transport http landflow <url>/api/mcp --header "Authorization: Bearer <token>"',
  flags: {
    execution: flag.string('The execution the token is for', 'id', 'e'),
    ttl: flag.string('Lifetime: 90s, 30m, 1h, 2h30m (default 1h, at most 24h)', 'duration'),
    scopes: flag.string('Comma-separated: executions:read, trace:read (default both)', 'list'),
    label: flag.string('A name to tell tokens apart in the list and the audit log', 'text'),
    list: flag.boolean('List the execution’s debug tokens instead of minting one'),
    revoke: flag.string('Revoke this token (its id from --list)', 'token id'),
  },
  args: { max: 0 },
  async run(ctx) {
    const execution = ctx.flags.execution === undefined ? undefined : String(ctx.flags.execution);
    if (!execution) throw usage('Name the execution: --execution <id>');
    const base = `/api/executions/${seg(execution)}/debug-tokens`;

    if (ctx.flags.revoke !== undefined) {
      const id = String(ctx.flags.revoke);
      const done = await ctx.client.delete<{ revoked: boolean; record?: TokenRecord }>(`${base}/${seg(id)}`);
      return { data: { revoked: done.revoked, record: done.record }, human: () => (done.revoked ? `Revoked ${id}. It stops working on its next call.` : `${id} was already revoked.`) };
    }

    if (ctx.flags.list) {
      const { tokens } = await ctx.client.get<{ tokens: TokenRecord[] }>(base);
      return {
        data: { executionId: execution, tokens },
        human: () =>
          table(
            tokens,
            [
              { label: 'id', value: (t) => t.id },
              { label: 'label', value: (t) => t.label, max: 30 },
              { label: 'state', value: (t) => state(t) },
              { label: 'scopes', value: (t) => t.scopes.join(',') },
              { label: 'expires', value: (t) => time(t.expiresAt) },
              { label: 'uses', value: (t) => t.uses, align: 'right' },
              { label: 'last used', value: (t) => time(t.lastUsedAt) },
            ],
            'No debug tokens for this execution.',
          ),
      };
    }

    const ttlSeconds = ctx.flags.ttl === undefined ? undefined : parseTtl(String(ctx.flags.ttl));
    const scopes = ctx.flags.scopes === undefined ? undefined : String(ctx.flags.scopes).split(',').map((s) => s.trim()).filter(Boolean);
    const minted = await ctx.client.post<{ token: string; record: TokenRecord; mcp?: { enabled: boolean; path: string } }>(base, {
      ...(ttlSeconds !== undefined && { ttlSeconds }),
      ...(scopes && { scopes }),
      ...(ctx.flags.label !== undefined && { label: String(ctx.flags.label) }),
    });
    if (!minted.token) throw new CliError('server_error', 'The host answered without a token');
    const mcpOff = minted.mcp?.enabled === false;
    if (mcpOff) ctx.note('The host’s MCP server is off: turn it on in Settings → MCP, or the token has nowhere to work.');
    const endpoint = `${ctx.connection.url.replace(/\/+$/, '')}${minted.mcp?.path ?? '/api/mcp'}`;
    return {
      data: { token: minted.token, record: minted.record, mcpUrl: endpoint, mcpEnabled: minted.mcp?.enabled },
      human: () =>
        [
          fields([
            ['token', minted.token],
            ['id', minted.record.id],
            ['execution', minted.record.executionId],
            ['scopes', minted.record.scopes.join(', ')],
            ['expires', time(minted.record.expiresAt)],
            ['mcp', endpoint],
          ]),
          '',
          'Shown once. It reads this execution only, redacted, and every call is audited. Revoke it with:',
          `  landflow debug-token --execution ${minted.record.executionId} --revoke ${minted.record.id}`,
        ].join('\n'),
    };
  },
};

export const debugTokenCommands = [debugToken];
