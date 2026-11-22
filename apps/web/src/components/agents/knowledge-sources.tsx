'use client';
/**
 * C22: the Sources panel of a saved knowledge base (Abilities → Knowledge base): a folder, an S3 prefix, a site or a Google Drive
 * folder kept in sync on a schedule. Each row says what it is, how the last sync went and when the next is; Sync now, Pause or Resume,
 * History (the runs and what failed) and Remove (which asks whether to delete the chunks, yes pre-selected). Phone: the rows stack and
 * the actions wrap; the add form and the history are sheets.
 */
import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { addSource, listSources, patchSource, removeSource, sourceRuns, syncSourceNow } from '@/lib/client/knowledge-sources';
import { timeAgo, plural } from '@/lib/client/format';
import { ENABLED_SOURCE_KINDS, SCHEDULE_LABEL, SOURCE_CREDENTIAL_TYPE, SOURCE_KIND_LABEL, SOURCE_LIMITS, SOURCE_SCHEDULES, sourceLocation, syncStatusLabel, syncSummary, type SourceKind, type SourceSchedule, type SourceView, type SyncRunView } from '@/lib/shared/knowledge-sources';
import { CredentialCombobox } from '../credentials/credential-combobox';
import { useCredentials } from '../credentials/use-credentials';
import { Button } from '../ui/button';
import { DataGrid, type GridColumn } from '../ui/data-grid';
import { Input, Select } from '../ui/inputs';
import { Segmented } from '../ui/segmented';
import { Sheet } from '../ui/sheet';
import { Field } from './dialog';

/** The line under a source: how the last sync went, or why it is paused, and when the next one is. */
export function sourceStatusLine(source: SourceView, now = Date.now()): string {
  if (source.running) return 'Syncing now…';
  const parts: string[] = [];
  if (source.paused) parts.push(source.pausedReason && !/^paused/i.test(source.pausedReason) ? `Paused: ${source.pausedReason}` : 'Paused');
  if (source.lastRun) parts.push(`${syncStatusLabel(source.lastRun.status)} ${timeAgo(source.lastRun.startedAt)}`);
  else if (!source.paused) parts.push('Not synced yet');
  if (!source.paused && source.nextAt && source.schedule !== 'manual') {
    const minutes = Math.max(0, Math.round((Date.parse(source.nextAt) - now) / 60_000));
    parts.push(minutes <= 1 ? 'next sync due' : `next in ${minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`);
  }
  return parts.join(' · ');
}

