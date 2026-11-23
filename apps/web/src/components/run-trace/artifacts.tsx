'use client';
/**
 * The Artifacts tab: what a run made. Code changes first when agents changed files (one card per file, one line per agent
 * saying whether it reached the branch, tap for the diff — what the agents did, or the branch as GitHub sees it once
 * `GET /api/executions/:id/changes` answers), then documents (formatted), images, tables (CSV as cards), pages (HTML in a
 * sandboxed frame), PDFs, links (pull requests, commits) and data. Lines of a diff take comments, which the gate's Send back
 * carries. Phone first: one column, cards, and a diff scrolls sideways inside its own box.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ExternalLink, FileImage, FileText, Globe, MessageSquare, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { artifactShape, isCsvPath, isHtmlPath, safeUrl, type ArtifactShape } from '@/lib/shared/artifact-kinds';
import { lineCommentsNote } from '@/lib/shared/line-comments';
import { isReviewComment } from '@/lib/shared/review-comments';
import {
  compareWithBranch,
  diffHunks,
  isMarkdownPath,
  parsePatchHunks,
  type ActorChanges,
  type BranchChanges,
  type BranchFile,
  type BranchReply,
  type BranchState,
  type FileChanges,
  type RunChanges,
} from '@/lib/shared/run-changes';
import type { RunGitHub } from '@/lib/shared/run-repo';
import { cut, type RunArtifactItem, type RunModel } from '@/lib/shared/run-trace-model';
import { Badge } from '../ui/badge';
import { EmptyState } from '../ui/empty-state';
import { JsonView } from '../ui/json-view';
import { ArtifactPreview } from './artifact-preview';
import { ChangeDiff, DiffView } from './diff-view';
import { useLineComments } from './line-comments';
import { Card, SectionTitle, Tap, clock } from './parts';
import { Doc } from './rich-text';
import { ReviewCommentArtifact } from './review-comment-card';
import type { Open } from './sheet';

type BranchFetch = { status: 'idle' | 'loading' } | { status: 'done'; reply: BranchReply };
/** A file against the branch: where GitHub has it, and the comparison it came from. */
type FileBranch = { state: BranchState; data: BranchChanges };

/** The branch as GitHub sees it, asked for once the tab has files or a branch to compare (and again when the run finishes). */
function useBranch(executionId: string, enabled: boolean, live: boolean): BranchFetch {
  const [state, setState] = useState<BranchFetch>({ status: 'idle' });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState((s) => (s.status === 'done' ? s : { status: 'loading' }));
    api<BranchReply>(`/api/executions/${executionId}/changes`)
      .then((reply) => current && setState({ status: 'done', reply }))
      .catch((e: Error) => current && setState({ status: 'done', reply: { available: false, reason: e.message } }));
    return () => {
      current = false;
    };
  }, [executionId, enabled, live]);
  return state;
}

// ---------------------------------------------------------------------------
// Code changes
// ---------------------------------------------------------------------------

const DOT = { ok: 'bg-gn', warn: 'bg-warn', bad: 'bg-rd' } as const;

/** "Planner wrote it", "Reviewer edited it twice": what one agent did to a file. */
function verb(a: ActorChanges): string {
  const times = (n: number) => (n === 2 ? 'twice' : `${n} times`);
  if (a.writes && a.edits) return 'wrote it, then edited it';
  if (a.writes) return a.writes === 1 ? 'wrote it' : `wrote it ${times(a.writes)}`;
  return a.edits === 1 ? 'edited it' : `edited it ${times(a.edits)}`;
}

function Delivery({ a, repo }: { a: ActorChanges; repo?: RunGitHub }) {
  // (Only called for runs that used git.)
  if (!a.notPushed) {
    return (
      <>
        pushed
        {a.commit && (
          <>
            {' '}
            in{' '}
            {repo ? (
              <a href={`${repo.url}/commit/${a.commit}`} target="_blank" rel="noopener noreferrer" className="font-mono text-ac underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
                {a.commit}
              </a>
            ) : (
              <span className="font-mono">{a.commit}</span>
            )}
          </>
        )}
      </>
    );
  }
  return <>{a.pushed ? `${a.pushed} of ${a.pushed + a.notPushed} pushed` : 'never pushed'}</>;
}

