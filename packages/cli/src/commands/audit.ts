/**
 * `audit verify/head/key` — the audit log's integrity. `verify` asks the host to check the whole hash chain (exit 9,
 * `integrity_failed`, with the report in `error.details`, when it is broken); with `--head <file>` it instead checks a
 * signed head offline, without the host: the Ed25519 signature over the exact payload text, against the public key you
 * pinned (`--public-key <pem file>`; without one the check only proves the envelope is consistent). `head` fetches the
 * newest signed head (to keep, or to feed `verify --head`), `key` the public keys that signed.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flag, type Command } from '../command';
import { CliError, usage } from '../errors';
import { fields, plural, table } from '../output';

interface ChainReport {
  ok: boolean;
  checked: number;
  firstSeq?: number;
  lastSeq?: number;
  head?: { seq: number; hash: string };
  pending: number;
  legacy: number;
  brokenAt?: { seq: number; reason: string; eventId?: string };
  problems: Array<{ seq: number; reason: string }>;
  verifiedAt: string;
}

interface SignedHead {
  format: string;
  payload: string;
  algorithm: string;
  keyId: string;
  signature: string;
  publicKey: string;
}

interface HeadView {
  head: SignedHead | null;
  signedAt?: string;
  anchoredAt?: string;
  keys: Array<{ keyId: string; publicKey: string; createdAt: string }>;
}

const HEAD_FORMAT = 'landflow.audit.head/1';

const keyIdOf = (pem: string) => createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

/** The same check the host does (lib/server/audit/signing.ts), so a head can be verified with nothing but this CLI. */
export function verifyHead(envelope: SignedHead, trustedPem?: string): { ok: true; payload: { seq: number; hash: string; signedAt: string; keyId: string }; pinned: boolean } | { ok: false; reason: string } {
  if (envelope?.format !== HEAD_FORMAT || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, reason: 'Not a Landflow signed audit head' };
  let payload: { format?: string; seq: number; hash: string; signedAt: string; keyId: string };
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    return { ok: false, reason: 'The signed payload is not JSON' };
  }
  try {
    if (trustedPem && keyIdOf(trustedPem) !== envelope.keyId) return { ok: false, reason: `Signed by key ${envelope.keyId}, not the key you trust (${keyIdOf(trustedPem)})` };
    if (!verify(null, Buffer.from(envelope.payload), createPublicKey(trustedPem ?? envelope.publicKey), Buffer.from(envelope.signature, 'base64'))) return { ok: false, reason: 'The signature does not match the payload' };
  } catch (error) {
    return { ok: false, reason: `The signature could not be checked: ${(error as Error).message}` };
  }
  if (payload.format !== HEAD_FORMAT || !Number.isInteger(payload.seq) || typeof payload.hash !== 'string') return { ok: false, reason: 'The payload is not an audit head' };
  return { ok: true, payload, pinned: Boolean(trustedPem) };
}

async function readText(ctx: { io: { cwd: string } }, file: string, what: string): Promise<string> {
  try {
    return await readFile(resolve(ctx.io.cwd, file), 'utf8');
  } catch (error) {
    throw new CliError('io', `Can't read ${what} ${file}: ${(error as Error).message}`);
  }
}

