'use client';
/**
 * Abilities tab → Claude Code plugins: plugins from the added marketplaces that Claude Code loads whole (its agents, skills,
 * commands, hooks and MCP servers) when the agent runs on kagent's Claude Code runtime (docs/agents.md). Deploying pins
 * each to the commit it is at then. Other runtimes don't use them; their skills come in through the Skills card.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Puzzle, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import type { AgentConfig } from '@/lib/shared/agents';
import type { ExplorePlugin, ExploreResult } from '@/lib/shared/marketplace';
import { Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Input } from '../ui/inputs';
import { Dialog, ItemRow, Section } from './dialog';
import type { UpdateConfig } from './util';

const idOf = (plugin: Pick<ExplorePlugin, 'name' | 'marketplace'>) => `${plugin.name}@${plugin.marketplace.name}`;

const PluginIcon = () => (
  <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2">
    <Puzzle className="size-3.5" />
  </span>
);

function PluginPicker({ chosen, onPick, onClose }: { chosen: string[]; onPick: (id: string) => void; onClose: () => void }) {
  const [plugins, setPlugins] = useState<ExplorePlugin[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  useEffect(() => {
    api<ExploreResult>('/api/marketplaces/explore')
      // Node plugins run in Landflow, not in Claude Code.
      .then((result) => setPlugins(result.plugins.filter((p) => !p.landflow && p.supported)))
      .catch((e: Error) => {
        setPlugins([]);
        setError(e.message);
      });
  }, []);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (plugins ?? []).filter((p) => words.every((w) => `${p.name} ${p.displayName ?? ''} ${p.description} ${p.marketplace.name} ${p.keywords.join(' ')}`.toLowerCase().includes(w))).slice(0, 60);
  }, [plugins, query]);

  return (
    <Dialog
      title="Add a Claude Code plugin"
      subtitle="From the marketplaces added on the Marketplace page. Claude Code loads the whole plugin when the agent runs on kagent’s Claude Code runtime."
      icon={<PluginIcon />}
      onClose={onClose}
      width={620}
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
          <Input aria-label="Search plugins" autoFocus className="pl-8" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {error && <p className="text-[12px] text-rd">{error}</p>}
        {!plugins ? (
          <p className="text-[12px] text-t3">Reading the marketplaces…</p>
        ) : shown.length ? (
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {shown.map((plugin) => {
              const id = idOf(plugin);
              const added = chosen.includes(id);
              return (
                <ItemRow
                  key={id}
                  icon={<PluginIcon />}
                  title={plugin.displayName ?? plugin.name}
                  subtitle={plugin.description}
                  badges={
                    <>
                      <Chip mono>{plugin.marketplace.name}</Chip>
                      {added && <Chip tone="success">Added</Chip>}
                    </>
                  }
                  onClick={added ? undefined : () => onPick(id)}
                />
              );
            })}
          </div>
        ) : (
          <EmptyState
            compact
            title={plugins.length ? 'No plugin matches' : 'No marketplace plugins'}
            hint={
              plugins.length ? undefined : (
                <>
                  Add a marketplace on the{' '}
                  <Link href="/marketplace" className="text-ac hover:underline">
                    Marketplace
                  </Link>{' '}
                  page.
                </>
              )
            }
          />
        )}
      </div>
    </Dialog>
  );
}

export function PluginsCard({ config, update }: { config: AgentConfig; update: UpdateConfig }) {
  const [picking, setPicking] = useState(false);
  const plugins = config.plugins ?? [];
  const set = (next: string[]) => update((c) => ({ ...c, plugins: next.length ? next : undefined }));

  return (
    <Section
      icon={<Puzzle className="size-4" />}
      title="Claude Code plugins"
      description="On kagent’s Claude Code runtime, Claude Code loads these whole: their agents, skills, commands and hooks. Deploying pins each to its current commit."
      actions={
        <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
          <Plus className="size-3.5" /> Add plugin
        </Button>
      }
    >
      {plugins.length ? (
        <div className="space-y-1.5">
          {plugins.map((id) => {
            const at = id.lastIndexOf('@');
            return (
              <ItemRow
                key={id}
                icon={<PluginIcon />}
                title={id.slice(0, at)}
                badges={<Chip mono>{id.slice(at + 1)}</Chip>}
                actions={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${id}`}
                    title="Remove"
                    className="hover:bg-rddim hover:text-rd"
                    onClick={() => set(plugins.filter((p) => p !== id))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                }
              />
            );
          })}
        </div>
      ) : (
        <EmptyState compact title="No plugins" hint="Only the Claude Code runtime uses them. Choose one on the Deploy tab’s kagent card." />
      )}
      {picking && (
        <PluginPicker
          chosen={plugins}
          onPick={(id) => {
            set([...plugins, id]);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Section>
  );
}
