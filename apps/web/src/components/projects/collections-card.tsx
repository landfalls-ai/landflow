'use client';
/**
 * C21: the project's Collections card (docs/projects-and-goals.md#collections). The vector collections the project owns (the first
 * project to write a collection owns it), the ones other projects shared with it (read or write), and who else may use each of
 * its own. An admin of the owner shares a collection with another project or with every project, stops sharing, and grants back
 * what the upgrade took away (the notice lists every project that lost access, with one-click Grant read / Grant write). A
 * project with its own Notion knowledge can let its flows read it. Members see the lists and no buttons; on a phone the rows stack.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { ALL_PROJECTS_GRANT, COLLECTION_LEVELS, type CollectionLevel, type CollectionView, type ProjectCollections } from '@/lib/shared/collections';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, Switch } from '@/components/ui/inputs';
import { projectLabel, useProjects } from './use-projects';

const BTN = 'max-md:min-h-11';
const LEVEL_LABEL: Record<CollectionLevel, string> = { read: 'Can search', write: 'Can search and change' };
const errorOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** Share one collection: a project (or all) and read or write. */
function ShareRow({ collection, base, onDone }: { collection: CollectionView; base: string; onDone: () => void }) {
  const { projects } = useProjects();
  const [target, setTarget] = useState('');
  const [level, setLevel] = useState<CollectionLevel>('read');
  const [saving, setSaving] = useState(false);
  const taken = new Set((collection.grants ?? []).map((g) => g.projectId));
  const choices = (projects ?? []).filter((p) => p.id !== collection.ownerProjectId && !taken.has(p.id));
  const share = async () => {
    setSaving(true);
    try {
      await api(`${base}/${encodeURIComponent(collection.key)}`, { method: 'POST', json: { grant: { projectId: target, level } } });
      toast.success(`Shared “${collection.name}”`);
      setTarget('');
      onDone();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch" data-testid="collection-share">
      <Select aria-label="Share with" value={target} onChange={(e) => setTarget(e.target.value)} className="min-w-[10rem] max-md:min-h-11">
        <option value="">Share with…</option>
        {!taken.has(ALL_PROJECTS_GRANT) && <option value={ALL_PROJECTS_GRANT}>All projects</option>}
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {projectLabel(p)}
          </option>
        ))}
      </Select>
      <Select aria-label="Access" value={level} onChange={(e) => setLevel(e.target.value as CollectionLevel)} className="max-md:min-h-11">
        {COLLECTION_LEVELS.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="outline" className={BTN} disabled={!target} loading={saving} onClick={() => void share()}>
        Share
      </Button>
    </div>
  );
}

