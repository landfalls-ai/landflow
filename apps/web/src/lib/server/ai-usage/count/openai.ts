/**
 * OpenAI's own encodings, run offline (`gpt-tokenizer`: the BPE ranks ship in the package, nothing is fetched).
 * `o200k_base` is the encoding of the GPT-4o, GPT-4.1, GPT-5 and o-series families; `cl100k_base` of GPT-4 and GPT-3.5.
 * A model name that is not OpenAI's (an OpenAI-compatible server running someone else's model) has no known encoding,
 * so it is not counted. The per-message chat framing is the provider's own and lands in `formatting`.
 *
 * The library keeps a process-wide merge cache keyed by the pre-token strings of every text it counts (up to 100,000
 * words, identifiers, secrets). Prompts must not outlive the call, so the cache is switched off (`setMergeCacheSize(0)`)
 * when an encoding is first loaded; counting stays fast without it (1 MB of prose in about 10 ms).
 */
import type { Counter } from './index';

type Encoding = {
  countTokens: (text: string, options?: { disallowedSpecial?: Set<string> }) => number;
  setMergeCacheSize: (size: number) => void;
};

/** A prompt may contain the text of a special token (a file about tokenizers): count it as plain text, never throw. */
const PLAIN = { disallowedSpecial: new Set<string>() };

const O200K = /^(?:chatgpt-4o|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|gpt-oss|o\d)/i;
const CL100K = /^(?:gpt-4|gpt-3\.5|text-embedding-3|text-embedding-ada)/i;

/** The encoding name of an OpenAI model, or undefined when it is not one of OpenAI's. */
export function openAiEncoding(model: string): 'o200k_base' | 'cl100k_base' | undefined {
  const name = model.replace(/^openai\//, '');
  if (O200K.test(name)) return 'o200k_base';
  if (CL100K.test(name)) return 'cl100k_base';
  return undefined;
}

const loaded = new Map<string, Promise<Encoding>>();

function encoding(name: 'o200k_base' | 'cl100k_base'): Promise<Encoding> {
  let p = loaded.get(name);
  if (!p) {
    p = (name === 'o200k_base' ? import('gpt-tokenizer/encoding/o200k_base') : import('gpt-tokenizer/encoding/cl100k_base')).then((m) => {
      m.setMergeCacheSize(0);
      return m as Encoding;
    });
    loaded.set(name, p);
  }
  return p;
}

/** The loaded encoding modules, for the test that no prompt text stays reachable. */
export const loadedEncodings = (): Promise<Encoding[]> => Promise.all([...loaded.values()]);

export const openAiCounter: Counter = {
  method: 'tokenizer',
  async count(call, draft) {
    const name = openAiEncoding(call.model);
    if (!name) return undefined;
    const { countTokens } = await encoding(name);
    return draft.segments.map((s) => (s.text ? countTokens(s.text, PLAIN) : 0));
  },
};
