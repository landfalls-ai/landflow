'use client';
/**
 * /marketplace/flows/<marketplace>/<plugin>/<path> — a marketplace flow's share page: a read-only canvas (click a
 * node for its notes and parameters), the description, setup steps, credentials and data tables, what else it needs,
 * and the plugin's other flows. Nothing here runs or tests the flow: "Install plugin" opens the plugin's drawer, and
 * once installed "Open template" goes to the template the flow became, where "Use template" is. A link to a
 * marketplace this instance hasn't added offers to add it (`?source=`, owners and admins).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Ban, ChevronLeft, Eye, LayoutTemplate, Package, PackageX, Plus, Store, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import type { MarketplaceFlowView } from '@/lib/shared/marketplace';
import { useViewer } from '@/components/auth/viewer';
import { Markdown } from '@/components/canvas/markdown';
import { ExecutionCanvas } from '@/components/executions/execution-canvas';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { categoryName, TemplateNodeIcons } from '@/components/templates/template-card';
import { TemplateSetupCards } from '@/components/templates/template-view';
import { useNodeTypeMap } from '@/components/templates/use-templates';
import { Badge, Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { EmptyState } from '../ui/empty-state';
import { SectionLabel } from '../ui/inputs';
import { PluginDrawer } from './plugin-drawer';

const NO_RUN_DATA = {};

const back = (
  <Link href="/marketplace" className="inline-flex items-center gap-1 text-t3 hover:text-t1">
    <ChevronLeft className="size-4" /> Marketplace
  </Link>
);

/** The marketplace isn't added here: say which, and let owners and admins add it from the link's `source`. */
function NotAdded({ marketplace, source, onAdded }: { marketplace: string; source?: string; onAdded: () => void }) {
  const viewer = useViewer();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const { marketplace: added } = await api<{ marketplace: { name: string; plugins: number } }>('/api/marketplaces', { method: 'POST', json: { input: source } });
      toast.success(`Added ${added.name}: ${added.plugins} plugins`);
      onAdded();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card className="py-6">
      <EmptyState
        compact
        title={`“${marketplace}” isn’t added here`}
        hint={
          source
            ? can(viewer, 'plugins:manage')
              ? `This flow is in a marketplace this instance hasn’t added. Adding it reads ${source}; nothing is installed until you choose.`
              : `This flow is in a marketplace this instance hasn’t added. Ask an owner or admin to add ${source} in Marketplace.`
            : 'This flow is in a marketplace this instance hasn’t added, and the link doesn’t say where it comes from.'
        }
        action={
          source && can(viewer, 'plugins:manage') ? (
            <Button size="sm" variant="primary" onClick={() => void add()} loading={busy}>
              <Plus className="size-3.5" /> Add {source}
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}

export function FlowView({ marketplace, plugin, path }: { marketplace: string; plugin: string; path: string }) {
  const params = useSearchParams();
  const source = params.get('source') ?? undefined;
  const types = useNodeTypeMap();
  const [view, setView] = useState<MarketplaceFlowView>();
  const [error, setError] = useState<{ message: string; status?: number; missing?: string }>();
  const [version, setVersion] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    let stale = false;
    setError(undefined);
    api<{ flow: MarketplaceFlowView }>(`/api/marketplaces/${encodeURIComponent(marketplace)}/plugins/${encodeURIComponent(plugin)}/flow?path=${encodeURIComponent(path)}`)
      .then((r) => !stale && setView(r.flow))
      .catch((e: Error) => {
        if (stale) return;
        const body = e instanceof ApiError ? (e.body as { missing?: string } | undefined) : undefined;
        setError({ message: e.message, status: e instanceof ApiError ? e.status : undefined, missing: body?.missing });
      });
    return () => {
      stale = true;
    };
  }, [marketplace, plugin, path, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  if (error)
    return (
      <>
        <PageHeader title={back} />
        <PageBody>
          {error.missing === 'marketplace' ? (
            <NotAdded marketplace={marketplace} source={source} onAdded={reload} />
          ) : (
            <Card className="py-6">
              <EmptyState compact title={error.status === 404 ? 'Flow not found' : 'Couldn’t load this flow'} hint={error.status === 404 ? `${error.message}. The plugin may have moved or renamed it.` : error.message} />
            </Card>
          )}
        </PageBody>
      </>
    );

  if (!view)
    return (
      <>
        <PageHeader title={back} />
        <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="h-[480px] animate-pulse-soft rounded-2xl bg-wl" />
          <div className="h-[480px] animate-pulse-soft rounded-2xl bg-wl" />
        </PageBody>
      </>
    );

  const { template, flow } = view;
  const node = template.workflow.nodes.find((n) => n.id === selected);
  const blocked = template.problems.filter((p) => p.kind === 'blocked');
  const needs = [...new Set(flow.needs.map((type) => type.split('.')[0]))];
  const absolute = typeof window === 'undefined' ? view.link : `${window.location.origin}${view.link}`;

  return (
    <>
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            {back}
            <span className="text-t3">/</span>
            <button onClick={() => setDrawer(true)} className="truncate text-t3 hover:text-t1">
              {view.plugin.displayName ?? view.plugin.name}
            </button>
            <span className="text-t3">/</span>
            <span className="truncate">{template.name}</span>
          </span>
        }
        actions={
          <>
            <span className="inline-flex items-center gap-1 text-[12px] text-t3">
              Share link <CopyButton text={absolute} label="Copy share link" />
            </span>
            {view.templateId ? (
              <Link href={`/templates/${encodeURIComponent(view.templateId)}`}>
                <Button variant="primary" size="sm">
                  <LayoutTemplate className="size-3.5" /> Open template
                </Button>
              </Link>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setDrawer(true)}>
                <Package className="size-3.5" /> Install plugin
              </Button>
            )}
          </>
        }
      />
      <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-2 rounded-[10px] border border-hair bg-wl px-3 py-2 text-[12px] text-t2">
            <Eye className="size-3.5 shrink-0 text-t3" />
            <span>
              Read-only preview: nothing here runs.{' '}
              {view.templateId ? 'The plugin is installed, so this flow is in Templates: open it to use it.' : 'Installing the plugin adds this flow to Templates, where you set it up and use it.'}
            </span>
          </div>
          <Card className="h-[480px] overflow-hidden p-0">
            <ExecutionCanvas workflow={template.workflow} nodeTypes={types} runData={NO_RUN_DATA} selectedNodeId={selected} onNodeClick={(id) => setSelected((s) => (s === id ? undefined : id))} />
          </Card>
          {node && (
            <Card className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-t1">{node.name}</span>
                <Chip mono>{types[node.type]?.descriptor.displayName ?? node.type}</Chip>
                {!types[node.type] && <Badge tone="warning">Not on this instance</Badge>}
              </div>
              {node.notes && <Markdown text={node.notes} className="text-[12px] leading-relaxed text-t2" />}
              {Object.keys(node.parameters).length > 0 ? (
                <pre className="max-h-[260px] overflow-auto rounded-xl border border-hair bg-wl px-3 py-2 font-mono text-[11px] leading-relaxed text-t2">{JSON.stringify(node.parameters, null, 2)}</pre>
              ) : (
                <p className="text-[12px] text-t3">Default settings.</p>
              )}
            </Card>
          )}
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <TemplateNodeIcons nodeTypes={template.nodeTypes} types={types} size="md" />
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <Badge tone="accent">
                  <Store className="size-3" /> {view.plugin.name}
                </Badge>
                {template.categories.map((c) => (
                  <Chip key={c}>{categoryName(c)}</Chip>
                ))}
              </span>
            </div>
            {template.description ? <Markdown text={template.description} className="text-[13px] leading-relaxed text-t1" /> : <p className="text-[13px] text-t3">No description.</p>}
            <div className="text-[12px] text-t3">
              {[view.plugin.author && `By ${view.plugin.author}`, `${template.nodeCount} node${template.nodeCount === 1 ? '' : 's'}`, `from ${view.marketplace.name}`, flow.path].filter(Boolean).join(' · ')}
            </div>
          </Card>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          {(needs.length > 0 || blocked.length > 0) && (
            <div role="alert" className="flex flex-col gap-1.5 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
              {needs.length > 0 && (
                <div className="flex items-start gap-1.5" title={flow.needs.join(', ')}>
                  <PackageX className="mt-0.5 size-3 shrink-0" />
                  <span>Also needs nodes from {needs.join(', ')}: install those plugins too.</span>
                </div>
              )}
              {blocked.map((p) => (
                <div key={p.nodeType} className="flex items-start gap-1.5">
                  <Ban className="mt-0.5 size-3 shrink-0" />
                  <span>{p.message}</span>
                </div>
              ))}
            </div>
          )}
          <TemplateSetupCards template={template} />
          {view.flows.length > 1 && (
            <Card className="flex flex-col gap-2">
              <SectionLabel>In this plugin</SectionLabel>
              <ul className="flex flex-col gap-0.5">
                {view.flows.map((f) => (
                  <li key={f.path}>
                    <Link
                      href={`/marketplace/flows/${[marketplace, plugin, ...f.path.split('/')].map(encodeURIComponent).join('/')}${source ? `?source=${encodeURIComponent(source)}` : ''}`}
                      className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-t2 hover:bg-wl hover:text-t1', f.path === flow.path && 'bg-acdim font-semibold text-ac')}
                    >
                      <Workflow className="size-3.5 shrink-0" />
                      <span className="truncate">{f.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </PageBody>
      {drawer && <PluginDrawer marketplaceId={view.marketplace.id} name={view.plugin.name} onClose={() => setDrawer(false)} onChanged={reload} />}
    </>
  );
}
