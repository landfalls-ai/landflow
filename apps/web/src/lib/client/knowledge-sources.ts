/** C22: the calls the knowledge base dialog makes for sources. Each throws an Error carrying the server's sentence. */
import type { SourceInput, SourcePatch, SourceView, SyncRunView } from '@/lib/shared/knowledge-sources';

const base = (agentId: string, toolId: string) => `/api/agents/${encodeURIComponent(agentId)}/knowledge/${encodeURIComponent(toolId)}/sources`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const listSources = (agentId: string, toolId: string) => call<{ sources: SourceView[] }>(base(agentId, toolId)).then((r) => r.sources);
export const addSource = (agentId: string, toolId: string, input: SourceInput) => call<SourceView>(base(agentId, toolId), json('POST', input));
export const patchSource = (agentId: string, toolId: string, id: string, patch: SourcePatch) => call<SourceView>(`${base(agentId, toolId)}/${id}`, json('PATCH', patch));
export const removeSource = (agentId: string, toolId: string, id: string, deleteChunks: boolean) => call<{ removedChunks: number }>(`${base(agentId, toolId)}/${id}${deleteChunks ? '?deleteChunks=1' : ''}`, { method: 'DELETE' });
export const syncSourceNow = (agentId: string, toolId: string, id: string) => call<{ runId: string }>(`${base(agentId, toolId)}/${id}/sync`, { method: 'POST' });
export const sourceRuns = (agentId: string, toolId: string, id: string, cursor?: string) =>
  call<{ runs: SyncRunView[]; next?: string }>(`${base(agentId, toolId)}/${id}/runs?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
