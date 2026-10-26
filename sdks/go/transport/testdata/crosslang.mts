/**
 * Cross-language helper for sdks/go/transport/crosslang_test.go (run as crosslang.mts so tsx treats it as ESM): seals events with the TypeScript core so Go can open
 * them, and opens events Go sealed. Run with `packages/transports/node_modules/.bin/tsx crosslang.mts`; JSON in on stdin,
 * JSON out on stdout.
 *
 * Input: { secret, pluginId, seal: [{ attributes, data, encrypt, mode }], open: [{ headers, bodyBase64, mode? }], manifest? }
 * Output: { sealed: [{ headers, bodyBase64, attributes }], opened: [{ attributes, data } | { error }], manifestHash? }
 */
import { createHash } from 'node:crypto';
import { Codec, Keyring, MemoryClaimStore, type Attributes } from '../../../../packages/transports/src/index.ts';
import { MEMORY_CAPABILITIES } from '../../../../packages/transports/src/memory/index.ts';

/** `claim: true` seals with a 4 KiB broker limit and a claim store, so a big body goes by reference; the stored objects come back in `claims`. */
interface SealCase { attributes: Attributes; data: unknown; encrypt: boolean; mode: 'binary' | 'structured'; claim?: boolean }
interface OpenCase { headers: Record<string, string>; bodyBase64: string; mode: 'binary' | 'structured' }
interface Input { secret: string; pluginId: string; seal?: SealCase[]; open?: OpenCase[]; manifest?: unknown; claims?: Record<string, string> }

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Input;
const keyring = new Keyring(input.secret);
const codecFor = (mode: 'binary' | 'structured') => new Codec(keyring, { ...MEMORY_CAPABILITIES, headers: mode === 'binary' });

const sealStore = new MemoryClaimStore();
const sealed: unknown[] = [];
for (const c of input.seal ?? []) {
  const codec = c.claim ? new Codec(keyring, { ...MEMORY_CAPABILITIES, headers: c.mode === 'binary', maxMessageBytes: 4096 }, { claims: sealStore }) : codecFor(c.mode);
  const packed = await codec.packClaimed(input.pluginId, c.attributes, c.data as never, c.encrypt);
  sealed.push({ headers: packed.wire.headers, bodyBase64: Buffer.from(packed.wire.body).toString('base64'), attributes: packed.attributes });
}

const openStore = new MemoryClaimStore();
for (const [key, value] of Object.entries(input.claims ?? {})) await openStore.put(key, new Uint8Array(Buffer.from(value, 'base64')));
const opened: unknown[] = [];
for (const c of input.open ?? []) {
  try {
    const codec = new Codec(keyring, { ...MEMORY_CAPABILITIES, headers: c.mode === 'binary' }, { claims: openStore });
    const peeked = codec.peek({ headers: c.headers, body: new Uint8Array(Buffer.from(c.bodyBase64, 'base64')) });
    const { raw } = await codec.resolveClaim(peeked, input.pluginId);
    const { attributes, data } = codec.unpack(raw, input.pluginId);
    opened.push({ attributes, data });
  } catch (error) {
    opened.push({ error: (error as Error).message });
  }
}

const claims = Object.fromEntries([...sealStore.objects].map(([key, value]) => [key, Buffer.from(value).toString('base64')]));
const out: Record<string, unknown> = { sealed, opened, claims };
// The host's manifestHash(): sha256(JSON.stringify(manifest)) over the parsed manifest, first 16 hex chars.
if (input.manifest !== undefined) out.manifestHash = createHash('sha256').update(JSON.stringify(input.manifest)).digest('hex').slice(0, 16);
process.stdout.write(JSON.stringify(out));
