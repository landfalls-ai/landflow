'use client';
/**
 * The Installed tab: plugins (what each install created, node-plugin processes, Uninstall) and the skills they brought
 * (the skill library) in one list, with a type filter.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Bot, Package, RefreshCw, ScrollText, Sparkles, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { InstalledPlugin, LibrarySkill } from '@/lib/shared/marketplace';
import { Card } from '../shell/page-header';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Segmented, SegmentedCount } from '../ui/segmented';
import { SkillLibrary } from './skill-library';
import { UNSUPPORTED_LABEL } from './use-marketplace';

export type InstalledType = 'all' | 'plugins' | 'skills';

/** Which of the two lists a type filter shows. */
export const installedShows = (type: InstalledType) => ({ plugins: type !== 'skills', skills: type !== 'plugins' });

const STATE_TONE: Record<string, Tone> = { running: 'success', starting: 'accent', installing: 'accent', restarting: 'warning', crashed: 'danger', stopped: 'muted' };

function InstalledRow({ plugin, onChanged }: { plugin: InstalledPlugin; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>();
  const key = encodeURIComponent(plugin.id);

  const uninstall = async () => {
    setBusy(true);
    try {
      const { removed } = await api<{ removed: { agents: number; skills: number; nodePlugin: boolean } }>(`/api/marketplaces/installed/${key}`, { method: 'DELETE' });
      toast.success(`Uninstalled ${plugin.id}: ${removed.agents} agent(s), ${removed.skills} skill(s)${removed.nodePlugin ? ', node plugin stopped' : ''}`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  const restart = async () => {
    try {
      await api(`/api/marketplaces/installed/${key}/restart`, { method: 'POST' });
      toast.success(`Restarted ${plugin.nodePlugin?.pluginId}`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const toggleLogs = async () => {
    if (logs) return setLogs(undefined);
    try {
      setLogs((await api<{ lines: string[] }>(`/api/marketplaces/installed/${key}/logs`)).lines);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const status = plugin.nodePlugin?.status;

  return (
    <div className="border-b border-hair px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-[28%] border border-hair bg-acdim text-ac">
          <Package className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-t1">{plugin.plugin}</span>
            <span className="font-mono text-[11px] text-t3">@{plugin.marketplaceName}</span>
            {plugin.version && <Badge tone="muted">v{plugin.version}</Badge>}
            <span className="text-[12px] text-t3">installed {timeAgo(plugin.installedAt)}</span>
          </div>
          {plugin.description && <p className="mt-0.5 line-clamp-1 text-[12px] text-t2">{plugin.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
            {plugin.agents.map((agent) => (
              <Link key={agent.id} href={`/agents/${agent.id}`} className="inline-flex items-center gap-1 rounded-full border border-acbd bg-acdim px-2.5 py-px text-ac hover:underline">
                <Bot className="size-3" /> {agent.name}
              </Link>
            ))}
            {plugin.skills.map((skill) => (
              <span key={skill.id} className="inline-flex items-center gap-1 rounded-full border border-gnbd bg-gndim px-2.5 py-px text-gn">
                <Sparkles className="size-3" /> {skill.name}
              </span>
            ))}
            {plugin.templates?.map((template) => (
              <Link key={template.id} href={`/templates/${template.id}`} className="inline-flex items-center gap-1 rounded-full border border-acbd bg-acdim px-2.5 py-px text-ac hover:underline">
                <Workflow className="size-3" /> {template.name}
              </Link>
            ))}
            {plugin.unsupported.length > 0 && (
              <span className="text-[11px] text-t3" title={plugin.unsupported.map((u) => `${u.kind}: ${u.items.join(', ')}`).join('\n')}>
                not installed: {plugin.unsupported.map((u) => UNSUPPORTED_LABEL[u.kind] ?? u.kind).join(', ')}
              </span>
            )}
          </div>
          {plugin.nodePlugin && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
              <Badge tone={STATE_TONE[status?.state ?? 'stopped']}>{status?.state ?? 'stopped'}</Badge>
              <span className="font-mono text-[11px] text-t2">
                {plugin.nodePlugin.pluginId} · :{plugin.nodePlugin.port}
                {status?.pid ? ` · pid ${status.pid}` : ''}
                {status?.restarts ? ` · ${status.restarts} restart${status.restarts === 1 ? '' : 's'}` : ''}
              </span>
              <span className="truncate font-mono text-[11px] text-t3" title={plugin.nodePlugin.dir}>
                $ {plugin.nodePlugin.command}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void toggleLogs()}>
                <ScrollText className="size-3.5" /> {logs ? 'Hide logs' : 'Logs'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void restart()}>
                <RefreshCw className="size-3.5" /> Restart
              </Button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {confirming ? (
            <>
              <span className="max-w-[220px] text-right text-[11px] leading-snug text-t3">
                Deletes {plugin.agents.length} agent{plugin.agents.length === 1 ? '' : 's'} (with your edits) and {plugin.skills.length} skill{plugin.skills.length === 1 ? '' : 's'}
                {plugin.templates?.length ? `, ${plugin.templates.length} flow template${plugin.templates.length === 1 ? '' : 's'}` : ''}
                {plugin.nodePlugin ? ', stops the node plugin' : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void uninstall()} loading={busy}>
                Uninstall
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Uninstall
            </Button>
          )}
        </div>
      </div>
      {logs && (
        <pre className="mt-2.5 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl border border-hair bg-wl px-3 py-2 font-mono text-[11px] leading-relaxed text-t2">
          {logs.length ? logs.join('\n') : 'No output yet.'}
        </pre>
      )}
    </div>
  );
}

export function InstalledList({ installed, skills, onChanged }: { installed: InstalledPlugin[]; skills: LibrarySkill[] | undefined; onChanged: () => void }) {
  const [type, setType] = useState<InstalledType>('all');
  const counts: Record<InstalledType, number> = { all: installed.length + (skills?.length ?? 0), plugins: installed.length, skills: skills?.length ?? 0 };
  const show = installedShows(type);
  if (counts.all === 0 && skills) {
    return (
      <Card className="py-6">
        <EmptyState title="Nothing installed yet" hint="Install a plugin from Explore: its agents show up under Agents and its skills here, ready to add to any agent." />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Type"
        value={type}
        onChange={setType}
        options={([['all', 'All'], ['plugins', 'Plugins'], ['skills', 'Skills']] as const).map(([value, label]) => ({ value, label: <>{label} <SegmentedCount>{counts[value]}</SegmentedCount></> }))}
      />
      {show.plugins && installed.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
          {installed.map((plugin) => (
            <InstalledRow key={plugin.id} plugin={plugin} onChanged={onChanged} />
          ))}
        </div>
      )}
      {show.plugins && !installed.length && type === 'plugins' && (
        <Card className="py-6">
          <EmptyState compact title="No plugins installed" hint="Install one from Explore." />
        </Card>
      )}
      {show.skills && (type === 'skills' || (skills?.length ?? 0) > 0 || !skills) && <SkillLibrary skills={skills} />}
    </div>
  );
}