export function SourcesPanel({ agentId, toolId, onCount }: { agentId: string; toolId: string; onCount?: (n: number) => void }) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<SourceView>();
  const [removing, setRemoving] = useState<SourceView>();

  const load = useCallback(async () => {
    try {
      const rows = await listSources(agentId, toolId);
      setSources(rows);
      setProblem(undefined);
      onCount?.(rows.length);
    } catch (error) {
      setProblem((error as Error).message);
      setSources([]);
    }
  }, [agentId, toolId, onCount]);
  useEffect(() => {
    void load();
  }, [load]);
  // While something syncs, look again every few seconds.
  const anyRunning = sources?.some((s) => s.running);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) toast.success(done);
    } catch (error) {
      toast.error((error as Error).message);
    }
    await load();
  };

  return (
    <div className="space-y-2 rounded-[10px] border border-hair p-3" data-testid="kb-sources">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-t1">Sources</div>
          <div className="text-[11.5px] text-t3">Keep a folder, bucket, website or Drive folder in this knowledge base, on a schedule</div>
        </div>
        <Button variant="outline" size="sm" disabled={(sources?.length ?? 0) >= SOURCE_LIMITS.sourcesPerBase} onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          Add source
        </Button>
      </div>
      {problem && <p className="text-[12px] text-rd">{problem}</p>}
      {sources?.length === 0 && !problem && <p className="text-[12px] text-t3">No sources yet. Documents you upload stay as they are.</p>}
      {sources?.map((source) => (
        <div key={source.id} className="rounded-[8px] bg-wl px-2.5 py-2 text-[12.5px]" data-testid="kb-source">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0 rounded-md border border-hair px-1.5 text-[11px] text-t2">{SOURCE_KIND_LABEL[source.kind]}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-t1" title={sourceLocation(source.kind, source.settings)}>
              {source.name}
            </span>
            <span className="shrink-0 text-t3">{source.schedule === 'manual' ? 'Manual' : SCHEDULE_LABEL[source.schedule]}</span>
          </div>
          <div className="mt-0.5 text-[11.5px] text-t3" data-testid="kb-source-status">
            {sourceStatusLine(source)}
            {source.lastRun && !source.running && <> · {syncSummary(source.lastRun)}</>}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" disabled={source.running} onClick={() => void act(() => syncSourceNow(agentId, toolId, source.id), 'Sync started')}>
              {source.running ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Sync now
            </Button>
            <Button variant="outline" size="sm" onClick={() => void act(() => patchSource(agentId, toolId, source.id, { paused: !source.paused }))}>
              {source.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {source.paused ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setHistory(source)}>
              <History className="size-3.5" />
              History
            </Button>
            <Button variant="outline" size="sm" disabled={source.running} aria-label={`Remove ${source.name}`} onClick={() => setRemoving(source)}>
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          </div>
        </div>
      ))}
      {adding && (
        <AddSource
          onClose={() => setAdding(false)}
          onAdd={async (input) => {
            await addSource(agentId, toolId, input);
            setAdding(false);
            toast.success('Source added');
            await load();
          }}
        />
      )}
      {history && <HistorySheet agentId={agentId} toolId={toolId} source={history} onClose={() => setHistory(undefined)} />}
      {removing && (
        <RemoveSheet
          source={removing}
          onClose={() => setRemoving(undefined)}
          onRemove={(deleteChunks) =>
            void act(async () => {
              const { removedChunks } = await removeSource(agentId, toolId, removing.id, deleteChunks);
              setRemoving(undefined);
              toast.success(deleteChunks ? `Source removed, ${plural(removedChunks, 'chunk')} deleted` : 'Source removed, its chunks stay');
            })
          }
        />
      )}
    </div>
  );
}

/** D4: removing asks about the chunks, delete pre-selected. */
function RemoveSheet({ source, onClose, onRemove }: { source: SourceView; onClose: () => void; onRemove: (deleteChunks: boolean) => void }) {
  const [deleteChunks, setDeleteChunks] = useState(true);
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Remove ${source.name}?`}
      footer={
        <div className="flex justify-end gap-2 p-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => onRemove(deleteChunks)}>
            Remove source
          </Button>
        </div>
      }
    >
      <fieldset className="space-y-2 p-4 text-[13px]">
        <legend className="sr-only">What happens to the chunks it wrote</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="chunks" checked={deleteChunks} onChange={() => setDeleteChunks(true)} />
          <span>Delete the chunks it wrote. Uploaded documents and other sources are not touched.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="chunks" checked={!deleteChunks} onChange={() => setDeleteChunks(false)} />
          <span>Keep them in the knowledge base.</span>
        </label>
      </fieldset>
    </Sheet>
  );
}

function HistorySheet({ agentId, toolId, source, onClose }: { agentId: string; toolId: string; source: SourceView; onClose: () => void }) {
  const [runs, setRuns] = useState<SyncRunView[] | null>(null);
  const [next, setNext] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const load = useCallback(
    (cursor?: string) =>
      sourceRuns(agentId, toolId, source.id, cursor)
        .then((page) => {
          setRuns((old) => (cursor ? [...(old ?? []), ...page.runs] : page.runs));
          setNext(page.next);
        })
        .catch((error: Error) => setProblem(error.message)),
    [agentId, toolId, source.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const columns: Array<GridColumn<SyncRunView>> = [
    { key: 'startedAt', label: 'Started', type: 'text', format: (v) => timeAgo(String(v)), width: 90 },
    { key: 'trigger', label: 'By', type: 'text', format: (v) => (v === 'manual' ? 'Manual' : 'Schedule'), width: 100 },
    { key: 'status', label: 'Result', type: 'text', format: (v) => syncStatusLabel(v as SyncRunView['status']), width: 120 },
    { key: 'counts', label: 'What changed', type: 'text', render: (row) => <span>{syncSummary(row)}</span>, width: 460 },
    { key: 'note', label: 'Note', type: 'text', render: (row) => <span title={row.errors.map((e) => `${e.item}: ${e.reason}`).join('\n')}>{[row.note, row.errors[0] && `${row.errors[0].item}: ${row.errors[0].reason}`].filter(Boolean).join(' · ')}</span>, width: 260 },
  ];
  return (
    <Sheet open onClose={onClose} title={`History: ${source.name}`} className="md:max-w-[960px]">
      <div className="space-y-2 p-3" data-testid="kb-source-history">
        {problem && <p className="text-[12px] text-rd">{problem}</p>}
        <DataGrid columns={columns} rows={runs ?? []} readOnly minWidth={1000} label="Sync runs" empty={<span className="text-[12px] text-t3">{runs ? 'No syncs yet.' : 'Loading…'}</span>} className="max-h-[50dvh]" />
        {next && (
          <Button variant="outline" size="sm" onClick={() => void load(next)}>
            Older runs
          </Button>
        )}
      </div>
    </Sheet>
  );
}

const PLACEHOLDER: Record<SourceKind, string> = { folder: 'runbooks', s3: 'docs', crawl: 'https://docs.example.com/', googleDrive: 'Folder id from the Drive link' };

function AddSource({ onClose, onAdd }: { onClose: () => void; onAdd: (input: Parameters<typeof addSource>[2]) => Promise<void> }) {
  const [kind, setKind] = useState<SourceKind>('folder');
  const [schedule, setSchedule] = useState<SourceSchedule>('daily');
  const [folder, setFolder] = useState('');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('');
  const [url, setUrl] = useState('');
  const [depth, setDepth] = useState(2);
  const [pages, setPages] = useState(100);
  const [driveId, setDriveId] = useState('');
  const [subfolders, setSubfolders] = useState(true);
  const [credential, setCredential] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { credentials } = useCredentials();
  const type = SOURCE_CREDENTIAL_TYPE[kind];
  const usable = (credentials ?? []).filter((c) => c.type === type);
  useEffect(() => setCredential(undefined), [kind]);
  useEffect(() => {
    if (type && !credential && usable.length === 1) setCredential(usable[0].id);
  }, [type, credential, usable]);

  const settings: Record<string, unknown> =
    kind === 'folder' ? { folder: folder.trim() } : kind === 's3' ? { bucket: bucket.trim(), prefix: prefix.trim() } : kind === 'crawl' ? { startUrl: url.trim(), maxDepth: depth, maxPages: pages } : { folderId: driveId.trim(), includeSubfolders: subfolders };
  const valid = kind === 'folder' ? Boolean(folder.trim()) : kind === 's3' ? Boolean(bucket.trim() && credential) : kind === 'crawl' ? Boolean(url.trim()) : Boolean(driveId.trim() && credential);
  const submit = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await onAdd({ kind, settings, schedule, ...(credential && type && { credentialId: credential }) });
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Add a source"
      footer={
        <div className="flex justify-end gap-2 p-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add source'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 overflow-y-auto p-4" data-testid="kb-source-form">
        <Segmented label="Kind of source" value={kind} onChange={setKind} options={ENABLED_SOURCE_KINDS.map((k) => ({ value: k, label: SOURCE_KIND_LABEL[k] }))} stretch />
        {kind === 'folder' && (
          <Field id="src-folder" label="Folder" required hint="A folder of the files directory">
            <Input id="src-folder" value={folder} placeholder={PLACEHOLDER.folder} onChange={(e) => setFolder(e.target.value)} />
          </Field>
        )}
        {kind === 's3' && (
          <>
            <Field id="src-bucket" label="Bucket" required>
              <Input id="src-bucket" value={bucket} placeholder={PLACEHOLDER.s3} onChange={(e) => setBucket(e.target.value)} />
            </Field>
            <Field id="src-prefix" label="Prefix" hint="Only keys that start with this">
              <Input id="src-prefix" value={prefix} placeholder="guides/" onChange={(e) => setPrefix(e.target.value)} />
            </Field>
          </>
        )}
        {kind === 'crawl' && (
          <>
            <Field id="src-url" label="Start address" required hint="Only pages on the same site are read; robots.txt is obeyed">
              <Input id="src-url" value={url} placeholder={PLACEHOLDER.crawl} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="src-depth" label="Link depth" hint={`Up to ${SOURCE_LIMITS.crawlDepth}`}>
                <Input id="src-depth" type="number" min={0} max={SOURCE_LIMITS.crawlDepth} value={depth} onChange={(e) => setDepth(Math.max(0, Math.min(SOURCE_LIMITS.crawlDepth, Number(e.target.value) || 0)))} />
              </Field>
              <Field id="src-pages" label="Pages" hint={`Up to ${SOURCE_LIMITS.crawlPages}`}>
                <Input id="src-pages" type="number" min={1} max={SOURCE_LIMITS.crawlPages} value={pages} onChange={(e) => setPages(Math.max(1, Math.min(SOURCE_LIMITS.crawlPages, Number(e.target.value) || 1)))} />
              </Field>
            </div>
          </>
        )}
        {kind === 'googleDrive' && (
          <>
            <Field id="src-drive" label="Drive folder" required>
              <Input id="src-drive" value={driveId} placeholder={PLACEHOLDER.googleDrive} onChange={(e) => setDriveId(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={subfolders} onChange={(e) => setSubfolders(e.target.checked)} />
              Include subfolders
            </label>
          </>
        )}
        {type && (
          <Field id="src-credential" label={kind === 's3' ? 'S3 credential' : 'Google account'} required hint={kind === 'googleDrive' ? 'Connect a Google account under Credentials first' : undefined}>
            <CredentialCombobox id="src-credential" label="Credential" credentials={usable} value={credential} onPick={(c) => setCredential(c.id)} onCreate={() => toast('Create it under Credentials, then pick it here')} />
          </Field>
        )}
        <Field id="src-schedule" label="Sync">
          <Select id="src-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value as SourceSchedule)}>
            {SOURCE_SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        {problem && <p className="text-[12px] text-rd">{problem}</p>}
      </div>
    </Sheet>
  );
}
