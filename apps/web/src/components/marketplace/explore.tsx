'use client';
/**
 * The marketplace's Explore tab: every node plugin, workflow, composite type and Claude Code plugin in one place. It
 * merges GET /api/marketplaces/explore (every added marketplace, the Landflow plugins' flows), the registry's own
 * plugins (/api/plugins: those no marketplace installed show as "This instance"), the Templates library (built-in and
 * saved templates; a marketplace flow already installed is shown once, as its flow) and the composite types
 * (/api/composites: the plugins' and those saved here, docs/composites.md). One search, a kind switch, a source (all, or
 * one marketplace with its Refresh / Remove) and categories.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, Boxes, Check, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PhoneFilters } from '../ui/phone-filters';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { ExploreFlow, ExplorePlugin, MarketplaceSummary } from '@/lib/shared/marketplace';
import type { CompositeTypeInfo } from '@/lib/shared/composites';
import type { NodeTypeInfo, PluginSummary } from '@/lib/shared/types';
import { TEMPLATE_CATEGORIES, type TemplateSummary } from '@/lib/shared/templates';
import { TemplateNodeIcons } from '@/components/templates/template-card';
import { useNodeTypeMap, useTemplateList } from '@/components/templates/use-templates';
import { Card } from '@/components/shell/page-header';
import { Badge, Chip, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { AppIcon } from '@/components/ui/icon';
import { Input } from '@/components/ui/inputs';
import { useExplore } from './use-marketplace';

type Kind = 'all' | 'nodes' | 'flows' | 'composites' | 'claude';
/** A marketplace id, or this instance (registry plugins and the Templates library). */
const LOCAL = 'local';
/** How many of each kind "All" shows before "Show all". */
const SECTION = 8;

const KINDS: Array<{ id: Kind; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'nodes', label: 'Node plugins' },
  { id: 'flows', label: 'Workflows' },
  { id: 'composites', label: 'Composites' },
  { id: 'claude', label: 'Agents & skills' },
];

/** `incident-response` → "Incident response": the Templates names, else the slug made readable. */
export function categoryLabel(category: string): string {
  const known = TEMPLATE_CATEGORIES.find((c) => c.id === category.toLowerCase());
  if (known) return known.name;
  const words = category.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Item =
  | { kind: 'nodes'; key: string; source: string; categories: string[]; text: string; plugin: ExplorePlugin }
  | { kind: 'nodes'; key: string; source: typeof LOCAL; categories: string[]; text: string; local: PluginSummary }
  | { kind: 'flows'; key: string; source: string; categories: string[]; text: string; flow: ExploreFlow }
  | { kind: 'flows'; key: string; source: typeof LOCAL; categories: string[]; text: string; template: TemplateSummary }
  | { kind: 'composites'; key: string; source: typeof LOCAL; categories: string[]; text: string; composite: CompositeTypeInfo }
  | { kind: 'claude'; key: string; source: string; categories: string[]; text: string; plugin: ExplorePlugin };

const lower = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' ').toLowerCase();

const isNodePlugin = (p: ExplorePlugin) => Boolean(p.read?.nodePlugin || p.landflow);

