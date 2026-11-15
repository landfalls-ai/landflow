'use client';
/**
 * The Workspace card of a project's Settings tab (docs/projects-and-goals.md#workspace): the repositories a harness works in
 * (added and removed here, saved on the spot), and for each its default branch and setup commands, whether a run gets its own
 * worktree or all share one checkout, and the branch name template with a live example. Admins edit; everyone else reads
 * (viewers see no setup commands). Landflow never runs a setup command.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { PROJECT_REPO, PROJECT_REPOS_MAX } from '@/lib/shared/project-context-api';
import {
  BRANCH_TEMPLATE_MAX,
  DEFAULT_WORKSPACE,
  SETUP_LINES_MAX,
  SETUP_LINE_MAX,
  branchFor,
  templateProblem,
  workspaceSlug,
  type ProjectWorkspace,
  type ProjectWorkspaceView,
} from '@/lib/shared/project-workspace';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, Textarea } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';

/** What the form holds for one repository: text as typed. */
export interface RepoDraft {
  defaultBranch: string;
  setup: string;
}
export interface WorkspaceDraft {
  repos: Record<string, RepoDraft>;
  worktree: ProjectWorkspace['worktree'];
  branchTemplate: string;
}

export function draftFrom(view: ProjectWorkspaceView, keep?: WorkspaceDraft): WorkspaceDraft {
  return {
    worktree: keep?.worktree ?? view.workspace.worktree,
    branchTemplate: keep?.branchTemplate ?? view.workspace.branchTemplate,
    repos: Object.fromEntries(
      view.repos.map((name) => {
        const saved = view.workspace.repos[name];
        return [name, keep?.repos[name] ?? { defaultBranch: saved?.defaultBranch ?? '', setup: (saved?.setup ?? []).join('\n') }];
      }),
    ),
  };
}

/** The body PUT sends: a repository with nothing set is left out. */
export function workspaceFrom(draft: WorkspaceDraft): ProjectWorkspace {
  const repos: ProjectWorkspace['repos'] = {};
  for (const [name, d] of Object.entries(draft.repos)) {
    const setup = d.setup.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const defaultBranch = d.defaultBranch.trim();
    if (defaultBranch || setup.length) repos[name] = { ...(defaultBranch ? { defaultBranch } : {}), ...(setup.length ? { setup } : {}) };
  }
  return { repos, worktree: draft.worktree, branchTemplate: draft.branchTemplate.trim() };
}

/** The branch the template gives with example values. */
export const exampleBranch = (template: string, projectName: string, today = new Date()) =>
  branchFor(template, { project: workspaceSlug(projectName), run: 'r1a2b3', date: today.toISOString().slice(0, 10), task: 't42' });

