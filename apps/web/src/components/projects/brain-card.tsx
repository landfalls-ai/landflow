'use client';
/**
 * The project's Brain card (docs/features/notion-brain.md#setting-it-up, docs/projects-and-goals.md#the-brain-in-notion): where
 * the project's brain lives, Landflow or Notion. An admin picks a Notion key by name (or adds one in the credential dialog),
 * gives a page, checks it, sees what a copy would do, and connects; then the card shows the copy's progress, the status, and
 * Open in Notion, Sync now, Pause, the speed, the knowledge scope and Disconnect, one button for each stopped status, and the
 * link's problems. Members see the status line and the link. The words come from lib/client/notion-brain.ts, the same file the
 * Brain page's chip and Spotlight's card read. The card never holds, shows or logs a key: only a credential's id and name.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  NOTION_KEY_TYPE,
  PROBLEM_ACTION_LABELS,
  STATUS_FIX,
  actOnNotionProblem,
  actionsFor,
  changeNotionLink,
  checkNotionPage,
  connectNotion,
  copyLine,
  disconnectNotion,
  notionLink,
  notionProblems,
  preselectedKey,
  projectNotionKeys,
  statusSentence,
  statusTone,
  syncNotionNow,
  type NotionKey,
} from '@/lib/client/notion-brain';
import { NEVER_PUSHED, RPS_DEFAULT, RPS_MAX, type CheckResult, type KnowledgeScope, type LinkProblemView, type LinkStatusView, type LinkView, type ProblemAction } from '@/lib/shared/notion-brain';
import { cn } from '@/lib/utils';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';
import { CredentialDialog } from '@/components/credentials/credential-dialog';
import { useCredentialStore } from '@/components/credentials/use-credentials';

const BTN = 'max-md:min-h-11';
const TONE = { ok: 'text-t1', warning: 'text-warn', danger: 'text-rd', muted: 'text-t2' } as const;
const HELP = 'In Notion, a workspace owner makes a connection with Read, Update and Insert content, then shares one page with it (••• → Add connections).';

const errorOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** A radio row, 44 px on a phone. */
function Radio({ name, checked, onChange, children, disabled, testId }: { name: string; checked: boolean; onChange: () => void; children: React.ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-hair bg-bg px-2.5 py-1.5 text-[12.5px] text-t1 max-md:min-h-11 max-md:items-center has-[:checked]:border-ac has-[:checked]:bg-acbg">
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} data-testid={testId} className="mt-0.5 size-3.5 shrink-0 accent-[var(--ac)]" />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/**
 * The Notion keys this project may use, by name, and New Notion key. `onPick` gets a key's id (the only one that fits is
 * picked on its own, the credential auto-pick rule). The secret is typed in the credential dialog and goes nowhere else.
 */
function KeyField({ projectId, value, onPick, disabled }: { projectId: string; value: string; onPick: (id: string) => void; disabled?: boolean }) {
  const [keys, setKeys] = useState<NotionKey[]>();
  const [adding, setAdding] = useState(false);
  const types = useCredentialStore((s) => s.types);
  const pickedOnce = useRef(false);
  const id = useId();
  const published = types?.some((t) => t.type === NOTION_KEY_TYPE && t.available);
  const load = useCallback(() => projectNotionKeys(projectId).then(setKeys).catch(() => setKeys([])), [projectId]);
  useEffect(() => {
    void load();
    if (!useCredentialStore.getState().types) void useCredentialStore.getState().refresh();
  }, [load]);
  useEffect(() => {
    if (!keys || pickedOnce.current || value) return;
    const only = preselectedKey(keys);
    if (only) {
      pickedOnce.current = true;
      onPick(only.id);
    }
  }, [keys, value, onPick]);
  return (
    <div className="space-y-1.5" data-testid="notion-key-field">
      <label htmlFor={id} className="block text-[12px] font-semibold text-t2">
        Notion key
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {keys && keys.length > 0 ? (
          <div className="min-w-[200px] max-w-[360px] flex-1">
            <Select id={id} value={value} onChange={(e) => onPick(e.target.value)} disabled={disabled} aria-label="Notion key" className="max-md:h-11">
              <option value="">Choose a key…</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <span className="text-[12.5px] text-t3">{keys ? 'No Notion key yet' : 'Looking for your Notion keys…'}</span>
        )}
        <Button size="sm" variant="outline" className={BTN} onClick={() => setAdding(true)} disabled={disabled || !published}>
          <Plus className="size-3.5" aria-hidden />
          New Notion key
        </Button>
      </div>
      {types && !published && <p className="text-[12px] text-t3">Start the productivity plugin to add a Notion key</p>}
      <p className="text-[12px] text-t3">{HELP}</p>
      {adding && (
        <CredentialDialog
          projectId={projectId}
          allowedTypes={[NOTION_KEY_TYPE]}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            // Only the id and the name: the dialog's copy of the secret goes with the dialog.
            const picked = { id: saved.id, name: saved.name };
            setAdding(false);
            void useCredentialStore.getState().refresh();
            void load().then(() => onPick(picked.id));
          }}
        />
      )}
    </div>
  );
}