function buildItems(plugins: ExplorePlugin[], flows: ExploreFlow[], local: PluginSummary[], templates: TemplateSummary[], composites: CompositeTypeInfo[]): Item[] {
  const linked = new Set(plugins.flatMap((p) => (p.read?.nodePlugin ? [p.read.nodePlugin.id] : [])));
  const items: Item[] = [];
  for (const plugin of plugins) {
    const base = { key: `${plugin.marketplace.id}/${plugin.name}`, source: plugin.marketplace.id, categories: plugin.category ? [plugin.category] : [], text: lower(plugin.name, plugin.displayName, plugin.description, plugin.author, plugin.keywords.join(' '), plugin.marketplace.name) };
    items.push(isNodePlugin(plugin) ? { kind: 'nodes', ...base, plugin } : { kind: 'claude', ...base, plugin });
  }
  for (const plugin of local) {
    if (linked.has(plugin.id)) continue;
    items.push({ kind: 'nodes', key: `local/${plugin.id}`, source: LOCAL, categories: [], text: lower(plugin.id, plugin.info.name, plugin.info.description, plugin.info.language, plugin.nodes.map((n) => n.displayName).join(' ')), local: plugin });
  }
  for (const flow of flows) {
    items.push({ kind: 'flows', key: `${flow.marketplace.id}/${flow.plugin}/${flow.path}`, source: flow.marketplace.id, categories: flow.categories, text: lower(flow.name, flow.description, flow.plugin, flow.pluginDisplayName, flow.nodeTypes.join(' ')), flow });
  }
  // Installed marketplace flows are templates too (with an origin): they show once, as their flow.
  for (const template of templates) {
    if (template.origin) continue;
    items.push({ kind: 'flows', key: `template/${template.id}`, source: LOCAL, categories: template.categories, text: lower(template.name, template.description, template.author, template.nodeTypes.join(' ')), template });
  }
  // Composite types this instance knows: what plugins declare (they come with the plugin) and the library saved here.
  for (const composite of composites) {
    const d = composite.descriptor;
    items.push({ kind: 'composites', key: `composite/${composite.type}`, source: LOCAL, categories: [], text: lower(d.displayName, d.description, composite.type, d.slots.map((x) => x.displayName).join(' '), composite.source.kind === 'plugin' ? composite.source.pluginName : 'saved'), composite });
  }
  return items;
}

const tileClass = 'flex min-h-[148px] min-w-0 flex-col gap-2.5 rounded-2xl border border-hair bg-sf px-4 py-3.5 text-left transition-colors duration-[120ms] hover:border-ac focus-visible:border-ac focus-visible:outline-none';

function TileHead({ icon, title, sub, badge }: { icon: ReactNode; title: string; sub?: string; badge?: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 items-start gap-2.5">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-t1">{title}</span>
        {sub && <span className="block truncate text-[11px] text-t3">{sub}</span>}
      </span>
      {badge}
    </div>
  );
}

const installedBadge = (
  <Badge tone="success">
    <Check className="size-3" /> Installed
  </Badge>
);

