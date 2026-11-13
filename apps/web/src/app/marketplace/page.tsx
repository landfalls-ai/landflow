'use client';
/**
 * /marketplace — Explore (every plugin, workflow and agent across the added marketplaces and this instance), the
 * installed plugins, and the skill library. Opening a marketplace plugin shows its drawer: contents, README, Install.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { AddMarketplaceDialog } from '@/components/marketplace/add-marketplace-dialog';
import { Explore } from '@/components/marketplace/explore';
import { InstalledList } from '@/components/marketplace/installed-list';
import { PluginDrawer } from '@/components/marketplace/plugin-drawer';
import { SkillLibrary } from '@/components/marketplace/skill-library';
import { useMarketplaces, useSkillLibrary } from '@/components/marketplace/use-marketplace';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedCount } from '@/components/ui/segmented';

type Tab = 'explore' | 'installed' | 'skills';

export default function MarketplacePage() {
  const { marketplaces, presets, installed, error, reload } = useMarketplaces();
  const [tab, setTab] = useState<Tab>('explore');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ marketplaceId: string; name: string }>();
  const [version, setVersion] = useState(0);
  const skills = useSkillLibrary(version);

  // An install, uninstall, refresh or removal: reload the list, Explore and the skill library.
  const changed = () => {
    void reload();
    setVersion((v) => v + 1);
  };

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'explore', label: 'Explore' },
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

        <Segmented
          label="Marketplace"
          value={tab}
          onChange={setTab}
          options={tabs.map((t) => ({ value: t.id, label: <>{t.label}{t.count !== undefined && t.count > 0 && <SegmentedCount>{t.count}</SegmentedCount>}</> }))}
        />

        {tab === 'explore' && marketplaces && <Explore marketplaces={marketplaces} version={version} onAdd={() => setAdding(true)} onOpen={(marketplaceId, name) => setOpen({ marketplaceId, name })} onChanged={changed} />}

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
            setTab('explore');
            changed();
          }}
        />
      )}
      {open && <PluginDrawer marketplaceId={open.marketplaceId} name={open.name} onClose={() => setOpen(undefined)} onChanged={changed} />}
    </>
  );
}
