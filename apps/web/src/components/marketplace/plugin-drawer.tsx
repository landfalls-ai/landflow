'use client';
/**
 * A plugin's detail drawer: what it contains (agents, skills, a node plugin, flows, what doesn't run in
 * Landflow yet), its README, and Install / Uninstall. A node plugin runs code on this machine, so
 * installing one first shows what will run and from where.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowUpRight, Bot, Check, ExternalLink, Eye, Package, Sparkles, TriangleAlert, Workflow, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import type { InstallConfirmation, InstalledPlugin, InstallResult, PluginDetail } from '@/lib/shared/marketplace';
import { Badge, Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { SectionLabel } from '../ui/inputs';
import { UNSUPPORTED_LABEL } from './use-marketplace';

const MODEL_LABEL: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', inherit: 'Sonnet (inherit)' };

export function ContentsBadges({ detail }: { detail: Pick<PluginDetail, 'agents' | 'skills' | 'nodePlugin' | 'unsupported'> & { flows?: PluginDetail['flows'] } }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {detail.agents.length > 0 && <Badge tone="accent">Agents {detail.agents.length}</Badge>}
      {detail.skills.length > 0 && <Badge tone="success">Skills {detail.skills.length}</Badge>}
      {detail.nodePlugin && <Badge tone="warning">Node plugin</Badge>}
      {(detail.flows?.length ?? 0) > 0 && <Badge tone="accent">Flows {detail.flows!.length}</Badge>}
      {detail.unsupported.length > 0 && (
        <Badge tone="muted" title="These parts of the plugin don't run in Landflow yet">
          Unsupported: {detail.unsupported.map((u) => UNSUPPORTED_LABEL[u.kind] ?? u.kind).join(', ')}
        </Badge>
      )}
    </div>
  );
}

export function PluginDrawer({ marketplaceId, name, onClose, onChanged }: { marketplaceId: string; name: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<PluginDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<InstallConfirmation>();
  const [result, setResult] = useState<InstallResult>();
  const [readme, setReadme] = useState(false);

  const load = async () => {
    setError(undefined);
    try {
      const { plugin } = await api<{ plugin: PluginDetail }>(`/api/marketplaces/${marketplaceId}/plugins/${encodeURIComponent(name)}`);
      setDetail(plugin);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplaceId, name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const install = async (confirmed = false) => {
    setBusy(true);
    try {
      const done = await api<InstallResult>(`/api/marketplaces/${marketplaceId}/plugins/${encodeURIComponent(name)}/install`, { method: 'POST', json: { confirm: confirmed } });
      setResult(done);
      setConfirm(undefined);
      toast.success(`Installed ${done.installed.id}`);
      onChanged();
      await load();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as InstallConfirmation | undefined) : undefined;
      if (body?.needsConfirmation) setConfirm(body);
      else toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const { installed } = await api<{ installed: InstalledPlugin[] }>('/api/marketplaces/installed');
      const match = installed.find((p) => p.plugin === detail.plugin.name && p.marketplaceId === marketplaceId)?.id;
      if (!match) throw new Error('This plugin is no longer installed');
      const { removed } = await api<{ removed: { agents: number; skills: number; nodePlugin: boolean; flows?: number } }>(`/api/marketplaces/installed/${encodeURIComponent(match)}`, { method: 'DELETE' });
      toast.success(`Uninstalled: removed ${removed.agents} agent(s), ${removed.skills} skill(s)${removed.flows ? `, ${removed.flows} flow template(s)` : ''}${removed.nodePlugin ? ' and the node plugin' : ''}`);
      setResult(undefined);
      onChanged();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const plugin = detail?.plugin;
  const runnable = detail && (detail.agents.length > 0 || detail.skills.length > 0 || detail.nodePlugin || detail.flows.length > 0);

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-overlay animate-in" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Plugin ${name}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full w-[560px] max-w-full flex-col border-l border-hair bg-sf shadow-pop animate-slide-left"
      >
        <header className="flex items-start gap-3 border-b border-hair px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-[28%] border border-hair bg-acdim text-ac">
            <Package className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-t1">{plugin?.displayName ?? name}</h2>
            <p className="truncate text-[12px] text-t3">
              {[plugin?.author, plugin?.version && `v${plugin.version}`, plugin?.category].filter(Boolean).join(' · ') || 'Plugin'}
            </p>
          </div>
          {plugin?.homepage && (
            <a href={plugin.homepage} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 text-[12px] text-t2 hover:text-ac">
              <ExternalLink className="size-3.5" /> Homepage
            </a>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
          {!detail && !error && (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse-soft rounded-xl bg-wl" />
              ))}
              <p className="text-center text-[12px] text-t3">Reading the plugin’s files…</p>
            </div>
          )}
          {detail && plugin && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2.5">
                <p className="text-[13px] leading-relaxed text-t2">{plugin.description}</p>
                <ContentsBadges detail={detail} />
                <p className="font-mono text-[11px] text-t3" title="Where the files come from">
                  {plugin.sourceLabel}
                </p>
              </div>

              {result && <InstallSummary result={result} />}
              {confirm && (
                <div className="rounded-xl border border-warnbd bg-warndim px-4 py-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-warn">
                    <TriangleAlert className="size-4" /> This runs code on this machine
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-t1">{confirm.warning}</p>
                  <dl className="mt-2.5 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-[12px]">
                    <dt className="text-t3">Repository</dt>
                    <dd className="break-all font-mono text-[11px] text-t1">{confirm.repository}</dd>
                    {confirm.install && (
                      <>
                        <dt className="text-t3">Install</dt>
                        <dd className="break-all font-mono text-[11px] text-t1">{confirm.install}</dd>
                      </>
                    )}
                    <dt className="text-t3">Runs</dt>
                    <dd className="break-all font-mono text-[11px] text-t1">{confirm.command}</dd>
                  </dl>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirm(undefined)}>
                      Cancel
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void install(true)} loading={busy}>
                      I trust it — install and run
                    </Button>
                  </div>
                </div>
              )}

              {detail.agents.length > 0 && (
                <section>
                  <SectionLabel className="mb-2">Agents → Landflow agents</SectionLabel>
                  <div className="flex flex-col divide-y divide-hair overflow-hidden rounded-xl border border-hair">
                    {detail.agents.map((agent) => (
                      <div key={agent.path} className="flex gap-3 px-3.5 py-2.5">
                        <Bot className="mt-0.5 size-4 shrink-0 text-ac" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-semibold text-t1">{agent.name}</span>
                            {agent.model && <Chip mono>{MODEL_LABEL[agent.model] ?? agent.model}</Chip>}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-t2">{agent.description}</p>
                          {agent.tools.length > 0 && <p className="mt-1 truncate text-[11px] text-t3" title={agent.tools.join(', ')}>Claude Code tools (not mapped): {agent.tools.join(', ')}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {detail.skills.length > 0 && (
                <section>
                  <SectionLabel className="mb-2">Skills → skill library{detail.agents.length ? ' and each agent' : ''}</SectionLabel>
                  <div className="flex flex-col divide-y divide-hair overflow-hidden rounded-xl border border-hair">
                    {detail.skills.map((skill) => (
                      <div key={skill.dir || skill.name} className="flex gap-3 px-3.5 py-2.5">
                        <Sparkles className="mt-0.5 size-4 shrink-0 text-gn" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-semibold text-t1">{skill.name}</span>
                            {skill.references.length > 0 && <Chip>{skill.references.length} reference{skill.references.length === 1 ? '' : 's'}</Chip>}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-t2">{skill.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {detail.nodePlugin && (
                <section>
                  <SectionLabel className="mb-2">Node plugin</SectionLabel>
                  <div className="rounded-xl border border-hair px-3.5 py-2.5 text-[12px] text-t2">
                    Adds nodes from <span className="font-mono text-t1">{detail.nodePlugin.id}</span> ({detail.nodePlugin.runtime}). The host downloads it, installs its dependencies and runs{' '}
                    <code className="rounded border border-hair bg-wl px-1 font-mono text-[11px] text-t1">{detail.nodePlugin.start.join(' ')}</code>; it then announces itself like any plugin.
                  </div>
                </section>
              )}

              {detail.flows.length > 0 && (
                <section>
                  <SectionLabel className="mb-2">Flows → Templates</SectionLabel>
                  <div className="flex flex-col divide-y divide-hair overflow-hidden rounded-xl border border-hair">
                    {detail.flows.map((flow) => (
                      <div key={flow.path} className="flex gap-3 px-3.5 py-2.5">
                        <Workflow className="mt-0.5 size-4 shrink-0 text-ac" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-semibold text-t1">{flow.name}</span>
                            <Chip>
                              {flow.nodeCount} node{flow.nodeCount === 1 ? '' : 's'}
                            </Chip>
                            {flow.link && (
                              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                                <Link href={flow.link} onClick={onClose} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] text-t2 hover:bg-acdim hover:text-ac">
                                  <Eye className="size-3.5" /> View
                                </Link>
                                <CopyButton text={`${window.location.origin}${flow.link}`} label="Copy share link" />
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-t2">{flow.description}</p>
                          {flow.credentials.length > 0 && <p className="mt-1 truncate text-[11px] text-t3">Asks for: {flow.credentials.join(', ')}</p>}
                          {flow.needs.length > 0 && (
                            <p className="mt-1 text-[11px] text-warn" title={flow.needs.join(', ')}>
                              Needs nodes from: {[...new Set(flow.needs.map((type) => type.split('.')[0]))].join(', ')}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-t3">Installing adds them to Templates for the whole instance; uninstalling removes them. Workflows made from them stay. View opens a read-only page you can share.</p>
                </section>
              )}

              {detail.unsupported.length > 0 && (
                <section>
                  <SectionLabel className="mb-2">Not supported in Landflow yet</SectionLabel>
                  <div className="flex flex-col gap-1.5 rounded-xl border border-hair px-3.5 py-2.5">
                    {detail.unsupported.map((u) => (
                      <div key={u.kind} className="flex gap-2 text-[12px]">
                        <span className="w-[120px] shrink-0 text-t2">{UNSUPPORTED_LABEL[u.kind] ?? u.kind}</span>
                        <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-t3">{u.items.join(', ')}</span>
                      </div>
                    ))}
                    <p className="mt-1 text-[11px] text-t3">These come with the plugin but aren’t installed.</p>
                  </div>
                </section>
              )}

              {detail.warnings.length > 0 && (
                <section>
                  <SectionLabel className="mb-2">Notes</SectionLabel>
                  <ul className="list-disc pl-5 text-[12px] leading-relaxed text-t3">
                    {detail.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </section>
              )}

              {detail.readme && (
                <section>
                  <button onClick={() => setReadme((r) => !r)} className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 hover:text-ac">
                    README {readme ? '▾' : '▸'}
                  </button>
                  {readme && <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border border-hair bg-wl px-3.5 py-3 font-mono text-[11px] leading-relaxed text-t2">{detail.readme}</pre>}
                </section>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-hair px-5 py-3">
          {plugin?.installed ? (
            <>
              <Badge tone="success">
                <Check className="size-3" /> Installed
              </Badge>
              <Button variant="danger" className="ml-auto" onClick={() => void uninstall()} loading={busy}>
                Uninstall
              </Button>
            </>
          ) : (
            <>
              {detail && !runnable && <span className="text-[12px] text-t3">Nothing in this plugin runs in Landflow yet.</span>}
              <Button variant="primary" className="ml-auto" onClick={() => void install(false)} loading={busy && !confirm} disabled={!runnable || Boolean(confirm)}>
                Install
              </Button>
            </>
          )}
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

function InstallSummary({ result }: { result: InstallResult }) {
  const { installed } = result;
  return (
    <div className={cn('rounded-xl border border-gnbd bg-gndim px-4 py-3')}>
      <div className="flex items-center gap-2 text-[13px] font-semibold text-gn">
        <Check className="size-4" /> Installed {installed.id}
      </div>
      {installed.agents.length > 0 && (
        <div className="mt-2 text-[12px] text-t1">
          Created agents:{' '}
          {installed.agents.map((agent, i) => (
            <span key={agent.id}>
              {i > 0 && ', '}
              <Link href={`/agents/${agent.id}`} className="font-semibold text-ac hover:underline">
                {agent.name}
              </Link>
            </span>
          ))}{' '}
          <Link href="/agents" className="inline-flex items-center gap-0.5 text-t2 hover:text-ac">
            open in Agents <ArrowUpRight className="size-3" />
          </Link>
        </div>
      )}
      {installed.skills.length > 0 && <div className="mt-1 text-[12px] text-t1">Added to the skill library: {installed.skills.map((s) => s.name).join(', ')}</div>}
      {(installed.templates?.length ?? 0) > 0 && (
        <div className="mt-1 text-[12px] text-t1">
          Added to{' '}
          <Link href="/templates" className="text-ac hover:underline">
            Templates
          </Link>
          : {installed.templates!.map((t) => t.name).join(', ')}
        </div>
      )}
      {installed.nodePlugin && (
        <div className="mt-1 text-[12px] text-t1">
          Node plugin <span className="font-mono">{installed.nodePlugin.pluginId}</span> {installed.nodePlugin.status?.state ?? 'starting'} on port {installed.nodePlugin.port} — watch it come online in{' '}
          <Link href={`/plugins?plugin=${encodeURIComponent(installed.nodePlugin.pluginId)}`} className="text-ac hover:underline">
            Plugins
          </Link>
          .
        </div>
      )}
      {result.notSupported.length > 0 && <div className="mt-1 text-[12px] text-t3">Not installed (unsupported): {result.notSupported.map((u) => `${UNSUPPORTED_LABEL[u.kind] ?? u.kind} (${u.items.length})`).join(', ')}</div>}
    </div>
  );
}