export function CollectionsCard({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectCollections>();
  const base = `/api/projects/${encodeURIComponent(projectId)}/collections`;
  const load = useCallback(() => {
    api<ProjectCollections>(base)
      .then(setView)
      .catch((e: Error) => toast.error(e.message));
  }, [base]);
  useEffect(load, [load]);
  const post = async (key: string, json: unknown, done: string) => {
    try {
      await api(`${base}/${encodeURIComponent(key)}`, { method: 'POST', json });
      toast.success(done);
      load();
    } catch (e) {
      toast.error(errorOf(e));
    }
  };
  if (!view) return <Card className="h-24 animate-pulse-soft">{null}</Card>;
  return <CollectionsCardView view={view} base={base} post={post} reload={load} />;
}

/** The card for a loaded view (the tests draw it without a server). `post` changes one collection: its key, the body and the toast. */
export function CollectionsCardView({ view, base, post, reload, initiallyOpen }: { view: ProjectCollections; base: string; post: (key: string, json: unknown, done: string) => void; reload: () => void; initiallyOpen?: string }) {
  const [open, setOpen] = useState<string | undefined>(initiallyOpen);
  const nameOf = (p: { projectName?: string; projectId: string }) => p.projectName ?? p.projectId;

  return (
    <Card className="space-y-3" data-testid="collections-card">
      <div>
        <div className="text-[13px] font-semibold text-t1">Collections</div>
        <p className="text-[12px] text-t3">
          The first project to write a vector collection owns it; other projects use it only when an admin of the owner shares it. A collection nobody has written yet is open to every project until someone writes it.
        </p>
      </div>

      {view.lost.length > 0 && (
        <div className="rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] text-t2" data-testid="collections-lost">
          <div className="font-semibold text-t1">Lost access in the upgrade</div>
          <ul className="mt-1 space-y-0.5">
            {view.lost.map((l) => (
              <li key={l.key}>
                “{l.name}” now belongs to {l.ownerName ?? l.ownerProjectId}. Ask an admin of that project to share it with this one.
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.collections.length === 0 ? (
        <p className="text-[12.5px] text-t3">No collections yet. A Vector Store node or a knowledge base that writes one makes this project its owner.</p>
      ) : (
        <ul className="divide-y divide-hair rounded-[10px] border border-hair">
          {view.collections.map((c) => (
            <li key={c.key} className="px-3 py-2.5" data-testid="collection-row">
              <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-start">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-t1">{c.name}</div>
                  <div className="text-[12px] text-t3">
                    {c.store}
                    {c.access !== 'owner' && ` · owned by ${c.ownerName ?? c.ownerProjectId}`}
                    {c.source === 'upgrade' && c.access === 'owner' && ' · given to this project in the upgrade'}
                  </div>
                </div>
                <Badge tone={c.access === 'owner' ? 'accent' : 'neutral'}>{c.access === 'owner' ? 'Owned' : c.access === 'write' ? 'Search and change' : 'Search'}</Badge>
                {view.canManage && c.access === 'owner' && (
                  <Button size="sm" variant="ghost" className={BTN} onClick={() => setOpen(open === c.key ? undefined : c.key)}>
                    {open === c.key ? 'Hide' : 'Share with…'}
                  </Button>
                )}
              </div>

              {c.access === 'owner' && (c.grants?.length ?? 0) > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5 max-md:flex-col">
                  {c.grants!.map((g) => (
                    <li key={g.projectId} className="flex items-center gap-1.5 rounded-full border border-hair px-2.5 py-1 text-[12px] text-t2 max-md:justify-between" data-testid="collection-grant">
                      <span>
                        {nameOf(g)} · {g.level === 'write' ? 'search and change' : 'search'}
                      </span>
                      {view.canManage && (
                        <button type="button" className="text-t3 hover:text-t1 max-md:min-h-11 max-md:px-2" aria-label={`Stop sharing with ${nameOf(g)}`} onClick={() => post(c.key, { revoke: g.projectId }, 'Stopped sharing')}>
                          Stop
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {c.access === 'owner' && (c.lostAccess?.length ?? 0) > 0 && (
                <div className="mt-2 rounded-[10px] border border-hair bg-wl px-3 py-2 text-[12px] text-t2" data-testid="collection-lost">
                  <div className="font-semibold text-t1">These projects lost access in the upgrade</div>
                  <p className="text-t3">They named this collection before it had an owner. They have no access until you grant it.</p>
                  <p className="text-t3" data-testid="collection-lost-note">
                    If you grant write: chunks they added with Upsert by Key before the upgrade are stored under their plain keys, and their upserts through the grant use project-scoped keys, so those won’t match. Clear the collection and insert again to avoid duplicates.
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {c.lostAccess!.map((l) => (
                      <li key={l.projectId} className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
                        <span className="flex-1">{nameOf(l)}</span>
                        {view.canManage && (
                          <>
                            <Button size="sm" variant="outline" className={BTN} onClick={() => post(c.key, { grant: { projectId: l.projectId, level: 'read' } }, `Gave ${nameOf(l)} read access`)}>
                              Grant read
                            </Button>
                            <Button size="sm" variant="outline" className={BTN} onClick={() => post(c.key, { grant: { projectId: l.projectId, level: 'write' } }, `Gave ${nameOf(l)} write access. Their earlier Upsert by Key chunks won’t match: clear the collection and insert again`)}>
                              Grant write
                            </Button>
                            <Button size="sm" variant="ghost" className={BTN} onClick={() => post(c.key, { revoke: l.projectId }, 'Dismissed')}>
                              Dismiss
                            </Button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {view.canManage && c.access === 'owner' && open === c.key && <ShareRow collection={c} base={base} onDone={reload} />}
            </li>
          ))}
        </ul>
      )}

      {view.notion && (
        <div className="flex items-start gap-2" data-testid="collections-notion">
          <Switch checked={view.notion.read} onChange={(on) => post(`brain:${view.notion!.collection.toLowerCase()}`, { notionRead: on }, on ? 'Flows can read the Notion knowledge' : 'Flows can no longer read the Notion knowledge')} disabled={!view.canManage} label="Let this project’s flows read its Notion knowledge" />
          <div>
            <div className="text-[13px] font-semibold text-t1">Let this project’s flows read its Notion knowledge</div>
            <p className="text-[12px] text-t3">Vector Store nodes in this project’s workflows can search the company’s Notion pages, as its agents already do. Read only; no other project can.</p>
          </div>
        </div>
      )}
      {!view.canManage && <p className="text-[12px] text-t3">The project’s admins change who uses a collection.</p>}
    </Card>
  );
}
