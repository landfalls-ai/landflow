/**
 * What a tool call reached, and what a knowledge search found (wave ag3, docs/run-trace.md "What a tool call reached"):
 * the proof the person asked for, that an agent's tools are connected to something real. A call row in the editor's
 * chat, a span in the Run Trace and a row of the agent page's timeline all read it the same way.
 *
 * Contract file: backbone/contracts/ag3/tool-target.ts (wave ag3, owner AG14), copied byte for byte to
 * apps/web/src/lib/shared/tool-target.ts by AG14 and by AG12 (the canvas names a tool's credential with `targetLine`; the
 * two copies are identical, so the merge adds the file once). Change it here first (the owner only), then copy. Types and
 * pure helpers only: no import, no zod (the browser loads it), no I/O.
 *
 * The rule that makes it safe (AG14 builds it on the server, from the tool's config and its credential): a target is made
 * only from **non-secret** facts: the credential's id, name and type's display name, and of its fields only those that
 * are not secret (`secretFieldsOf(type)` excludes them) and are named `host`, `port`, `url`, `baseUrl`, `endpoint`,
 * `server`, `database` or `path`; a URL is cut to `host:port` (`safeEndpoint`), a file path to its last part. A token, a
 * password, a key, a URL's user, password, path, query or fragment never reach it.
 */

/** What one tool call reached. Every field is optional but `name`. */
export interface ToolTarget {
  /** In words: the credential's name ("Mailpit SMTP", "Sales DB", "Local Grafana (editor)"), else the system ("Go Crypto plugin", "Knowledge base"). */
  name: string;
  /** The kind of system: the credential type's display name or the node's app ("SMTP", "SQLite", "Grafana", "HTTP"). */
  system?: string;
  /** Where, without secrets: `127.0.0.1:51181`, `sales.db`, `127.0.0.1:53181` (`safeEndpoint`). */
  endpoint?: string;
  /** The credential the call used (its id, for a link to the Credentials page; never its data). */
  credentialId?: string;
  /** The plugin that ran the node (its id, `messaging`), and where it answered (`127.0.0.1:7281`), when a plugin did. */
  plugin?: { id: string; endpoint?: string };
  /** A knowledge search: the collection, the store, how it searched (the embeddings model, or `keyword search (BM25, built in)`) and how many documents it holds. */
  knowledge?: { collection: string; store: string; embeddings: string; documents?: number };
}

/** "Mailpit SMTP · SMTP 127.0.0.1:51181", "Sales DB · SQLite sales.db", "runbooks · SQLite store · keyword search (BM25, built in) · 4 documents". */
export function targetLine(target: ToolTarget | undefined): string {
  if (!target) return '';
  if (target.knowledge) {
    const k = target.knowledge;
    const docs = k.documents !== undefined ? ` · ${k.documents} document${k.documents === 1 ? '' : 's'}` : '';
    return `${k.collection} · ${k.store} store · ${k.embeddings}${docs}`;
  }
  const where = [target.system, target.endpoint].filter(Boolean).join(' ');
  const plugin = !target.credentialId && target.plugin ? `${target.plugin.id} plugin${target.plugin.endpoint ? ` at ${target.plugin.endpoint}` : ''}` : '';
  return [target.name, where || plugin].filter(Boolean).join(' · ');
}

/**
 * A place without its secrets: a URL → `host:port` (or `host`), never its user, password, path, query or fragment; a file
 * path → its last part (`/x/y/sales.db` → `sales.db`); `host` and `port` given apart → `host:port`. Empty, templated
 * (`{{ … }}`) or unreadable → undefined.
 */
export function safeEndpoint(value: unknown, port?: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.includes('{{')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      return new URL(text).host || undefined;
    } catch {
      return undefined;
    }
  }
  if (text.includes('/') || text.includes('\\')) return text.split(/[\\/]/).filter(Boolean).pop();
  if (/[@?#\s]/.test(text)) return undefined;
  const p = typeof port === 'number' || (typeof port === 'string' && /^\d+$/.test(port)) ? String(port) : '';
  return p && !text.includes(':') ? `${text}:${p}` : text;
}

/** One passage a knowledge search returned, as the person reads it. */
export interface Passage {
  text: string;
  /** Where it came from: the document's `source` (`runbooks/disk-full.md`), else its `fileName`. */
  source?: string;
  page?: number;
  score?: number;
}

/**
 * The passages of a knowledge tool's output (`{ results: [{ pageContent, metadata, score }] }`, lib/server/agents/knowledge.ts),
 * in order; anything else → []. `metadata.source` (AG13's folder indexing) wins over `metadata.fileName` (an upload).
 */
export function passagesOf(output: unknown): Passage[] {
  const results = (output as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const out: Passage[] = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const { pageContent, metadata, score } = r as { pageContent?: unknown; metadata?: Record<string, unknown>; score?: unknown };
    if (typeof pageContent !== 'string') continue;
    const source = typeof metadata?.source === 'string' && metadata.source ? metadata.source : typeof metadata?.fileName === 'string' && metadata.fileName ? metadata.fileName : undefined;
    const page = typeof metadata?.page === 'number' ? metadata.page : undefined;
    out.push({ text: pageContent, ...(source && { source }), ...(page !== undefined && { page }), ...(typeof score === 'number' && { score }) });
  }
  return out;
}