/** What a copy would do, with the scope choice. */
function CopyPlan({ check, scope, onScope, onConnect, connecting }: { check: CheckResult; scope: KnowledgeScope; onScope: (s: KnowledgeScope) => void; onConnect: () => void; connecting: boolean }) {
  const group = useId();
  const { counts } = check;
  const line = [`${counts.pages} page${counts.pages === 1 ? '' : 's'}`, `${counts.facts} fact${counts.facts === 1 ? '' : 's'}`, `${counts.practices} practice${counts.practices === 1 ? '' : 's'}`, `${counts.notes} note${counts.notes === 1 ? '' : 's'}`].join(', ');
  return (
    <div className="space-y-3 border-t border-hair pt-3" data-testid="notion-copy-plan">
      <div>
        <div className="text-[13px] font-semibold text-t1">What will be copied</div>
        <p className="text-[12.5px] text-t2">{line}. It takes about {check.estimateMinutes} minute{check.estimateMinutes === 1 ? '' : 's'}.</p>
        <p className="mt-1 text-[12px] text-t3">{NEVER_PUSHED}</p>
      </div>
      <div role="radiogroup" aria-label="Which Notion pages Landflow reads as knowledge" className="space-y-1.5">
        <div className="text-[12px] font-semibold text-t2">Knowledge from Notion</div>
        <Radio name={group} checked={scope === 'brain'} onChange={() => onScope('brain')} testId="scope-brain">
          Pages you add under Landflow brain
        </Radio>
        <Radio name={group} checked={scope === 'root'} onChange={() => onScope('root')} testId="scope-root">
          Every page under {check.title}
        </Radio>
      </div>
      <Button variant="primary" size="md" className={BTN} onClick={onConnect} loading={connecting}>
        Connect and copy
      </Button>
    </div>
  );
}