const toneOf = (a: ActorChanges) => (!a.notPushed ? 'ok' : a.pushed ? 'warn' : 'bad');

function Counts({ file }: { file: Pick<FileChanges, 'additions' | 'deletions' | 'created' | 'partial'> }) {
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-[12px] font-medium">
      <span className="text-gn">+{file.additions}</span> <span className="text-rd">−{file.deletions}</span>
    </span>
  );
}

type Source = 'agents' | 'branch';

function FileDiff({ file, branch, open, repo, git }: { file: FileChanges; branch?: FileBranch; open: (o: Open) => void; repo?: RunGitHub; git: boolean }) {
  const [source, setSource] = useState<Source>('agents');
  const [focus, setFocus] = useState<string>();
  const combined = useMemo(() => (file.partial || focus ? undefined : diffHunks(file.before ?? '', file.after ?? '')), [file, focus]);
  const picked = file.changes.filter((c) => !focus || c.actor.id === focus);
  const onBranch = branch?.state.file;
  const choices: Array<[Source, string]> = [['agents', 'What the agents did'], ...(branch ? ([['branch', 'On the branch']] as Array<[Source, string]>) : [])];
  return (
    <div className="mt-2.5 flex min-w-0 flex-col gap-2.5 border-t border-hair pt-2.5">
      {branch && (
        <div role="tablist" aria-label="Which diff" className="grid grid-cols-2 gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
          {choices.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={source === id}
              onClick={() => setSource(id)}
              className={cn('h-8 rounded-full text-[12px] text-t2 hover:text-t1', source === id && 'bg-sf font-semibold text-t1 shadow-[0_0_0_1px_var(--hair)]')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {source === 'branch' && branch ? (
        onBranch ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-[12px] text-t2">
              GitHub shows this file as <b>{onBranch.status}</b>, <span className="text-gn">+{onBranch.additions}</span> <span className="text-rd">−{onBranch.deletions}</span>, between{' '}
              <span className="font-mono">{branch.data.base}</span> and <span className="font-mono">{branch.data.head}</span>.
            </p>
            {onBranch.patch ? (
              <DiffView hunks={parsePatchHunks(onBranch.patch)} path={file.path} label={`${file.path} on the branch`} />
            ) : (
              <p className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12px] text-t3">GitHub left out the patch for this file (it is large or binary).</p>
            )}
          </div>
        ) : (
          <p className="rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[12px] text-t1">
            This file is not on the branch: GitHub shows no change to it between <span className="font-mono">{branch.data.base}</span> and <span className="font-mono">{branch.data.head}</span>.
          </p>
        )
      ) : (
        <>
          {file.actors.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Whose changes">
              {[{ id: undefined, label: 'Combined' }, ...file.actors.map((a) => ({ id: a.actor.id, label: a.actor.name }))].map((c) => (
                <button
                  key={c.id ?? 'all'}
                  type="button"
                  aria-pressed={focus === c.id}
                  onClick={() => setFocus(c.id)}
                  className={cn('h-8 max-w-full truncate rounded-full border px-3 text-[12px]', focus === c.id ? 'border-acbd bg-acdim font-semibold text-ac' : 'border-hair text-t2 hover:text-t1')}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {combined ? (
            <DiffView hunks={combined} path={file.path} label={`${file.path}, all changes`} />
          ) : (
            picked.map((change, i) => (
              <section key={change.spanId + i} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-t2">
                  <b className="font-semibold text-t1">{change.actor.name}</b>
                  <span>{change.kind === 'write' ? 'wrote' : 'edited'}</span>
                  <button type="button" onClick={() => open({ kind: 'span', id: change.spanId })} className="font-mono text-ac underline decoration-dotted underline-offset-2">
                    {clock(change.at)}
                  </button>
                  <span className="font-mono">
                    <span className="text-gn">+{change.additions}</span> <span className="text-rd">−{change.deletions}</span>
                  </span>
                  {git && (
                    <Badge tone={change.pushed ? 'success' : 'warning'}>
                      {change.pushed ? 'pushed' : 'never pushed'}
                      {change.pushed && change.commit && repo ? ` in ${change.commit}` : ''}
                    </Badge>
                  )}
                </div>
                <ChangeDiff change={change} path={file.path} />
              </section>
            ))
          )}
          {file.partial && !focus && <p className="text-[12px] text-t3">The run did not show every file whole, so each change is compared on its own.</p>}
        </>
      )}
    </div>
  );
}

function FileCard({
  file,
  branch,
  open,
  repo,
  git,
}: {
  file: FileChanges;
  branch?: FileBranch;
  open: (o: Open) => void;
  repo?: RunGitHub;
  git: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <Card className="min-w-0 !p-0">
      <Tap onClick={() => setShown(!shown)} className="rounded-2xl px-3.5 py-3 hover:bg-acdim/40" label={`${file.path}: ${shown ? 'hide' : 'show'} the diff`}>
        <span className="flex items-start gap-2">
          <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-t3 transition-transform', shown && 'rotate-90')} aria-hidden />
          <span className="min-w-0 flex-1 break-all font-mono text-[13px] font-medium leading-snug text-t1">{file.path}</span>
          <Counts file={file} />
        </span>
        <span className="mt-2 flex flex-col gap-1 pl-[22px] text-[12px] text-t2">
          {file.actors.map((a) => (
            <span key={a.actor.id} className="flex items-start gap-1.5">
              <span className={cn('mt-[7px] size-[7px] shrink-0 rounded-full', git ? DOT[toneOf(a)] : 'bg-bd')} aria-hidden />
              <span className="min-w-0">
                <b className="font-semibold text-t1">{a.actor.name}</b> {verb(a)}
                {git && (
                  <>
                    {' '}
                    · <Delivery a={a} repo={repo} />
                  </>
                )}
              </span>
            </span>
          ))}
          {branch && (
            <span className="flex items-start gap-1.5">
              <span className={cn('mt-[7px] size-[7px] shrink-0 rounded-full', branch.state.onBranch ? 'bg-gn' : 'bg-warn')} aria-hidden />
              <span>{branch.state.onBranch ? 'On the branch' : 'Not on the branch'}</span>
            </span>
          )}
        </span>
      </Tap>
      {shown && (
        <div className="px-3.5 pb-3">
          <FileDiff file={file} branch={branch} open={open} repo={repo} git={git} />
        </div>
      )}
    </Card>
  );
}

/** A file on the branch that no step in the run's record changed (an earlier run on the branch, or a step the record cut): GitHub's patch. */
function BranchFileCard({ file, data }: { file: BranchFile; data: BranchChanges }) {
  const [shown, setShown] = useState(false);
  return (
    <Card className="min-w-0 !p-0">
      <Tap onClick={() => setShown(!shown)} className="rounded-2xl px-3.5 py-3 hover:bg-acdim/40" label={`${file.path}: ${shown ? 'hide' : 'show'} the diff`}>
        <span className="flex items-start gap-2">
          <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-t3 transition-transform', shown && 'rotate-90')} aria-hidden />
          <span className="min-w-0 flex-1 break-all font-mono text-[13px] font-medium leading-snug text-t1">{file.path}</span>
          <Counts file={{ ...file, created: file.status === 'added', partial: false }} />
        </span>
        <span className="mt-2 flex items-start gap-1.5 pl-[22px] text-[12px] text-t2">
          <span className="mt-[7px] size-[7px] shrink-0 rounded-full bg-bd" aria-hidden />
          <span>
            On the branch, {file.status} · not in the run’s record
          </span>
        </span>
      </Tap>
      {shown && (
        <div className="px-3.5 pb-3">
          <div className="mt-2.5 border-t border-hair pt-2.5">
            {file.patch ? (
              <DiffView hunks={parsePatchHunks(file.patch)} path={file.path} label={`${file.path} on the branch`} />
            ) : (
              <p className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12px] text-t3">
                GitHub left out the patch for this file (it is large or binary). It changed between <span className="font-mono">{data.base}</span> and <span className="font-mono">{data.head}</span>.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Your line comments on this run's diffs: how many, where they go, and Copy or Clear. Tap a line of a diff to add one. */
function CommentsSummary() {
  const store = useLineComments();
  if (!store) return null;
  const { comments } = store;
  if (!comments.length) return <p className="mb-2 px-0.5 text-[12px] text-t3">Tap a line of a diff to comment on it; Send back on the Run report takes your comments along.</p>;
  const files = new Set(comments.map((c) => c.path)).size;
  return (
    <Card className="mb-2 min-w-0 border-acbd bg-acdim/40">
      <p className="flex items-start gap-2 text-[13px] text-t1">
        <MessageSquare className="mt-[2px] size-4 shrink-0 text-ac" aria-hidden />
        <span>
          <b>
            {comments.length} line comment{comments.length === 1 ? '' : 's'}
          </b>{' '}
          on {files} file{files === 1 ? '' : 's'}. Send back on the Run report takes them along; they stay in this browser until then.
        </span>
      </p>
      <div className="mt-1 flex flex-wrap gap-4 pl-6">
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(lineCommentsNote(comments)).then(() => toast.success('Copied'), () => toast.error('Could not copy to the clipboard'))}
          className="min-h-8 text-[12px] text-ac underline underline-offset-2"
        >
          Copy them
        </button>
        <button type="button" onClick={store.clear} className="min-h-8 text-[12px] text-t2 underline underline-offset-2 hover:text-rd">
          Clear all
        </button>
      </div>
    </Card>
  );
}

function CodeChanges({
  changes,
  fetched,
  against,
  open,
  repo,
}: {
  changes: RunChanges;
  fetched: BranchFetch;
  against?: { reply: Extract<BranchReply, { available: true }>; compared: ReturnType<typeof compareWithBranch> };
  open: (o: Open) => void;
  repo?: RunGitHub;
}) {
  const reply = against?.reply;
  const others = against?.compared.others ?? [];
  return (
    <>
      <SectionTitle>Code changes · {changes.files.length + others.length}</SectionTitle>
      {reply && against && (
        <p className="mb-2 px-0.5 text-[12px] text-t2">
          <a href={reply.branch.url ?? `${reply.repository.url}/tree/${reply.branch.head}`} target="_blank" rel="noopener noreferrer" className="font-mono text-ac underline underline-offset-2">
            {reply.branch.head}
          </a>{' '}
          is {reply.branch.aheadBy} commit{reply.branch.aheadBy === 1 ? '' : 's'} ahead of <span className="font-mono">{reply.branch.base}</span>
          {reply.branch.behindBy ? ` and ${reply.branch.behindBy} behind` : ''}, as GitHub sees it.
          {others.length > 0 && changes.files.length > 0 && ` ${others.length} of its files no step in this run’s record changed: they come last.`}
          {reply.branch.truncated && ` ${reply.branch.note ?? 'GitHub lists at most 300 files.'}`}
        </p>
      )}
      {fetched.status === 'done' && !fetched.reply.available && (
        <p className="mb-2 px-0.5 text-[12px] text-t3">{fetched.reply.noGitHub ? 'Not checked against GitHub: this run has no GitHub step.' : `The branch on GitHub could not be read: ${fetched.reply.reason}`}</p>
      )}
      <CommentsSummary />
      <div className="flex flex-col gap-2">
        {changes.files.map((file) => (
          <FileCard key={file.path} file={file} open={open} repo={repo} git={changes.git} branch={reply && against ? { state: against.compared.byPath.get(file.path)!, data: reply.branch } : undefined} />
        ))}
        {reply && others.map((file) => <BranchFileCard key={file.path} file={file} data={reply.branch} />)}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Documents, links, data
// ---------------------------------------------------------------------------

interface DocumentItem {
  key: string;
  name: string;
  by?: string;
  at: string;
  text: string;
  open?: Open;
}

function Document({ item, open }: { item: DocumentItem; open: (o: Open) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <Card className="min-w-0 !p-0">
      <Tap onClick={() => setShown(!shown)} className="rounded-2xl px-3.5 py-3 hover:bg-acdim/40" label={`${item.name}: ${shown ? 'hide' : 'read'} it`}>
        <span className="flex items-start gap-2">
          <FileText className="mt-[2px] size-4 shrink-0 text-t3" aria-hidden />
          <span className="min-w-0 flex-1">
            <b className="block break-all text-[13px] font-semibold text-t1">{item.name}</b>
            <span className="block text-[12px] text-t3">
              {item.by ? `${item.by} · ` : ''}
              {clock(item.at)}
            </span>
            {!shown && <span className="mt-1 line-clamp-2 block text-[12px] text-t2">{cut(item.text.replace(/[#*`>|_-]+/g, ' '), 160)}</span>}
          </span>
          <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-t3 transition-transform', shown && 'rotate-90')} aria-hidden />
        </span>
      </Tap>
      {shown && (
        <div className="min-w-0 border-t border-hair px-3.5 py-3">
          <Doc text={item.text} />
          {item.open && (
            <button type="button" onClick={() => open(item.open!)} className="mt-2 min-h-8 text-[12px] text-ac underline underline-offset-2">
              Details
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

interface PreviewItem {
  key: string;
  name: string;
  shape: ArtifactShape;
  by?: string;
  at: string;
  url?: string;
  text?: string;
  open?: Open;
}

const PREVIEW_ICON = { image: FileImage, pdf: FileText, csv: Table2, html: Globe } as Partial<Record<ArtifactShape, typeof FileText>>;

/** An image, a PDF, a table or a page: tap to see it as what it is. */
function PreviewCard({ item, open }: { item: PreviewItem; open: (o: Open) => void }) {
  const [shown, setShown] = useState(false);
  const Icon = PREVIEW_ICON[item.shape] ?? FileText;
  return (
    <Card className="min-w-0 !p-0">
      <Tap onClick={() => setShown(!shown)} className="rounded-2xl px-3.5 py-3 hover:bg-acdim/40" label={`${item.name}: ${shown ? 'hide' : 'show'} it`}>
        <span className="flex items-start gap-2">
          <Icon className="mt-[2px] size-4 shrink-0 text-t3" aria-hidden />
          <span className="min-w-0 flex-1">
            <b className="block break-all text-[13px] font-semibold text-t1">{item.name}</b>
            <span className="block text-[12px] text-t3">
              {item.by ? `${item.by} · ` : ''}
              {clock(item.at)}
            </span>
          </span>
          <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-t3 transition-transform', shown && 'rotate-90')} aria-hidden />
        </span>
      </Tap>
      {shown && (
        <div className="min-w-0 border-t border-hair px-3.5 py-3">
          <ArtifactPreview shape={item.shape} name={item.name} url={item.url} text={item.text} />
          {item.open && (
            <button type="button" onClick={() => open(item.open!)} className="mt-1 min-h-8 text-[12px] text-ac underline underline-offset-2">
              Details
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/** The previewed shapes as groups: the shape, the group's title, one of them. */
const PREVIEW_GROUPS: Array<[ArtifactShape, string, string]> = [
  ['image', 'Images', 'image'],
  ['csv', 'Tables', 'table'],
  ['html', 'Pages', 'page'],
  ['pdf', 'PDFs', 'PDF'],
];

function LinkCard({ item }: { item: RunArtifactItem }) {
  const a = item.artifact;
  const url = safeUrl(a.url)!;
  return (
    <Card className="min-w-0 !p-0">
      <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 rounded-2xl px-3.5 py-3 hover:bg-acdim/40">
        <span className="min-w-0 flex-1">
          <b className="block break-words text-[13px] font-semibold text-t1">{a.name}</b>
          <span className="block break-all text-[12px] text-t3">
            {a.kind ? `${a.kind.replace(/_/g, ' ')} · ` : ''}
            {url.replace(/^https?:\/\//, '')}
          </span>
        </span>
        <ExternalLink className="mt-[3px] size-3.5 shrink-0 text-t3" aria-hidden />
      </a>
    </Card>
  );
}

function DataCard({ item }: { item: RunArtifactItem }) {
  const [shown, setShown] = useState(false);
  return (
    <Card className="min-w-0 !p-0">
      <Tap onClick={() => setShown(!shown)} className="rounded-2xl px-3.5 py-3 hover:bg-acdim/40" label={`${item.artifact.name}: ${shown ? 'hide' : 'show'} the data`}>
        <span className="flex items-start gap-2">
          <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-t3 transition-transform', shown && 'rotate-90')} aria-hidden />
          <span className="min-w-0 flex-1">
            <b className="block break-words text-[13px] font-semibold text-t1">{item.artifact.name}</b>
            <span className="block text-[12px] text-t3">
              {item.artifact.kind ?? 'data'} · {clock(item.at)}
            </span>
          </span>
        </span>
      </Tap>
      {shown && (
        <div className="max-h-[50dvh] overflow-auto border-t border-hair px-3.5 py-3 font-mono text-[12px]">
          <JsonView value={item.artifact.data} />
        </div>
      )}
    </Card>
  );
}

const hasData = (a: RunArtifactItem) => a.artifact.data !== undefined && a.artifact.data !== null && typeof a.artifact.data === 'object';

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <>
      <SectionTitle>
        {title} · {count}
      </SectionTitle>
      <div className="flex flex-col gap-2">{children}</div>
    </>
  );
}

export function Artifacts({
  executionId,
  model,
  changes,
  repo,
  open,
  replay,
}: {
  executionId: string;
  model: RunModel;
  changes: RunChanges;
  repo?: RunGitHub;
  open: (o: Open) => void;
  /** The slider is back in time: GitHub's branch is how it is now, so it is not asked for. */
  replay: boolean;
}) {
  const fetched = useBranch(executionId, (changes.files.length > 0 || !!repo?.branch) && !replay, model.live);
  const reply = !replay && fetched.status === 'done' && fetched.reply.available ? fetched.reply : undefined;
  const against = useMemo(() => (reply ? { reply, compared: compareWithBranch(changes, reply.branch) } : undefined), [changes, reply]);

  const shapes = useMemo(() => new Map(model.artifacts.map((a) => [a.id, artifactShape(a.artifact)])), [model.artifacts]);
  const documents = useMemo<DocumentItem[]>(() => {
    const made = model.artifacts
      .filter((a) => shapes.get(a.id) === 'markdown')
      .map((a) => ({ key: a.id, name: a.artifact.name, by: a.actor?.name, at: a.at, text: a.artifact.text!, open: { kind: 'artifact', id: a.id } as Open }));
    // Files agents wrote, whole: their last text.
    const written = changes.files
      .filter((f) => isMarkdownPath(f.path) && f.after !== undefined)
      .map((f) => ({ key: `file:${f.path}`, name: f.path, by: f.actors.map((a) => a.actor.name).join(', '), at: f.changes.at(-1)!.at, text: f.after!, open: { kind: 'span', id: f.changes.at(-1)!.spanId } as Open }));
    return [...made, ...written];
  }, [model.artifacts, changes.files, shapes]);
  const previews = useMemo<PreviewItem[]>(() => {
    const made = model.artifacts.flatMap((a): PreviewItem[] => {
      const shape = shapes.get(a.id)!;
      if (!PREVIEW_GROUPS.some(([s]) => s === shape)) return [];
      return [{ key: a.id, name: a.artifact.name, shape, by: a.actor?.name, at: a.at, url: safeUrl(a.artifact.url, shape), text: a.artifact.text, open: { kind: 'artifact', id: a.id } }];
    });
    // Tables and pages agents wrote as files: their last text.
    const written = changes.files.flatMap((f): PreviewItem[] => {
      const shape: ArtifactShape | undefined = f.after === undefined ? undefined : isCsvPath(f.path) ? 'csv' : isHtmlPath(f.path) ? 'html' : undefined;
      if (!shape) return [];
      const last = f.changes.at(-1)!;
      return [{ key: `file:${f.path}`, name: f.path, shape, by: f.actors.map((a) => a.actor.name).join(', '), at: last.at, text: f.after, open: { kind: 'span', id: last.spanId } }];
    });
    return [...made, ...written];
  }, [model.artifacts, changes.files, shapes]);
  // An image's or a PDF's link opens from its own card; only http(s) links are shown.
  // Reviews and comments left on GitHub have their own cards, so they are neither links nor data.
  const reviews = model.artifacts.filter((a) => isReviewComment(a.artifact));
  const plain = model.artifacts.filter((a) => !isReviewComment(a.artifact));
  const links = plain.filter((a) => safeUrl(a.artifact.url) && shapes.get(a.id) !== 'image' && shapes.get(a.id) !== 'pdf');
  const data = plain.filter(hasData);
  const byShape = (shape: ArtifactShape) => previews.filter((p) => p.shape === shape);

  if (!changes.files.length && !documents.length && !previews.length && !links.length && !data.length && !reviews.length) {
    return <EmptyState title="Nothing made yet" hint="Documents, files, links and data the run makes appear here." />;
  }
  const parts = [
    changes.files.length ? `${changes.files.length} file${changes.files.length === 1 ? '' : 's'}` : undefined,
    changes.agents.length ? `${changes.agents.length} agent${changes.agents.length === 1 ? '' : 's'}` : undefined,
    documents.length ? `${documents.length} document${documents.length === 1 ? '' : 's'}` : undefined,
    ...PREVIEW_GROUPS.map(([shape, , one]) => {
      const n = byShape(shape).length;
      return n ? `${n} ${one}${n === 1 ? '' : 's'}` : undefined;
    }),
    reviews.length ? `${reviews.length} review comment${reviews.length === 1 ? '' : 's'}` : undefined,
    links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : undefined,
    data.length ? `${data.length} data` : undefined,
  ].filter(Boolean);
  return (
    <div className="flex flex-col">
      <p className="px-0.5 text-[13px] text-t2">
        {parts.join(' · ')}
        {changes.git && changes.notPushed > 0 && (
          <b className="font-semibold text-rd">
            {' '}
            · {changes.notPushed} change{changes.notPushed === 1 ? '' : 's'} never pushed
          </b>
        )}
        {against && against.compared.missing.length > 0 && (
          <b className="font-semibold text-warn">
            {' '}
            · {against.compared.missing.length} file{against.compared.missing.length === 1 ? '' : 's'} not on the branch
          </b>
        )}
      </p>
      {(changes.files.length > 0 || (against?.compared.others.length ?? 0) > 0) && <CodeChanges changes={changes} fetched={replay ? { status: 'idle' } : fetched} against={against} open={open} repo={repo} />}
      {documents.length > 0 && (
        <Group title="Documents" count={documents.length}>
          {documents.map((d) => (
            <Document key={d.key} item={d} open={open} />
          ))}
        </Group>
      )}
      {PREVIEW_GROUPS.map(([shape, title]) => {
        const items = byShape(shape);
        return (
          items.length > 0 && (
            <Group key={shape} title={title} count={items.length}>
              {items.map((p) => (
                <PreviewCard key={p.key} item={p} open={open} />
              ))}
            </Group>
          )
        );
      })}
      {reviews.length > 0 && (
        <Group title="Review comments" count={reviews.length}>
          {reviews.map((a) => (
            <ReviewCommentArtifact key={a.id} item={a} open={open} />
          ))}
        </Group>
      )}
      {links.length > 0 && (
        <Group title="Links" count={links.length}>
          {links.map((a) => (
            <LinkCard key={a.id} item={a} />
          ))}
        </Group>
      )}
      {data.length > 0 && (
        <Group title="Data" count={data.length}>
          {data.map((a) => (
            <DataCard key={a.id} item={a} />
          ))}
        </Group>
      )}
    </div>
  );
}