export function ProjectWorkspaceBody({
  view,
  draft,
  projectName,
  newRepo = '',
  busy,
  onDraft,
  onNewRepo,
  onAddRepo,
  onRemoveRepo,
  onSave,
}: {
  view: ProjectWorkspaceView;
  draft: WorkspaceDraft;
  projectName: string;
  newRepo?: string;
  busy?: boolean;
  onDraft?: (next: WorkspaceDraft) => void;
  onNewRepo?: (value: string) => void;
  onAddRepo?: () => void;
  onRemoveRepo?: (name: string) => void;
  onSave?: () => void;
}) {
  const edit = view.canEdit;
  const problem = templateProblem(draft.branchTemplate);
  const repoName = newRepo.trim().toLowerCase();
  const repoProblem = repoName && !PROJECT_REPO.test(repoName) ? 'Use owner/name' : repoName && view.repos.includes(repoName) ? 'Already listed' : undefined;
  const setRepo = (name: string, patch: Partial<RepoDraft>) => onDraft?.({ ...draft, repos: { ...draft.repos, [name]: { ...draft.repos[name]!, ...patch } } });
  return (
    <div className="space-y-4">
      <div>
        <FieldLabel>Repositories</FieldLabel>
        {view.repos.length === 0 && <p className="text-[13px] text-t2">Add a repository a harness works in</p>}
        <ul className="space-y-3">
          {view.repos.map((name) => {
            const d = draft.repos[name] ?? { defaultBranch: '', setup: '' };
            return (
              <li key={name} className="rounded-xl border border-hair p-3" data-repo={name}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-t1">{name}</span>
                  {edit && (
                    <Button variant="ghost" size="sm" aria-label={`Remove ${name}`} onClick={() => onRemoveRepo?.(name)} disabled={busy} className="max-md:min-h-11 max-md:min-w-11">
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="mt-2 space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-t2">Default branch</span>
                    <Input value={d.defaultBranch} readOnly={!edit} onChange={(e) => setRepo(name, { defaultBranch: e.target.value })} placeholder="the repository's default" className="font-mono max-md:h-11" aria-label={`Default branch of ${name}`} />
                  </label>
                  {view.setupShown ? (
                    <label className="block">
                      <span className="mb-1 block text-[12px] text-t2">Setup commands, one per line</span>
                      <Textarea value={d.setup} readOnly={!edit} onChange={(e) => setRepo(name, { setup: e.target.value })} rows={3} placeholder={edit ? 'pnpm install' : undefined} className="font-mono" aria-label={`Setup commands of ${name}`} />
                      <span className="mt-1 block text-[12px] text-t3">
                        At most {SETUP_LINES_MAX} lines of {SETUP_LINE_MAX} characters. Landflow never runs these. A harness may, in its own sandbox.
                      </span>
                    </label>
                  ) : (
                    <p className="text-[12px] text-t3">Setup commands are shown to the project’s editors and admins.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {edit && (
          <div className="mt-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!repoProblem && repoName) onAddRepo?.();
              }}
            >
              <Input value={newRepo} onChange={(e) => onNewRepo?.(e.target.value)} placeholder="owner/name" className="font-mono max-md:h-11" aria-label="Add a repository" disabled={view.repos.length >= PROJECT_REPOS_MAX} />
              <Button type="submit" variant="outline" size="sm" disabled={busy || !repoName || Boolean(repoProblem) || view.repos.length >= PROJECT_REPOS_MAX} className="max-md:min-h-11">
                <Plus className="size-4" /> Add
              </Button>
            </form>
            {repoProblem && <p className="mt-1 text-[12px] text-rd">{repoProblem}</p>}
            {view.repos.length >= PROJECT_REPOS_MAX && <p className="mt-1 text-[12px] text-t3">At most {PROJECT_REPOS_MAX} repositories</p>}
          </div>
        )}
      </div>

      <div>
        <FieldLabel>Worktree</FieldLabel>
        {edit ? (
          <Segmented label="Worktree" value={draft.worktree} onChange={(worktree) => onDraft?.({ ...draft, worktree })} options={[{ value: 'per-run', label: 'One per run' }, { value: 'shared', label: 'Shared' }]} />
        ) : (
          <p className="text-[13px] text-t1">{draft.worktree === 'shared' ? 'Shared: runs use one checkout' : 'One per run'}</p>
        )}
      </div>

      <div>
        <label>
          <FieldLabel>Branch template</FieldLabel>
          <Input value={draft.branchTemplate} readOnly={!edit} maxLength={BRANCH_TEMPLATE_MAX} onChange={(e) => onDraft?.({ ...draft, branchTemplate: e.target.value })} placeholder={DEFAULT_WORKSPACE.branchTemplate} className="font-mono max-md:h-11" aria-label="Branch template" aria-invalid={Boolean(problem)} />
        </label>
        {problem ? (
          <p className="mt-1 text-[12px] text-rd">{problem}</p>
        ) : (
          <p className="mt-1 break-all text-[12px] text-t2">
            Example: <span className="font-mono text-t1">{exampleBranch(draft.branchTemplate, projectName)}</span>
          </p>
        )}
        <p className="mt-1 text-[12px] text-t3">Tokens: {'{project}'}, {'{run}'}, {'{date}'}, {'{task}'}</p>
      </div>

      {edit && (
        <div className="flex justify-end">
          <Button size="sm" onClick={onSave} disabled={busy || Boolean(problem)} className="max-md:min-h-11">
            Save workspace
          </Button>
        </div>
      )}
    </div>
  );
}

export function ProjectWorkspaceCard({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectWorkspaceView>();
  const [projectName, setProjectName] = useState('');
  const [draft, setDraft] = useState<WorkspaceDraft>();
  const [newRepo, setNewRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const base = `/api/projects/${encodeURIComponent(projectId)}`;

  const load = useCallback(
    async (keep?: WorkspaceDraft) => {
      try {
        const [next, project] = await Promise.all([api<ProjectWorkspaceView>(`${base}/workspace`), api<{ project: { name: string } }>(base)]);
        setProjectName(project.project.name);
        setView(next);
        setDraft(draftFrom(next, keep));
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [base],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const changeRepos = async (repos: string[]) => {
    setBusy(true);
    try {
      await api(base, { method: 'PATCH', json: { repos } });
      setNewRepo('');
      await load(draft);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const next = await api<ProjectWorkspaceView>(`${base}/workspace`, { method: 'PUT', json: workspaceFrom(draft) });
      setView(next);
      setDraft(draftFrom(next));
      toast.success('Workspace saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div id="workspace" className="mb-1 text-[13px] font-semibold text-t1">Workspace</div>
      <p className="mb-3 text-[12px] text-t2">How agents and harnesses work in this project’s repositories. A harness reads it with the project’s context.</p>
      {error && <p className="text-[13px] text-rd">{error}</p>}
      {!view || !draft ? (
        !error && <p className="text-[13px] text-t3">Loading…</p>
      ) : (
        <ProjectWorkspaceBody
          view={view}
          draft={draft}
          projectName={projectName}
          newRepo={newRepo}
          busy={busy}
          onDraft={setDraft}
          onNewRepo={setNewRepo}
          onAddRepo={() => void changeRepos([...view.repos, newRepo.trim().toLowerCase()])}
          onRemoveRepo={(name) => void changeRepos(view.repos.filter((r) => r !== name))}
          onSave={() => void save()}
        />
      )}
    </Card>
  );
}