/** An admin with no link: the key, the page, Check, the plan. */
function Setup({ projectId, onLinked }: { projectId: string; onLinked: (view: LinkView) => void }) {
  const [credentialId, setCredentialId] = useState('');
  const [page, setPage] = useState('');
  const [check, setCheck] = useState<CheckResult>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [scope, setScope] = useState<KnowledgeScope>('brain');
  const pageId = useId();
  const reset = () => {
    setCheck(undefined);
    setError(undefined);
  };
  const run = async () => {
    setChecking(true);
    reset();
    try {
      setCheck(await checkNotionPage(projectId, { credentialId, page: page.trim() }));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setChecking(false);
    }
  };
  const connect = async () => {
    setConnecting(true);
    setError(undefined);
    try {
      onLinked(await connectNotion(projectId, { credentialId, page: page.trim(), knowledgeScope: scope }));
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setConnecting(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="notion-setup">
      <KeyField
        projectId={projectId}
        value={credentialId}
        onPick={(id) => {
          setCredentialId(id);
          reset();
        }}
      />
      <div className="space-y-1.5">
        <label htmlFor={pageId} className="block text-[12px] font-semibold text-t2">
          Notion page
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={pageId}
            value={page}
            onChange={(e) => {
              setPage(e.target.value);
              reset();
            }}
            placeholder="A link to the page, or its id"
            className="min-w-[200px] max-w-[520px] flex-1 max-md:h-11"
            aria-label="Notion page"
            autoComplete="off"
            spellCheck={false}
          />
          <Button size="md" variant="outline" className={BTN} onClick={() => void run()} loading={checking} disabled={!credentialId || !page.trim()}>
            Check
          </Button>
        </div>
        <p className="text-[12px] text-t3">Landflow adds one page under it, “Landflow brain”, and writes only there.</p>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-rd" data-testid="notion-check-error">
          {error}
        </p>
      )}
      {check && (
        <div className="space-y-1 rounded-lg border border-hair bg-bg px-3 py-2 text-[12.5px]" data-testid="notion-check-result">
          <div className="font-semibold text-t1">{check.title}</div>
          <div className="text-t2">
            {[check.workspaceName && `Workspace ${check.workspaceName}`, check.botName && `Connection ${check.botName}`].filter(Boolean).join(' · ') || 'Landflow can read this page'}
          </div>
          {check.existingBrain.found && <div className="text-t1">A Landflow brain is already here: it will be reused.</div>}
        </div>
      )}
      {check && <CopyPlan check={check} scope={scope} onScope={setScope} onConnect={() => void connect()} connecting={connecting} />}
    </div>
  );
}

