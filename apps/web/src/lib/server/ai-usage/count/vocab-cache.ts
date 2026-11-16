/**
 * One Ollama model's tokenizer, loaded on first need and kept in memory: the vocabulary is a few megabytes, so it is
 * read once per model digest (a re-pulled model has a new digest) and at most three are kept (least recently used out).
 * A model that cannot be counted (an unknown pre-tokenizer, not a byte-level BPE) is remembered too, so it is not
 * downloaded again for every call.
 */
import { logger } from '../../telemetry/logger';
import { singleton } from '../../singleton';
import { ByteLevelBpe, supportsPre } from './ollama-bpe';

const CAPACITY = 3;
const TIMEOUT_MS = 20_000;
/** A model's digest is asked of the server at most this often (a re-pulled model is seen within it). */
const DIGEST_TTL_MS = 30_000;

/** A tokenizer, or why there is none (a log line names the pre-tokenizer, never text). */
export type LoadedTokenizer = { bpe: ByteLevelBpe } | { reason: string };

interface State {
  entries: Map<string, LoadedTokenizer>;
  loading: Map<string, Promise<LoadedTokenizer>>;
  digests: Map<string, { digest: string | undefined; at: number }>;
}
const state = singleton('ai-count-vocab-cache', (): State => ({ entries: new Map(), loading: new Map(), digests: new Map() }));

/** Forget everything (tests). */
export function clearVocabCache(): void {
  state.entries.clear();
  state.loading.clear();
  state.digests.clear();
}

interface Tag {
  name?: string;
  model?: string;
  digest?: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}`);
  return (await response.json()) as T;
}

/** The digest of `model` on the server, or undefined when the server does not have it. */
async function digestOf(baseUrl: string, model: string): Promise<string | undefined> {
  const memo = state.digests.get(`${baseUrl}\n${model}`);
  if (memo && Date.now() - memo.at < DIGEST_TTL_MS) return memo.digest;
  const digest = await readDigest(baseUrl, model);
  state.digests.set(`${baseUrl}\n${model}`, { digest, at: Date.now() });
  if (state.digests.size > 50) state.digests.delete(state.digests.keys().next().value as string);
  return digest;
}

async function readDigest(baseUrl: string, model: string): Promise<string | undefined> {
  const { models } = await getJson<{ models?: Tag[] }>(`${baseUrl}/api/tags`);
  const want = new Set([model, model.includes(':') ? undefined : `${model}:latest`]);
  return (models ?? []).find((tag) => want.has(tag.name) || want.has(tag.model))?.digest;
}

async function load(baseUrl: string, model: string): Promise<LoadedTokenizer> {
  const shown = await getJson<{ model_info?: Record<string, unknown> }>(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, verbose: true }),
  });
  const info = shown.model_info ?? {};
  const kind = info['tokenizer.ggml.model'];
  const pre = info['tokenizer.ggml.pre'];
  if (kind !== 'gpt2' || typeof pre !== 'string' || !supportsPre(pre)) {
    logger.info('a model call stays an estimate: its tokenizer is not one the parts count knows', { tokenizer: String(kind), pre: String(pre) });
    return { reason: `tokenizer ${String(kind)}/${String(pre)}` };
  }
  const tokens = info['tokenizer.ggml.tokens'];
  const merges = info['tokenizer.ggml.merges'];
  if (!Array.isArray(tokens) || !Array.isArray(merges)) return { reason: 'no vocabulary in /api/show' };
  return { bpe: new ByteLevelBpe({ pre, tokens: tokens as string[], merges: merges as string[] }) };
}

/**
 * The tokenizer of `model` on the Ollama at `baseUrl`; `undefined` when that server does not have the model (or cannot
 * be reached). Throws never.
 */
export async function ollamaTokenizer(baseUrl: string, model: string): Promise<LoadedTokenizer | undefined> {
  try {
    const root = baseUrl.replace(/\/+$/, '');
    const digest = await digestOf(root, model);
    if (!digest) return undefined;
    const key = `${root}\n${model}\n${digest}`;
    const hit = state.entries.get(key);
    if (hit) {
      state.entries.delete(key);
      state.entries.set(key, hit); // most recently used
      return hit;
    }
    let pending = state.loading.get(key);
    if (!pending) {
      pending = load(root, model).finally(() => state.loading.delete(key));
      state.loading.set(key, pending);
    }
    const loaded = await pending;
    state.entries.set(key, loaded);
    while (state.entries.size > CAPACITY) state.entries.delete(state.entries.keys().next().value as string);
    return loaded;
  } catch (error) {
    logger.info('could not read an Ollama model\'s tokenizer', { error: (error as Error).message });
    return undefined;
  }
}
