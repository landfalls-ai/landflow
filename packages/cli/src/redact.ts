/**
 * Redaction for debug bundles. The host already redacts what its MCP tools return; this is the second pass over
 * everything that goes into a bundle, including what the CLI read through the REST API: credentials (references keep
 * a name and type only), `$vars` values (found by name on the host and removed wherever they appear), keys named like
 * a secret, bearer tokens and API keys.
 */
export const REDACTED = '[redacted]';

const SECRET_KEY = /(secret|password|passwd|api[-_]?key|authorization|private[-_]?key|cookie|session[-_]?id|(^|[a-z_-])tokens?$)/i;
const INLINE: Array<[RegExp, string]> = [
  // JSON text inside a string (a Set node's `json`, a request body): "apiKey": "value"
  [/("[^"\\]*(?:secret|password|passwd|api[-_]?key|authorization|private[-_]?key|cookie|token)[^"\\]*"\s*:\s*")(?:[^"\\]|\\.)+(")/gi, `$1${'[redacted]'}$2`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`],
  [/\blf_[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
];

export interface RedactStats {
  keys: number;
  values: number;
}

export function makeRedactor(secrets: string[] = []) {
  const stats: RedactStats = { keys: 0, values: 0 };
  // Longest first, so a value that contains another is replaced whole. Very short values would shred ordinary text.
  const values = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  const text = (input: string): string => {
    let out = input;
    for (const value of values) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(REDACTED);
      stats.values++;
    }
    for (const [pattern, replacement] of INLINE) {
      out = out.replace(pattern, (...m: string[]) => {
        stats.values++;
        return replacement.replace(/\$(\d)/g, (_, n: string) => (typeof m[Number(n)] === 'string' ? m[Number(n)] : ''));
      });
    }
    return out;
  };
  const walk = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (!value || typeof value !== 'object') return value;
    if (key === 'credentials') {
      // A node's credential references: the name and type say which one; ids and anything else stay out.
      stats.keys++;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([slot, ref]) => {
          const r = (ref && typeof ref === 'object' ? ref : {}) as Record<string, unknown>;
          return [slot, { ...(typeof r.name === 'string' && { name: text(r.name) }), ...(typeof r.type === 'string' && { type: r.type }) }];
        }),
      );
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        if (SECRET_KEY.test(k) && typeof v !== 'number' && typeof v !== 'boolean' && v !== null && v !== '') {
          stats.keys++;
          return [k, REDACTED];
        }
        return [k, walk(v, k)];
      }),
    );
  };
  return { redact: <T>(value: T): T => walk(value) as T, stats };
}