function NodePluginTile({ plugin, onOpen }: { plugin: ExplorePlugin; onOpen: () => void }) {
  const live = plugin.registered;
  return (
    <button onClick={onOpen} className={tileClass}>
      <TileHead
        icon={<AppIcon icon={live?.icon ?? 'blocks'} color={live?.color} size={28} />}
        title={plugin.displayName ?? plugin.name}
        sub={[plugin.marketplace.name, plugin.version && `v${plugin.version}`].filter(Boolean).join(' · ')}
        badge={plugin.installed && installedBadge}
      />
      <p className="line-clamp-2 text-[12px] leading-snug text-t2">{plugin.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        {live && (
          <span className="inline-flex items-center gap-1.5" title="Its node plugin in this instance's registry">
            <StatusDot status={live.status as PluginSummary['status']} /> {live.status} · {live.nodes} nodes
          </span>
        )}
        {plugin.read?.nodePlugin && <Badge tone="muted">{plugin.read.nodePlugin.runtime}</Badge>}
        {plugin.flows > 0 && <Badge tone="accent">Flows {plugin.flows}</Badge>}
        {plugin.category && <Chip>{categoryLabel(plugin.category)}</Chip>}
      </div>
    </button>
  );
}

function LocalPluginTile({ plugin }: { plugin: PluginSummary }) {
  return (
    <Link href={`/plugins?plugin=${encodeURIComponent(plugin.id)}`} className={tileClass}>
      <TileHead icon={<AppIcon icon={plugin.info.icon} color={plugin.info.color} size={28} />} title={plugin.info.name} sub={`This instance · v${plugin.info.version}`} badge={plugin.source === 'builtin' && <Badge tone="muted">Built in</Badge>} />
      <p className="line-clamp-2 text-[12px] leading-snug text-t2">{plugin.info.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot status={plugin.status} /> {plugin.status} · {plugin.nodes.length} nodes
        </span>
        <Badge tone="muted">{plugin.info.language}</Badge>
      </div>
    </Link>
  );
}

function FlowTile({ flow, types }: { flow: ExploreFlow; types: Record<string, NodeTypeInfo> }) {
  const needs = flow.pluginInstalled ? [] : flow.needs;
  return (
    <Link href={flow.link ?? '#'} className={tileClass}>
      <TemplateNodeIcons nodeTypes={flow.nodeTypes} types={types} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-t1">{flow.name}</div>
        <div className="truncate text-[11px] text-t3">
          {flow.pluginDisplayName ?? flow.plugin} · {flow.marketplace.name}
        </div>
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-t2">{flow.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        {flow.pluginInstalled ? installedBadge : <Badge tone="muted">Installs with {flow.pluginDisplayName ?? flow.plugin}</Badge>}
        {needs.length > 0 && (
          <Badge tone="warning" title={`Node types this instance doesn't have: ${needs.join(', ')}`}>
            Needs {needs.length} plugin{needs.length === 1 ? '' : 's'}
          </Badge>
        )}
        <span>{flow.nodeCount} nodes</span>
      </div>
    </Link>
  );
}

function TemplateTile({ template, types }: { template: TemplateSummary; types: Record<string, NodeTypeInfo> }) {
  return (
    <Link href={`/templates/${encodeURIComponent(template.id)}`} className={cn(tileClass, !template.usable && 'bg-sf2')}>
      <TemplateNodeIcons nodeTypes={template.nodeTypes} types={types} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-t1">{template.name}</div>
        <div className="truncate text-[11px] text-t3">{template.source === 'builtin' ? 'Built-in template' : template.projectName ? `Saved in ${template.projectName}` : 'Saved on this instance'}</div>
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-t2">{template.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        {!template.usable && <Badge tone="warning">Needs a plugin</Badge>}
        <span>{template.nodeCount} nodes</span>
      </div>
    </Link>
  );
}

function CompositeTile({ composite, onDeleted }: { composite: CompositeTypeInfo; onDeleted: () => void }) {
  const d = composite.descriptor;
  const required = d.slots.filter((x) => (x.min ?? 1) > 0).length;
  const local = composite.source.kind === 'local';
  const remove = async () => {
    try {
      await api(`/api/composites/${encodeURIComponent(composite.type)}`, { method: 'DELETE' });
      toast.success(`Deleted ${d.displayName}`);
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className={tileClass} title="Add one from the node creator (Composites), or type a group with it (the group’s Composite… button)">
      <TileHead
        icon={<AppIcon icon={d.icon ?? 'boxes'} color={d.color} size={28} />}
        title={d.displayName}
        sub={`${composite.source.kind === 'plugin' ? composite.source.pluginName : 'Saved on this instance'} · v${d.version}`}
        badge={
          local ? (
            <button aria-label={`Delete ${d.displayName}`} title="Delete this type (frames typed by it keep their nodes)" onClick={remove} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-rddim hover:text-rd">
              <Trash2 className="size-3.5" />
            </button>
          ) : (
            !composite.available && <Badge tone="muted">Plugin offline</Badge>
          )
        }
      />
      <p className="line-clamp-2 text-[12px] leading-snug text-t2">{d.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        <Badge tone="accent">
          <Boxes className="size-3" /> Composite
        </Badge>
        <span>
          {d.slots.length} slot{d.slots.length === 1 ? '' : 's'}, {required} required
        </span>
        {d.closed && <Chip>Closed</Chip>}
        <span className="truncate font-mono">{composite.type}</span>
      </div>
    </div>
  );
}

function ClaudePluginTile({ plugin, onOpen }: { plugin: ExplorePlugin; onOpen: () => void }) {
  const read = plugin.read;
  return (
    <button onClick={onOpen} className={tileClass}>
      <TileHead icon={<AppIcon icon="bot" size={28} />} title={plugin.displayName ?? plugin.name} sub={[plugin.marketplace.name, plugin.author].filter(Boolean).join(' · ')} badge={plugin.installed && installedBadge} />
      <p className="line-clamp-2 text-[12px] leading-snug text-t2">{plugin.description || 'No description.'}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        {read && read.agents > 0 && <Badge tone="accent">Agents {read.agents}</Badge>}
        {read && read.skills > 0 && <Badge tone="accent">Skills {read.skills}</Badge>}
        {plugin.category && <Chip>{categoryLabel(plugin.category)}</Chip>}
        {!plugin.supported && (
          <Badge tone="muted" title={plugin.unsupportedReason}>
            Unsupported source
          </Badge>
        )}
      </div>
    </button>
  );
}

function locationText(m: MarketplaceSummary) {
  const l = m.location;
  return l.kind === 'github' ? `github.com/${l.owner}/${l.repo}${l.ref ? ` @ ${l.ref}` : ''}` : l.kind === 'url' ? l.url : l.path;
}

export function Explore({ marketplaces, version, onAdd, onOpen, onChanged }: { marketplaces: MarketplaceSummary[]; version: number; onAdd: () => void; onOpen: (marketplaceId: string, name: string) => void; onChanged: () => void }) {
  const { explore, loading, error } = useExplore(version);
  const { listing } = useTemplateList('');
  const types = useNodeTypeMap();
  const [local, setLocal] = useState<PluginSummary[]>([]);
  const [composites, setComposites] = useState<CompositeTypeInfo[]>([]);
  const [compositesVersion, setCompositesVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [source, setSource] = useState<string>();
  const [category, setCategory] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api<{ plugins: PluginSummary[] }>('/api/plugins')
      .then((r) => setLocal(r.plugins))
      .catch(() => {});
  }, [version]);
  useEffect(() => {
    api<{ composites: CompositeTypeInfo[] }>('/api/composites')
      .then((r) => setComposites(r.composites))
      .catch(() => {});
  }, [version, compositesVersion]);
  useEffect(() => {
    if (source && source !== LOCAL && !marketplaces.some((m) => m.id === source)) setSource(undefined);
  }, [marketplaces, source]);

  const items = useMemo(() => (explore ? buildItems(explore.plugins, explore.flows, local, listing?.templates ?? [], composites) : []), [explore, local, listing, composites]);
  const inSource = useMemo(() => items.filter((i) => !source || i.source === source), [items, source]);
  const categories = useMemo(() => {
    const byLabel = new Map<string, string>();
    for (const item of inSource) for (const c of item.categories) byLabel.set(categoryLabel(c), byLabel.get(categoryLabel(c)) ?? c);
    return [...byLabel.keys()].sort((a, b) => a.localeCompare(b));
  }, [inSource]);
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inSource.filter((i) => (!category || i.categories.some((c) => categoryLabel(c) === category)) && (!q || i.text.includes(q)));
  }, [inSource, query, category]);
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: matching.length, nodes: 0, flows: 0, composites: 0, claude: 0 };
    for (const i of matching) c[i.kind]++;
    return c;
  }, [matching]);
  const sourceCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of items) c.set(i.source, (c.get(i.source) ?? 0) + 1);
    return c;
  }, [items]);

  const current = marketplaces.find((m) => m.id === source);
  const refresh = async () => {
    if (!current) return;
    setRefreshing(true);
    try {
      await api(`/api/marketplaces/${current.id}/refresh`, { method: 'POST' });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const remove = async () => {
    if (!current) return;
    try {
      await api(`/api/marketplaces/${current.id}`, { method: 'DELETE' });
      toast.success(`Removed ${current.name}`);
      setSource(undefined);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const tile = (item: Item) => {
    if (item.kind === 'nodes') return 'local' in item ? <LocalPluginTile key={item.key} plugin={item.local} /> : <NodePluginTile key={item.key} plugin={item.plugin} onOpen={() => onOpen(item.plugin.marketplace.id, item.plugin.name)} />;
    if (item.kind === 'flows') return 'template' in item ? <TemplateTile key={item.key} template={item.template} types={types} /> : <FlowTile key={item.key} flow={item.flow} types={types} />;
    if (item.kind === 'composites') return <CompositeTile key={item.key} composite={item.composite} onDeleted={() => setCompositesVersion((v) => v + 1)} />;
    return <ClaudePluginTile key={item.key} plugin={item.plugin} onOpen={() => onOpen(item.plugin.marketplace.id, item.plugin.name)} />;
  };
  const grid = (list: Item[]) => <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">{list.map(tile)}</div>;
  const chip = (active: boolean) => cn('inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors', active ? 'border-ac bg-acdim font-semibold text-ac' : 'border-hair bg-sf text-t1 hover:border-ac');

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-[360px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-t3" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plugins, workflows, agents…" className="pl-9" aria-label="Search the marketplace" />
        </div>
        <div role="tablist" aria-label="Kind" className="flex w-fit items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.id}
              role="tab"
              aria-selected={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cn('h-7 rounded-full px-3 text-[12px] text-t2 transition-all duration-200 hover:text-t1', kind === k.id && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]')}
            >
              {k.label} <span className="font-mono text-[11px] font-normal tabular-nums text-t3">{counts[k.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* A phone: source, its marketplace and the categories in a Filters sheet (desktop: in place, as they were). */}
      <PhoneFilters
        active={(source ? 1 : 0) + (category ? 1 : 0)}
        onClear={() => {
          setSource(undefined);
          setCategory(undefined);
        }}
      >
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Source">
          <button onClick={() => setSource(undefined)} aria-pressed={!source} className={chip(!source)}>
            All sources
          </button>
          {marketplaces.map((m) => (
            <button key={m.id} onClick={() => setSource(m.id)} aria-pressed={source === m.id} className={chip(source === m.id)}>
              {m.name}
              <span className="font-mono text-[11px] font-normal text-t3">{sourceCounts.get(m.id) ?? m.plugins}</span>
            </button>
          ))}
          <button onClick={() => setSource(LOCAL)} aria-pressed={source === LOCAL} className={chip(source === LOCAL)} title="The registry's own plugins and the Templates library">
            This instance
            <span className="font-mono text-[11px] font-normal text-t3">{sourceCounts.get(LOCAL) ?? 0}</span>
          </button>
          <button onClick={onAdd} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-bd px-3 text-[12px] text-t2 hover:border-ac hover:text-ac">
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
            <Button size="sm" onClick={() => void refresh()} loading={refreshing}>
              {!refreshing && <RefreshCw className="size-3.5" />} Refresh
            </Button>
            {current.removable && (
              <Button variant="ghost" size="sm" onClick={() => void remove()} aria-label={`Remove ${current.name}`}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
            )}
          </Card>
        )}

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
            {[undefined, ...categories].map((c) => (
              <button
                key={c ?? 'all'}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', category === c ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 hover:border-ac')}
              >
                {c ?? 'All categories'}
              </button>
            ))}
          </div>
        )}
      </PhoneFilters>

      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
      {explore && explore.errors.length > 0 && (
        <div className="rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
          {explore.errors.length === 1 ? 'Couldn’t read part of a marketplace' : `Couldn’t read ${explore.errors.length} things`}:{' '}
          {explore.errors
            .slice(0, 3)
            .map((e) => `${e.marketplace}: ${e.message}`)
            .join(' · ')}
          {explore.errors.length > 3 && ` · and ${explore.errors.length - 3} more`}
        </div>
      )}

      {explore &&
        (kind === 'all' && !query.trim() && !category ? (
          KINDS.filter((k) => k.id !== 'all').map((k) => {
            const list = matching.filter((i) => i.kind === k.id);
            if (!list.length) return null;
            return (
              <section key={k.id} className="flex flex-col gap-2.5">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[14px] font-semibold text-t1">{k.label}</h2>
                  <span className="font-mono text-[11px] text-t3">{list.length}</span>
                  {list.length > SECTION && (
                    <button onClick={() => setKind(k.id)} className="ml-auto inline-flex items-center gap-1 text-[12px] text-t2 hover:text-t1">
                      Show all <ArrowRight className="size-3.5" />
                    </button>
                  )}
                </div>
                {grid(list.slice(0, SECTION))}
              </section>
            );
          })
        ) : (
          grid(matching.filter((i) => kind === 'all' || i.kind === kind))
        ))}
      {explore && !matching.some((i) => kind === 'all' || i.kind === kind) && (
        <Card className="py-6">
          <EmptyState compact title="Nothing matches" hint={items.length ? 'Try another search, kind, source or category.' : 'Add a marketplace to explore its plugins and workflows.'} />
        </Card>
      )}
      {!explore && loading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-[148px] animate-pulse-soft rounded-2xl bg-wl" />
          ))}
        </div>
      )}
    </>
  );
}
