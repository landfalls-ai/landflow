'use client';
/**
 * Settings → AI → LLM gateway: which LiteLLM gateway the instance uses (a credential whose Gateway is LiteLLM, or the
 * server's LANDFLOW_LLM_GATEWAY_* variables), the cluster and UI addresses, the switches and the headroom of the
 * backstop budgets, and "Sync now" with the last report (docs/llm-gateway.md, "Budgets in LiteLLM"). A key is never
 * shown and never stored here: the master key comes only from the server's environment.
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Route, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import type { LlmGatewaySettings, LlmGatewaySettingsView, SyncCounts, SyncReport } from '@/lib/shared/llm-gateway';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, SectionLabel, Select, Switch } from '@/components/ui/inputs';

const ENV = '';

interface Draft {
  credentialId: string;
  clusterUrl: string;
  uiUrl: string;
  portalHeaders: boolean;
  ingest: boolean;
  sync: boolean;
  headroomPercent: string;
}

const toDraft = (settings: LlmGatewaySettings): Draft => ({
  credentialId: settings.credentialId ?? ENV,
  clusterUrl: settings.clusterUrl ?? '',
  uiUrl: settings.uiUrl ?? '',
  portalHeaders: settings.portalHeaders,
  ingest: settings.ingest,
  sync: settings.sync,
  headroomPercent: String(settings.headroomPercent),
});

const SWITCHES: ReadonlyArray<{ key: 'ingest' | 'sync' | 'portalHeaders'; label: string; hint: string }> = [
  { key: 'ingest', label: 'Import spend of agents outside Landflow', hint: 'Agents on kagent and other clients of the gateway are counted from its spend log.' },
  { key: 'sync', label: 'Keep LiteLLM budgets in step with caps', hint: 'Projects become teams, people customers, dollar caps budgets a little above the Landflow cap. Nothing in LiteLLM is ever deleted.' },
  { key: 'portalHeaders', label: 'Send Customer Portal headers (not in a LiteLLM release yet)', hint: 'Off unless your LiteLLM build has the Customer Portal.' },
];

const COUNT_LABELS: ReadonlyArray<[string, keyof SyncReport & ('teams' | 'customers' | 'keys')]> = [
  ['Teams', 'teams'],
  ['Customers', 'customers'],
  ['Keys', 'keys'],
];

const countText = (counts: SyncCounts) =>
  [counts.created && `${counts.created} created`, counts.updated && `${counts.updated} updated`, `${counts.unchanged} unchanged`, counts.failed && `${counts.failed} failed`].filter(Boolean).join(' · ');

export function LlmGatewayCard() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const [view, setView] = useState<LlmGatewaySettingsView>();
  const [draft, setDraft] = useState<Draft>();
  const [report, setReport] = useState<SyncReport>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const apply = (next: LlmGatewaySettingsView) => {
    setView(next);
    setDraft(toDraft(next.settings));
  };
  const loadReport = useCallback(() => {
    if (!admin) return;
    api<{ report?: SyncReport }>('/api/llm-gateway/sync')
      .then((result) => setReport(result.report))
      .catch(() => undefined);
  }, [admin]);

  useEffect(() => {
    api<LlmGatewaySettingsView>('/api/settings/llm-gateway')
      .then(apply)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(loadReport, [loadReport]);

  if (!view || !draft) {
    return error ? <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div> : <div className="h-32 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  }

  const headroom = Number(draft.headroomPercent);
  const headroomOk = draft.headroomPercent.trim() !== '' && Number.isFinite(headroom) && headroom >= 0 && headroom <= 100;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(view.settings));
  const env = view.environment;
  const uiUrl = draft.uiUrl || view.settings.uiUrl || env.uiUrl || (draft.credentialId ? undefined : env.url ? `${env.url}/ui` : undefined);
  const configured = Boolean(draft.credentialId || env.url);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      // An empty string clears a field (lib/server/llm-gateway/settings.ts saveGatewaySettings).
      apply(await api<LlmGatewaySettingsView>('/api/settings/llm-gateway', { method: 'PUT', json: { credentialId: draft.credentialId, clusterUrl: draft.clusterUrl, uiUrl: draft.uiUrl, portalHeaders: draft.portalHeaders, ingest: draft.ingest, sync: draft.sync, headroomPercent: headroom } }));
      toast.success('LLM gateway settings saved');
      // Turning the sync on starts one in the background.
      setTimeout(loadReport, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(undefined);
    try {
      const result = await api<{ report: SyncReport }>('/api/llm-gateway/sync', { method: 'POST', json: {} });
      setReport(result.report);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card className="px-5 py-4 max-md:px-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Route className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>LLM gateway</SectionLabel>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-t3">
        Every model call can go through one LiteLLM proxy. Landflow’s caps decide; LiteLLM’s budgets are the backstop for whatever slips past them, such as an agent running on kagent.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <FieldLabel>Gateway</FieldLabel>
          <Select value={draft.credentialId} onChange={(e) => set({ credentialId: e.target.value })} disabled={!admin} aria-label="Gateway credential" className="max-md:h-11">
            <option value={ENV}>Use the environment</option>
            {view.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-[11px] leading-relaxed text-t3">
            {draft.credentialId ? 'A saved Anthropic API or OpenAI API credential whose Gateway is LiteLLM.' : env.url ? <>The server’s <span className="font-mono">LANDFLOW_LLM_GATEWAY_URL</span> is <span className="break-all font-mono">{env.url}</span>.</> : <>No gateway: the server sets no <span className="font-mono">LANDFLOW_LLM_GATEWAY_URL</span> and no credential is picked.</>}
          </p>
        </div>
        <div>
          <FieldLabel>Admin access</FieldLabel>
          <div className="flex min-h-9 items-center text-[13px] text-t1 max-md:min-h-11">{env.hasAdminKey ? 'The server has the admin key.' : 'The server has no admin key.'}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-t3">
            {env.hasAdminKey ? 'The spend import and the budgets sync use it.' : <>The spend import and the budgets sync need <span className="font-mono">LANDFLOW_LLM_GATEWAY_URL</span> and <span className="font-mono">LANDFLOW_LLM_GATEWAY_ADMIN_KEY</span> on the server.</>} It is never stored or shown here.
          </p>
        </div>
        <div>
          <FieldLabel>Cluster URL</FieldLabel>
          <Input value={draft.clusterUrl} onChange={(e) => set({ clusterUrl: e.target.value })} disabled={!admin} placeholder={env.clusterUrl ?? 'http://host.docker.internal:54100'} aria-label="Cluster URL" className="font-mono text-[12px] max-md:h-11" />
          <p className="mt-1 text-[11px] text-t3">How agents on kagent reach the gateway. Empty: they call their model directly.</p>
        </div>
        <div>
          <FieldLabel>LiteLLM UI</FieldLabel>
          <Input value={draft.uiUrl} onChange={(e) => set({ uiUrl: e.target.value })} disabled={!admin} placeholder={env.uiUrl ?? '<gateway>/ui'} aria-label="LiteLLM UI URL" className="font-mono text-[12px] max-md:h-11" />
          <p className="mt-1 text-[11px] text-t3">Linked for admins below.</p>
        </div>
      </div>

      <div className="mt-3 divide-y divide-hair rounded-[10px] border border-hair">
        {SWITCHES.map(({ key, label, hint }) => (
          <div key={key} className="flex items-start justify-between gap-3 px-3 py-2.5 max-md:min-h-11">
            <div className={`min-w-0 ${admin ? 'cursor-pointer' : ''} max-md:flex-1 max-md:py-1`} onClick={() => admin && set({ [key]: !draft[key] })}>
              <div className="text-[13px] text-t1">{label}</div>
              <div className="text-[11px] leading-relaxed text-t3">{hint}</div>
            </div>
            <div className="flex min-h-9 shrink-0 items-center max-md:min-h-11">
              <Switch checked={draft[key]} onChange={(value) => set({ [key]: value })} disabled={!admin} label={label} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 max-w-xs">
        <FieldLabel>Headroom, in percent</FieldLabel>
        <Input value={draft.headroomPercent} onChange={(e) => set({ headroomPercent: e.target.value })} disabled={!admin} inputMode="decimal" aria-label="Headroom in percent" className="w-28 text-right font-mono text-[12px] max-md:h-11" />
        <p className="mt-1 text-[11px] leading-relaxed text-t3">How far above a Landflow dollar cap the LiteLLM budget sits for people, so Landflow’s own, clearer stop comes first. Agents on kagent get none.</p>
        {!headroomOk && <p className="mt-1 text-[12px] text-warn">Enter a number from 0 to 100.</p>}
      </div>

      {error && <div className="mt-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error}</div>}

      {admin ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-hair pt-3.5 max-md:[&>*]:min-h-11">
          {uiUrl && (
            <a href={uiUrl} target="_blank" rel="noreferrer noopener" className="mr-auto inline-flex items-center gap-1.5 text-[13px] text-ac hover:underline max-md:min-h-11">
              <ExternalLink className="size-3.5" /> Open LiteLLM
            </a>
          )}
          {dirty && (
            <Button variant="ghost" onClick={() => apply(view)}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty || !headroomOk}>
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-t3">Only owners and admins can change the gateway.</p>
      )}

      {admin && (
        <div className="mt-3 border-t border-hair pt-3.5" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[13px] font-semibold text-t1">Budgets in LiteLLM</div>
              <div className="text-[11px] text-t3">{report ? `Last sync ${new Date(report.at).toLocaleString()} (${report.trigger})` : 'Not synced yet.'}</div>
            </div>
            <Button onClick={syncNow} loading={syncing} disabled={!configured || !env.hasAdminKey || dirty} title={!env.hasAdminKey ? 'Needs LANDFLOW_LLM_GATEWAY_URL and LANDFLOW_LLM_GATEWAY_ADMIN_KEY on the server' : dirty ? 'Save the settings first' : undefined} className="max-md:min-h-11 max-md:w-full">
              <RefreshCw className="size-3.5" /> Sync now
            </Button>
          </div>
          {report && (
            <>
              <div className="mt-2.5 grid gap-2 md:grid-cols-3">
                {COUNT_LABELS.map(([label, key]) => (
                  <div key={key} className="rounded-[10px] border border-hair bg-sf px-3 py-2">
                    <div className="text-[12px] font-semibold text-t2">{label}</div>
                    <div className="text-[12px] text-t1">{countText(report[key])}</div>
                  </div>
                ))}
              </div>
              {report.errors.length > 0 && (
                <ul className="mt-2.5 space-y-1 rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
                  {report.errors.map((message, index) => (
                    <li key={index} className="break-words">
                      {message}
                    </li>
                  ))}
                </ul>
              )}
              {report.orphans.length > 0 && (
                <div className="mt-2.5">
                  <div className="text-[12px] font-semibold text-t2">In LiteLLM, not in Landflow</div>
                  <ul className="mt-1 space-y-1">
                    {report.orphans.map((orphan) => (
                      <li key={`${orphan.kind}:${orphan.litellmId}`} className="rounded-[10px] border border-hair bg-sf px-3 py-2 text-[12px] text-t2">
                        <span className="font-semibold text-t1">{orphan.kind}</span> <span className="break-all font-mono">{orphan.litellmId}</span>
                        <div className="text-t3">
                          {orphan.note}
                          {uiUrl && (
                            <>
                              {' '}
                              <a href={uiUrl} target="_blank" rel="noreferrer noopener" className="text-ac hover:underline">
                                Open LiteLLM
                              </a>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
