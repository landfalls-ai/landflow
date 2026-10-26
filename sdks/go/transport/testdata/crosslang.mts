/**
 * Cross-language helper for sdks/go/transport/crosslang_test.go (run as crosslang.mts so tsx treats it as ESM): seals events with the TypeScript core so Go can open
 * them, and opens events Go sealed. Run with `packages/transports/node_modules/.bin/tsx crosslang.mts`; JSON in on stdin,
 * JSON out on stdout.
 *
 * Input: { secret, pluginId, seal: [{ attributes, data, encrypt, mode }], open: [{ headers, bodyBase64, mode? }], manifest? }
 * Output: { sealed: [{ headers, bodyBase64, attributes }], opened: [{ attributes, data } | { error }], manifestHash? }
 */
import { createHash } from 'node:crypto';
import { Codec, Keyring, type Attributes } from '../../../../packages/transports/src/index.ts';
import { MEMORY_CAPABILITIES } from '../../../../packages/transports/src/memory/index.ts';

interface SealCase { attributes: Attributes; data: unknown; encrypt: boolean; mode: 'binary' | 'structured' }
interface OpenCase { headers: Record<string, string>; bodyBase64: string; mode: 'binary' | 'structured' }
interface Input { secret: string; pluginId: string; seal?: SealCase[]; open?: OpenCase[]; manifest?: unknown }

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Input;
const keyring = new Keyring(input.secret);
const codecFor = (mode: 'binary' | 'structured') => new Codec(keyring, { ...MEMORY_CAPABILITIES, headers: mode === 'binary' });

const sealed = (input.seal ?? []).map((c) => {
  const packed = codecFor(c.mode).pack(input.pluginId, c.attributes, c.data as never, c.encrypt);
  return { headers: packed.wire.headers, bodyBase64: Buffer.from(packed.wire.body).toString('base64'), attributes: packed.attributes };
});

const opened = (input.open ?? []).map((c) => {
  try {
    const codec = codecFor(c.mode);
    const raw = codec.peek({ headers: c.headers, body: new Uint8Array(Buffer.from(c.bodyBase64, 'base64')) });
    const { attributes, data } = codec.unpack(raw, input.pluginId);
    return { attributes, data };
  } catch (error) {
    return { error: (error as Error).message };
  }
});

const out: Record<string, unknown> = { sealed, opened };
// The host's manifestHash(): sha256(JSON.stringify(manifest)) over the parsed manifest, first 16 hex chars.
if (input.manifest !== undefined) out.manifestHash = createHash('sha256').update(JSON.stringify(input.manifest)).digest('hex').slice(0, 16);
process.stdout.write(JSON.stringify(out));
