'use client';
/**
 * Data for the templates pages: the library (searched on the server, so remote templates are searched too, 30 at a
 * time with "Load more"; `projectId`: that project's saved templates and the instance-wide ones), one template, node
 * types.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { TemplateDetail, TemplateSource, TemplateSummary } from '@/lib/shared/templates';
import type { NodeTypeInfo } from '@/lib/shared/types';

export interface TemplateListing {
  templates: TemplateSummary[];
  remote: { enabled: boolean; label?: string; error?: string; page?: number; total?: number; hasMore?: boolean };
}

/** The library for a search, category, source and project; the search waits for typing to pause. */
export function useTemplateList(search: string, category?: string, source?: TemplateSource, projectId?: string) {
  const [listing, setListing] = useState<TemplateListing>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [version, setVersion] = useState(0);
  const params = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({ ...(search.trim() && { search: search.trim() }), ...(category && { category }), ...(source && { source }), ...(projectId && { projectId }), ...extra }),
    [search, category, source, projectId],
  );

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const query = params();
    const timer = setTimeout(
      () =>
        api<TemplateListing>(`/api/templates${query.size ? `?${query}` : ''}`)
          .then((r) => !stale && (setListing(r), setError(undefined)))
          .catch((e: Error) => !stale && setError(e.message))
          .finally(() => !stale && setLoading(false)),
      search.trim() ? 250 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [params, version]);

  /** The next 30 remote results, after the ones shown. */
  const loadMore = useCallback(async () => {
    const page = (listing?.remote.page ?? 1) + 1;
    setLoadingMore(true);
    try {
      const next = await api<TemplateListing>(`/api/templates?${params({ source: 'remote', page: String(page) })}`);
      setListing((current) => {
        if (!current) return next;
        const seen = new Set(current.templates.map((t) => t.id));
        return { templates: [...current.templates, ...next.templates.filter((t) => !seen.has(t.id))], remote: { ...current.remote, ...next.remote } };
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [listing?.remote.page, params]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { listing, error, loading, reload, loadMore, loadingMore };
}

/** One template (`projectId`: count that project's allowed nodes); `reload()` after editing it. */
export function useTemplateDetail(id: string, projectId?: string) {
  const [template, setTemplate] = useState<TemplateDetail>();
  const [error, setError] = useState<{ message: string; status?: number }>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stale = false;
    api<{ template: TemplateDetail }>(`/api/templates/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
      .then((r) => !stale && setTemplate(r.template))
      .catch((e: Error & { status?: number }) => !stale && setError({ message: e.message, status: e.status }));
    return () => {
      stale = true;
    };
  }, [id, projectId, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { template, error, reload, setTemplate };
}

/** Node types by type, for icons and the read-only canvas (blocked ones included, with the reason). */
export function useNodeTypeMap() {
  const [types, setTypes] = useState<Record<string, NodeTypeInfo>>({});
  useEffect(() => {
    api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types')
      .then((r) => setTypes(Object.fromEntries(r.nodeTypes.map((t) => [t.type, t]))))
      .catch(() => {});
  }, []);
  return types;
}

/** Download a template as a file to import on another instance. */
export async function downloadTemplate(template: Pick<TemplateSummary, 'id' | 'name'>) {
  const response = await fetch(`/api/templates/${encodeURIComponent(template.id)}?format=file`, { cache: 'no-store' });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'template.template.json';
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** A Markdown description as one line of plain text (cards). */
export function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