export const auditVerify: Command = {
  name: 'audit verify',
  summary: 'Check the audit log’s hash chain on the host, or a signed head offline (--head)',
  usage: '[--head <file> [--public-key <pem file>]]',
  details:
    'Without flags the host checks every event’s hash and link and the newest event against its head record; a broken chain exits 9 (`integrity_failed`) with the report in `error.details`. ' +
    'With --head the signed head in <file> (from `audit head --out`, or a copy anchored in S3 or at a webhook) is checked here, without the host: its Ed25519 signature over the payload text, ' +
    'against the key in --public-key (a PEM file you pinned; without it the check proves only that the head is consistent, not who signed it).',
  flags: {
    head: flag.string('A signed head file to check offline', 'file'),
    'public-key': flag.string('The public key (PEM file) you trust; with --head', 'file'),
  },
  args: { max: 0 },
  async run(ctx) {
    if (ctx.flags['public-key'] && !ctx.flags.head) throw usage('--public-key goes with --head');
    if (ctx.flags.head) {
      const file = String(ctx.flags.head);
      let envelope: SignedHead;
      try {
        envelope = JSON.parse(await readText(ctx, file, 'the head file'));
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError('io', `${file} is not JSON`);
      }
      // `audit head --json` output is accepted as it is.
      const signed = ((envelope as unknown as { head?: SignedHead }).head ?? envelope) as SignedHead;
      const pem = ctx.flags['public-key'] ? await readText(ctx, String(ctx.flags['public-key']), 'the public key') : undefined;
      const verdict = verifyHead(signed, pem);
      if (!verdict.ok) throw new CliError('integrity_failed', verdict.reason, { details: { verified: false, reason: verdict.reason, keyId: signed?.keyId } });
      const { payload } = verdict;
      return {
        data: { verified: true, pinned: verdict.pinned, seq: payload.seq, hash: payload.hash, signedAt: payload.signedAt, keyId: payload.keyId },
        human: () =>
          `Signature valid: chain head #${payload.seq} (${payload.hash.slice(0, 16)}…) signed ${payload.signedAt} by key ${payload.keyId}` +
          (verdict.pinned ? '' : '\nnote: no --public-key given, so this does not show who signed it'),
      };
    }
    const report = await ctx.client.get<ChainReport>('/api/audit/verify');
    if (!report.ok) {
      throw new CliError('integrity_failed', `The audit log's hash chain is broken at #${report.brokenAt?.seq ?? '?'}: ${report.brokenAt?.reason ?? 'see the report'}`, { details: report });
    }
    return {
      data: { ...report },
      human: () =>
        [
          `The hash chain is intact: ${plural(report.checked, 'event')} checked${report.firstSeq !== undefined ? ` (#${report.firstSeq} to #${report.lastSeq})` : ''}`,
          report.pending ? `${plural(report.pending, 'event')} not chained yet (sealed within seconds)` : '',
          report.legacy ? `${plural(report.legacy, 'event')} from before the chain began` : '',
        ]
          .filter(Boolean)
          .join('\n'),
    };
  },
};

export const auditHead: Command = {
  name: 'audit head',
  summary: 'The newest signed chain head (--out saves it for `audit verify --head`)',
  usage: '[--out <file>]',
  flags: { out: flag.string('Write the signed head (JSON) to this file', 'file') },
  args: { max: 0 },
  async run(ctx) {
    const view = await ctx.client.get<HeadView>('/api/audit/head');
    if (!view.head) throw new CliError('not_found', 'No head has been signed yet (the leader signs on a schedule; Settings → Audit log → Integrity → Sign and anchor now)');
    if (ctx.flags.out) await writeFile(resolve(ctx.io.cwd, String(ctx.flags.out)), `${JSON.stringify(view.head, null, 2)}\n`);
    const payload = JSON.parse(view.head.payload) as { seq: number; hash: string; signedAt: string };
    return {
      data: { head: view.head, signedAt: view.signedAt, anchoredAt: view.anchoredAt, keys: view.keys },
      human: () =>
        fields([
          ['Head', `#${payload.seq} ${payload.hash}`],
          ['Signed', `${payload.signedAt} by key ${view.head!.keyId}`],
          ['Anchored', view.anchoredAt ?? 'not yet'],
          ['Saved to', ctx.flags.out ? String(ctx.flags.out) : ''],
        ]),
    };
  },
};

export const auditKey: Command = {
  name: 'audit key',
  summary: 'The public keys that signed audit heads (--out saves the current one as PEM)',
  usage: '[--out <file>]',
  flags: { out: flag.string('Write the current public key (PEM) to this file, to pin it for `audit verify --public-key`', 'file') },
  args: { max: 0 },
  async run(ctx) {
    const { keys } = await ctx.client.get<HeadView>('/api/audit/head');
    const current = keys.at(-1);
    if (!current) throw new CliError('not_found', 'No signing key yet: one is created at the first signature');
    if (ctx.flags.out) await writeFile(resolve(ctx.io.cwd, String(ctx.flags.out)), current.publicKey);
    return {
      data: { keys, current },
      human: () => (ctx.flags.out ? `Saved key ${current.keyId} to ${String(ctx.flags.out)}\n\n` : '') + table(keys, [{ label: 'key', value: (k) => `${k.keyId}${k === current ? ' (current)' : ''}` }, { label: 'created', value: (k) => k.createdAt }]),
    };
  },
};

export const auditCommands: Command[] = [auditVerify, auditHead, auditKey];