/** A problem of the link, in Landflow's words, with the buttons the viewer may press. */
function ProblemRow({ problem, viewer, onAct, busy }: { problem: LinkProblemView; viewer: { canEdit: boolean; canManage: boolean }; onAct: (action: ProblemAction) => void; busy: boolean }) {
  const actions = actionsFor(problem, viewer);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-hair bg-bg px-2.5 py-2 text-[12.5px]" data-testid="notion-problem">
      <span className="min-w-0 flex-1 basis-[220px] text-t1">{problem.detail}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        {problem.notionUrl && (
          <a href={problem.notionUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-ac hover:underline max-md:min-h-11 max-md:items-center">
            Open in Notion <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
        {actions.map((action) => (
          <Button key={action} size="sm" variant="outline" className={BTN} onClick={() => onAct(action)} disabled={busy}>
            {PROBLEM_ACTION_LABELS[action]}
          </Button>
        ))}
      </span>
    </li>
  );
}

/** The link's own card: status, copy progress, buttons, a stopped link's fix and the problems. */
function Linked({ projectId, view, problems, canEdit, reload, onGone }: { projectId: string; view: LinkView; problems: LinkProblemView[]; canEdit: boolean; reload: () => Promise<void>; onGone: () => void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [key, setKey] = useState('');
  const scopeGroup = useId();
  const manage = view.canManage;
  const tone = statusTone(view);
  const copy = copyLine(view.copy);
  const fix = STATUS_FIX[view.status];
  const open = view.brainUrl ?? view.rootUrl;
  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    setError(undefined);
    try {
      await fn();
      if (done) toast.success(done);
      await reload();
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const speeds = [...new Set([RPS_DEFAULT, RPS_MAX, view.rps])].sort((a, b) => a - b);
  const fixAction = fix?.action;
  const pressFix = () => {
    if (fixAction === 'pickKey') setPicking(true);
    else if (fixAction === 'checkAgain') void run('fix', () => changeNotionLink(projectId, { paused: false }));
    else if (fixAction === 'resume') void run('fix', () => changeNotionLink(projectId, { paused: false }));
    else if (fixAction === 'repair') {
      const target = problems.find((p) => p.kind === 'schema_changed');
      if (target) void run('fix', () => actOnNotionProblem(projectId, target.id, 'repair'));
      else setError('Landflow has not found what to repair yet: Sync now, then try again.');
    }
  };
  return (
    <div className="space-y-3" data-testid="notion-linked">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className={cn('min-w-0 flex-1 basis-[240px] text-[13px] font-medium', TONE[tone])} data-testid="notion-status">
          {statusSentence(view)}
        </p>
        {open && (
          <a href={open} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ac hover:underline max-md:min-h-11 max-md:items-center">
            Open in Notion <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </div>
      {copy && (
        <div className="space-y-1" data-testid="notion-progress">
          <div className="h-2 overflow-hidden rounded-full bg-acdim" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(copy.fraction * 100)} aria-label="Copy progress">
            <div className="h-full rounded-full bg-ac2 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.round(copy.fraction * 100)}%` }} />
          </div>
          <p className="text-[12px] text-t3">You can leave this page: the copy goes on.</p>
        </div>
      )}
      {(view.rootTitle || view.workspaceName) && !manage && (
        <p className="text-[12px] text-t3">{[view.rootTitle && `Under “${view.rootTitle}”`, view.workspaceName && `Workspace ${view.workspaceName}`].filter(Boolean).join(' · ')}</p>
      )}

      {manage && fix && (
        <div className="space-y-2 rounded-lg border border-hair bg-bg px-3 py-2" data-testid="notion-fix">
          <p className="text-[12.5px] text-t1">{fix.sentence}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" className={BTN} onClick={pressFix} loading={busy === 'fix'}>
              {fix.button}
            </Button>
            {view.status === 'unauthorized' && (
              <Button size="sm" variant="outline" className={BTN} onClick={() => void run('fix', () => changeNotionLink(projectId, { paused: false }))} disabled={busy === 'fix'}>
                Check again
              </Button>
            )}
          </div>
          {picking && (
            <div className="space-y-2 border-t border-hair pt-2" data-testid="notion-pick-key">
              <KeyField projectId={projectId} value={key} onPick={setKey} disabled={busy === 'fix'} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  className={BTN}
                  disabled={!key || key === view.credential.id}
                  loading={busy === 'key'}
                  onClick={() =>
                    void run('key', async () => {
                      await changeNotionLink(projectId, { credentialId: key });
                      setPicking(false);
                    })
                  }
                >
                  Use this key
                </Button>
                <Button size="sm" variant="ghost" className={BTN} onClick={() => setPicking(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {manage && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className={BTN} onClick={() => void run('sync', () => syncNotionNow(projectId), 'Syncing now')} loading={busy === 'sync'} disabled={view.status === 'unlinked'}>
              Sync now
            </Button>
            {view.status !== 'paused' && (
              <Button size="sm" variant="outline" className={BTN} onClick={() => void run('pause', () => changeNotionLink(projectId, { paused: true }))} loading={busy === 'pause'}>
                Pause
              </Button>
            )}
            <Button size="sm" variant="danger" className={BTN} onClick={() => setConfirming(true)} disabled={confirming}>
              Disconnect
            </Button>
          </div>
          {confirming && (
            <div role="alertdialog" aria-label="Disconnect from Notion" className="space-y-2 rounded-lg border border-rdbd bg-rddim px-3 py-2" data-testid="notion-disconnect-confirm">
              <p className="text-[12.5px] text-t1">Landflow stops syncing. Your Notion pages stay as they are, and the brain stays in Landflow.</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  className={BTN}
                  loading={busy === 'disconnect'}
                  onClick={() =>
                    void run('disconnect', async () => {
                      await disconnectNotion(projectId);
                      setConfirming(false);
                      onGone();
                    })
                  }
                >
                  Disconnect
                </Button>
                <Button size="sm" variant="ghost" className={BTN} onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-[5px] text-[12px] font-semibold text-t2">Speed</div>
              <div className="max-w-[260px]">
                <Select value={String(view.rps)} onChange={(e) => void run('rps', () => changeNotionLink(projectId, { rps: Number(e.target.value) }))} disabled={busy === 'rps'} aria-label="Requests a second" className="max-md:h-11">
                  {speeds.map((n) => (
                    <option key={n} value={n}>
                      {n} requests a second
                    </option>
                  ))}
                </Select>
              </div>
              <p className="mt-1 text-[12px] text-t3">8 if your Notion is on Business or Enterprise.</p>
            </div>
            <div role="radiogroup" aria-label="Which Notion pages Landflow reads as knowledge" className="space-y-1.5">
              <div className="text-[12px] font-semibold text-t2">Knowledge from Notion</div>
              {(['brain', 'root'] as const).map((scope) => (
                <Radio key={scope} name={scopeGroup} checked={view.knowledgeScope === scope} onChange={() => void run('scope', () => changeNotionLink(projectId, { knowledgeScope: scope }))} disabled={busy === 'scope'}>
                  {scope === 'brain' ? 'Pages you add under Landflow brain' : `Every page under ${view.rootTitle ?? 'the page'}`}
                </Radio>
              ))}
            </div>
          </div>
        </div>
      )}

      {problems.length > 0 && (
        <div className="space-y-1.5" data-testid="notion-problems">
          <div className="text-[12px] font-semibold text-t2">Needs a look</div>
          <ul className="space-y-1.5">
            {problems.map((p) => (
              <ProblemRow
                key={p.id}
                problem={p}
                viewer={{ canEdit, canManage: manage }}
                busy={busy === p.id}
                onAct={(action) => void run(p.id, () => actOnNotionProblem(projectId, p.id, action))}
              />
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12.5px] text-rd" data-testid="notion-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Where this project's brain lives. `canEdit`: the viewer may edit the project's items (they act on a problem; the route checks
 * again). Whether they manage the link comes from the link's own view.
 */
export function BrainCard({ projectId, canEdit = false }: { projectId: string; canEdit?: boolean }) {
  const [view, setView] = useState<LinkStatusView>();
  const [problems, setProblems] = useState<LinkProblemView[]>([]);
  const [failed, setFailed] = useState<string>();
  const [where, setWhere] = useState<'landflow' | 'notion'>('landflow');
  const load = useCallback(
    async (background = false) => {
      try {
        const next = await notionLink(projectId, background);
        setView(next);
        setFailed(undefined);
        setProblems(next.linked ? await notionProblems(projectId, background).catch(() => []) : []);
      } catch (e) {
        if (!background) setFailed(errorOf(e));
      }
    },
    [projectId],
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  // A copy is looked at every 3 s, anything else every 30 s, and nothing while the tab is hidden.
  const status = view?.linked ? view.status : undefined;
  const known = view !== undefined;
  useEffect(() => {
    if (!known) return;
    const every = status === 'setting_up' || status === 'copying' ? 3_000 : 30_000;
    const tick = () => {
      if (!document.hidden) void load(true);
    };
    const timer = setInterval(tick, every);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [known, status, load]);

  const manage = view?.canManage ?? false;
  return (
    <div id="brain" className="scroll-mt-[72px] max-md:scroll-mt-[200px]" data-testid="brain-card">
    <Card className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold text-t1">Brain</div>
        <p className="text-[12px] text-t3">Where this project’s brain lives.</p>
      </div>
      {!view ? (
        failed ? (
          <p className="text-[12.5px] text-rd">{failed}</p>
        ) : (
          <div className="h-10 animate-pulse-soft rounded-lg bg-acdim motion-reduce:animate-none" />
        )
      ) : view.linked ? (
        <Linked projectId={projectId} view={view} problems={problems} canEdit={canEdit} reload={() => load(true)} onGone={() => (setWhere('landflow'), setView({ linked: false, canManage: view.canManage }), setProblems([]))} />
      ) : manage ? (
        <div className="space-y-3">
          <Segmented<'landflow' | 'notion'>
            label="Where the brain lives"
            value={where}
            onChange={setWhere}
            options={[
              { value: 'landflow', label: 'Landflow' },
              { value: 'notion', label: 'Notion' },
            ]}
          />
          {where === 'landflow' ? (
            <p className="text-[12.5px] text-t2" data-testid="notion-status">
              {statusSentence(view)}. Choose Notion to copy it to a Notion page and keep the two in sync.
            </p>
          ) : (
            <Setup projectId={projectId} onLinked={(linked) => (setView(linked), void load(true))} />
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-t2" data-testid="notion-status">
          {statusSentence(view)}
        </p>
      )}
    </Card>
    </div>
  );
}
