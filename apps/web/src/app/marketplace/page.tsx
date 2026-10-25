'use client';
import { useEffect, useMemo, useState } from 'react';
import { Check, Package, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { CatalogPlugin, MarketplaceSummary } from '@/lib/shared/marketplace';
import { AddMarketplaceDialog } from '@/components/marketplace/add-marketplace-dialog';
import { InstalledList } from '@/components/marketplace/installed-list';
import { PluginDrawer } from '@/components/marketplace/plugin-drawer';
import { SkillLibrary } from '@/components/marketplace/skill-library';
import { useCatalog, useMarketplaces, useSkillLibrary } from '@/components/marketplace/use-marketplace';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/inputs';

type Tab = 'browse' | 'installed' | 'skills';

function locationText(m: MarketplaceSummary) {
  const l = m.location;
  return l.kind === 'github' ? `github.com/${l.owner}/${l.repo}${l.ref ? ` @ ${l.ref}` : ''}` : l.kind === 'url' ? l.url : l.path;
}

function PluginTile({ plugin, index, onOpen }: { plugin: CatalogPlugin; index: number; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      style={{ animationDelay: `${Math.min(index, 18) * 15}ms` }}
      className="flex min-h-[132px] flex-col gap-2 rounded-2xl border border-hair bg-sf px-4 py-3.5 text-left transition-colors animate-fade-up hover:border-ac"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[28%] border border-hair bg-wl text-t2">
          <Package className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-t1">{plugin.displayName ?? plugin.name}</span>
          <span className="block truncate text-[11px] text-t3">{[plugin.author, plugin.version && `v${plugin.version}`].filter(Boolean).join(' · ') || plugin.sourceLabel}</span>
        </span>
        {plugin.installed && (
          <Badge tone="success">
            <Check className="size-3" /> Installed
          </Badge>
        )}
      </div>
      <p className="line-clamp-3 text-[12px] leading-snug text-t2">{plugin.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap gap-1.5">
        {plugin.category && <Chip>{plugin.category}</Chip>}
        {plugin.landflow && <Badge tone="warning">Node plugin</Badge>}
        {!plugin.supported && (
          <Badge tone="muted" title={plugin.unsupportedReason}>
            Unsupported source
          </Badge>
        )}
      </div>
    </button>
  );
}

export default function MarketplacePage() {
  const { marketplaces, presets, installed, error, reload } = useMarketplaces();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<Tab>('browse');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [libraryVersion, setLibraryVersion] = useState(0);
  const skills = useSkillLibrary(libraryVersion);

  useEffect(() => {
    if (!selected && marketplaces?.length) setSelected(marketplaces[0].id);
    if (selected && marketplaces && !marketplaces.some((m) => m.id === selected)) setSelected(marketplaces[0]?.id);
  }, [marketplaces, selected]);

  const { catalog, loading, error: catalogError, load } = useCatalog(tab === 'browse' ? selected : undefined);
  const current = marketplaces?.find((m) => m.id === selected);

  useEffect(() => {
    setCategory(undefined);
    setQuery('');
  }, [selected]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.plugins ?? []).filter(
      (p) => (!category || p.category === category) && (!q || `${p.name} ${p.displayName ?? ''} ${p.description} ${p.author ?? ''} ${p.keywords.join(' ')}`.toLowerCase().includes(q)),
    );
  }, [catalog, query, category]);

  const changed = () => {
    void reload();
    void load();
    setLibraryVersion((v) => v + 1);
  };

  const remove = async () => {
    if (!current) return;
    try {
      await api(`/api/marketplaces/${current.id}`, { method: 'DELETE' });
      toast.success(`Removed ${current.name}`);
      setSelected(undefined);
      void reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'browse', label: 'Browse' },
    { id: 'installed', label: 'Installed', count: installed?.length },
    { id: 'skills', label: 'Skill library', count: skills?.length },
  ];

  return (
    <>
      <PageHeader
        title="Marketplace"
        meta={
          marketplaces && (
            <span>
              {marketplaces.length} marketplace{marketplaces.length === 1 ? '' : 's'} · {installed?.length ?? 0} installed
            </span>
          )
        }
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add marketplace
          </Button>
        }
      />
      <PageBody className="flex flex-col gap-4">
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}

        <div role="tablist" className="flex w-fit items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn('h-7 rounded-full px-3.5 text-[13px] text-t2 transition-all duration-200 hover:text-t1', tab === t.id && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]')}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && <span className="ml-1.5 font-mono text-[11px] font-normal text-t3">{t.count}</span>}
            </button>
          ))}
        </div>

        {tab === 'browse' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {marketplaces?.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelected(m.id)}
                  className={cn(
                    'inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors',
                    m.id === selected ? 'border-ac bg-acdim font-semibold text-ac' : 'border-hair bg-sf text-t1 hover:border-ac',
                  )}
                >
                  {m.name}
                  {m.plugins > 0 && <span className="font-mono text-[11px] font-normal text-t3">{m.plugins}</span>}
                </button>
              ))}
              <button onClick={() => setAdding(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-bd px-3 text-[12px] text-t2 hover:border-ac hover:text-ac">
                <Plus className="size-3.5" /> Add
              </button>
            </div>

            {current && (
              <Card className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-t1">{current.name}</span>
                    {!current.removable && <Badge tone="accent">Built in</Badge>}
                    {current.owner && <span className="text-[12px] text-t3">by {current.owner}</span>}
                  </div>
                  <p className="truncate text-[12px] text-t3">
                    {current.description ? `${current.description} · ` : ''}
                    <span className="font-mono text-[11px]">{locationText(current)}</span>
                    {current.fetchedAt && ` · fetched ${timeAgo(current.fetchedAt)}`}
                  </p>
                </div>
                <Button size="sm" onClick={() => void load(true).then(() => reload())} loading={loading}>
                  {!loading && <RefreshCw className="size-3.5" />} Refresh
                </Button>
                {current.removable && (
                  <Button variant="ghost" size="sm" onClick={() => void remove()} aria-label={`Remove ${current.name}`}>
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                )}
              </Card>
            )}

            {catalogError && (
              <Card className="py-5">
                <EmptyState
                  compact
                  title="Couldn’t load this marketplace"
                  hint={catalogError}
                  action={
                    <Button size="sm" onClick={() => void load(true)}>
                      Try again
                    </Button>
                  }
                />
              </Card>
            )}

            {catalog && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full max-w-[340px]">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-t3" />
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${catalog.plugins.length} plugins…`} className="pl-9" aria-label="Search plugins" />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[undefined, ...catalog.categories].map((c) => (
                      <button
                        key={c ?? 'all'}
                        onClick={() => setCategory(c)}
                        className={cn('rounded-full border px-2.5 py-0.5 text-[12px] capitalize transition-colors', category === c ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 hover:border-ac')}
                      >
                        {c ?? 'All'}
                      </button>
                    ))}
                  </div>
                  <span className="ml-auto text-[12px] text-t3">{shown.length} shown</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
                  {shown.map((plugin, index) => (
                    <PluginTile key={plugin.name} plugin={plugin} index={index} onOpen={() => setOpen(plugin.name)} />
                  ))}
                </div>
                {!shown.length && <p className="py-8 text-center text-[13px] text-t3">No plugin matches.</p>}
              </>
            )}
            {!catalog && !catalogError && loading && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="h-[132px] animate-pulse-soft rounded-2xl bg-wl" />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'installed' && installed && <InstalledList installed={installed} onChanged={changed} />}
        {tab === 'skills' && <SkillLibrary skills={skills} />}
      </PageBody>

      {adding && presets && (
        <AddMarketplaceDialog
          presets={presets}
          onClose={() => setAdding(false)}
          onAdded={(m) => {
            setAdding(false);
            toast.success(`Added ${m.name}: ${m.plugins} plugins`);
            setTab('browse');
            // Select it once the list has it, or the selection effect would fall back to the first one.
            void reload().then(() => setSelected(m.id));
          }}
        />
      )}
      {open && selected && <PluginDrawer marketplaceId={selected} name={open} onClose={() => setOpen(undefined)} onChanged={changed} />}
    </>
  );
}
