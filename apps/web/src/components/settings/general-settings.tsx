'use client';
/**
 * Settings → General: the instance's default time zone and execution
 * retention (keep at most N, delete older than D days), with "Prune now" in the ⋯ menu; the experimental switch is under Advanced.
 */
import { useEffect, useMemo, useState } from 'react';
import { Blocks, ChevronDown, ChevronRight, Eraser, Globe, History, MoreHorizontal, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { InstanceSettings } from '@/lib/shared/platform';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { HelpTip } from '@/components/ui/help-tip';
import { MenuItem, Popover } from '@/components/ui/popover';
import { FieldLabel, Input, SectionLabel, Select } from '@/components/ui/inputs';
import { plural } from '@/lib/client/format';

interface SettingsView {
  settings: InstanceSettings;
  jsonRender: boolean;
  hostTimezone: string;
  executions: { stored: number; prunable: number };
}

function timeZones(current: string, host: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return [...new Set(['UTC', host, current, ...zones])].filter(Boolean).sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/** "UTC+02:00"-style offset of a zone right now. */
function offsetOf(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value.replace('GMT', 'UTC') || '';
  } catch {
    return '';
  }
}


export function GeneralSettings() {
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<InstanceSettings>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const load = () =>
    api<SettingsView>('/api/settings')
      .then((v) => {
        setView(v);
        setDraft(v.settings);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const zones = useMemo(() => (view && draft ? timeZones(draft.timezone, view.hostTimezone) : []), [view, draft]);
  const dirty = Boolean(view && draft && JSON.stringify({ ...view.settings, jsonRender: 0 }) !== JSON.stringify({ ...draft, jsonRender: 0 }));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await api<SettingsView>('/api/settings', { method: 'PATCH', json: { timezone: draft.timezone, executions: draft.executions } });
      setView(next);
      setDraft(next.settings);
      toast.success('Settings saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const prune = async () => {
    setPruning(true);
    try {
      const { removed } = await api<{ removed: number; remaining: number }>('/api/settings/prune', { method: 'POST' });
      toast.success(removed ? `Removed ${plural(removed, 'execution')}` : 'Nothing to prune');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPruning(false);
    }
  };

  const [switching, setSwitching] = useState(false);
  const switchJsonRender = async (on: boolean) => {
    setSwitching(true);
    try {
      const next = await api<SettingsView>('/api/settings', { method: 'PATCH', json: { jsonRender: on } });
      setView((v) => v && { ...v, jsonRender: next.jsonRender, settings: { ...v.settings, jsonRender: next.settings.jsonRender } });
      setDraft((d) => d && { ...d, jsonRender: next.settings.jsonRender });
      toast.success(`json-render ${next.jsonRender ? 'on' : 'off'}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  const setRetention = (field: 'maxCount' | 'maxAgeDays', raw: string) => {
    const value = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)));
    if (Number.isFinite(value)) setDraft((d) => d && { ...d, executions: { ...d.executions, [field]: value } });
  };

  if (!view || !draft) {
    return error ? (
      <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>
    ) : (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="h-36 rounded-2xl border border-hair bg-sf animate-pulse-soft" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
    );
  }

  const { maxCount, maxAgeDays } = draft.executions;
  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <Globe className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Time zone</SectionLabel>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,320px)_1fr] sm:items-end">
          <div>
            <FieldLabel>Default time zone</FieldLabel>
            <Select value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} aria-label="Default time zone">
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                  {zone === view.hostTimezone ? ' (host)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <p className="pb-2 text-[12px] leading-relaxed text-t3">
            {offsetOf(draft.timezone)} · Used when a workflow doesn’t set its own time zone.
            <HelpTip label="Where the time zone applies" className="ml-1 align-middle">
              Schedules, Date &amp; Time nodes and the days in Insights.
            </HelpTip>
          </p>
        </div>
      </Card>

      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <History className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Execution retention</SectionLabel>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>Keep at most</FieldLabel>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} step={1} value={maxCount} onChange={(e) => setRetention('maxCount', e.target.value)} className="w-32 font-mono" aria-label="Maximum executions" />
              <span className="text-[13px] text-t2">executions</span>
            </div>
            <p className="mt-1.5 text-[12px] text-t3">{maxCount ? 'The oldest finished runs go first.' : 'No limit on the number of runs.'}</p>
          </div>
          <div>
            <FieldLabel>Delete executions older than</FieldLabel>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} step={1} value={maxAgeDays} onChange={(e) => setRetention('maxAgeDays', e.target.value)} className="w-32 font-mono" aria-label="Maximum age in days" />
              <span className="text-[13px] text-t2">days</span>
            </div>
            <p className="mt-1.5 text-[12px] text-t3">{maxAgeDays ? `Runs started more than ${plural(maxAgeDays, 'day')} ago are deleted.` : 'Off: runs are kept regardless of age.'}</p>
          </div>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-t3">
          0 turns a limit off.
          <HelpTip label="About execution retention" className="ml-1 align-middle">
            Running and waiting executions are never deleted. Retention applies after every run and hourly; Insights keeps its counts after runs are deleted.
          </HelpTip>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hair pt-3.5">
          <span className="text-[12px] text-t2">
            {plural(view.executions.stored, 'execution')} stored
            {view.executions.prunable > 0 && <span className="text-warn"> · {view.executions.prunable.toLocaleString('en-US')} past the saved limits</span>}
          </span>
          <span className="ml-auto">
            <Popover
              title="Executions"
              trigger={({ open, toggle }) => (
                <Button variant="ghost" size="icon-sm" onClick={toggle} loading={pruning} aria-label="More retention actions" aria-expanded={open} aria-haspopup="menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              )}
            >
              {(close) => (
                <MenuItem
                  onClick={() => {
                    close();
                    void prune();
                  }}
                  hint="Apply the saved limits now"
                >
                  <Eraser /> Prune now
                </MenuItem>
              )}
            </Popover>
          </span>
        </div>
      </Card>

      <div id="general-advanced">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="flex min-h-8 items-center gap-1.5 text-[13px] font-semibold text-t2 max-md:min-h-11">
          {advanced ? <ChevronDown className="size-4 text-t3" /> : <ChevronRight className="size-4 text-t3" />}
          Advanced
        </button>
        {advanced && (
          <Card className="mt-2 px-5 py-4">
            <div className="mb-3 flex items-center gap-2">
              <Blocks className="size-4 text-t3" strokeWidth={1.8} />
              <SectionLabel>Experimental</SectionLabel>
            </div>
            <label className="flex items-start gap-3 text-[13px] text-t1">
              <input type="checkbox" className="mt-0.5 size-4" checked={view.jsonRender} disabled={switching} onChange={(e) => void switchJsonRender(e.target.checked)} aria-label="json-render spec cards" />
              <span>
                json-render spec cards
                <span className="mt-1 block text-[12px] leading-relaxed text-t3">
                  A prototype for model-written cards in the Run trace; only the owner can switch it.
                  <HelpTip label="About json-render" className="ml-1 align-middle">
                    Nothing produces specs yet. On: the dev page at /runs/json-render-gallery appears, without a rebuild.
                    {view.settings.jsonRender === undefined ? ' Following the LANDFLOW_JSON_RENDER default.' : ''}
                  </HelpTip>
                </span>
              </span>
            </label>
          </Card>
        )}
      </div>

      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(view.settings)}>
            Discard
          </Button>
        )}
        <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
          <Save className="size-3.5" /> Save
        </Button>
      </div>
    </div>
  );
}
