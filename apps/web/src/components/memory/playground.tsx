'use client';
/**
 * The memory search playground (docs/run-trace.md#memory-playground, C11): type a query, pick mode, limit, threshold and a
 * reranker, and see what a knowledge base, a team notebook or the brain's facts would answer, with the score before and after
 * rerank, what the threshold dropped and the time per stage. It changes nothing and asks only when the person presses Search
 * (no timer). A sheet: a bottom sheet on a phone, centred on a desktop. The body is `PlaygroundPanel`, so a page can host it.
 */
import { useEffect, useId, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { CredentialSummary } from '@/lib/shared/types';
import { PLAYGROUND_LIMITS, PLAYGROUND_THRESHOLD, type PlaygroundAnswer, type PlaygroundMode, type PlaygroundRerank, type PlaygroundSource } from '@/lib/shared/memory-playground';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Field } from '../ui/dialog';
import { Input, Select } from '../ui/inputs';
import { Segmented } from '../ui/segmented';
import { Sheet } from '../ui/sheet';

const MODE_LABEL: Record<PlaygroundMode, string> = { keyword: 'Keywords', meaning: 'Meaning', hybrid: 'Hybrid' };
const ALL_MODES: PlaygroundMode[] = ['hybrid', 'meaning', 'keyword'];
const score = (n: number) => n.toFixed(2);

/** The answer: each result with its scores, the dropped line, the stage times. */
export function PlaygroundResults({ answer }: { answer: PlaygroundAnswer }) {
  const { results, dropped, timings } = answer;
  return (
    <div className="flex flex-col gap-2" data-testid="playground-results">
      {answer.error && (
        <p role="alert" className="rounded-[12px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
          {answer.error}
        </p>
      )}
      {!answer.error && results.length === 0 && <p className="text-[13px] text-t3">Nothing matched.</p>}
      <ol className="flex flex-col gap-1.5">
        {results.map((r) => (
          <li key={r.id} className="min-w-0 rounded-lg border border-hair bg-sf px-2.5 py-1.5 text-[13px]">
            <p className="line-clamp-3 break-words text-t1 [overflow-wrap:anywhere]">{r.text}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-t3">
              <span>score {score(r.score)}</span>
              {r.rerankScore !== undefined && <span>after rerank {score(r.rerankScore)}</span>}
              {r.kind && <span>{r.kind}</span>}
              <span className="max-w-full truncate font-mono">{r.sourceId}</span>
            </div>
          </li>
        ))}
      </ol>
      {dropped.count > 0 && (
        <p className="text-[12px] text-t3" data-testid="playground-dropped">
          {dropped.count} dropped below the threshold{dropped.best !== undefined ? ` (best ${score(dropped.best)})` : ''}
        </p>
      )}
      {!answer.error && (
        <p className="text-[11px] text-t3">
          Matched by {answer.via === 'meaning' ? 'meaning' : 'words'} · search {timings.searchMs} ms
          {timings.embedMs !== undefined ? ` (embedding ${timings.embedMs} ms)` : ''}
          {timings.rerankMs !== undefined ? ` · rerank ${timings.rerankMs} ms` : ''}
        </p>
      )}
    </div>
  );
}

export interface PlaygroundPanelProps {
  source: PlaygroundSource;
  /** The modes this source supports (a knowledge base with no embeddings model: keywords only). Default all three. */
  modes?: PlaygroundMode[];
  /** Start here (a knowledge base: 0; notes and facts: 0.3). */
  threshold?: number;
  /** An answer to show at first (a test). */
  initialAnswer?: PlaygroundAnswer;
}

export function PlaygroundPanel({ source, modes = ALL_MODES, threshold: startThreshold, initialAnswer }: PlaygroundPanelProps) {
  const id = useId();
  const supported = ALL_MODES.filter((m) => modes.includes(m));
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<PlaygroundMode>(supported[0] ?? 'keyword');
  const [limit, setLimit] = useState<number>(PLAYGROUND_LIMITS.limit.default);
  const [threshold, setThreshold] = useState(startThreshold ?? (source.kind === 'kb' ? 0 : PLAYGROUND_THRESHOLD));
  const [rerank, setRerank] = useState<'off' | 'llm' | string>('off');
  const [model, setModel] = useState('qwen3:8b');
  const [coheres, setCoheres] = useState<CredentialSummary[]>([]);
  const [answer, setAnswer] = useState<PlaygroundAnswer | undefined>(initialAnswer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api<{ credentials: CredentialSummary[] }>('/api/credentials', { background: true })
      .then((r) => live && setCoheres(r.credentials.filter((c) => c.type === 'cohereApi' || c.type.endsWith('.cohereApi'))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const search = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    const chosen: PlaygroundRerank | undefined = rerank === 'off' ? undefined : rerank === 'llm' ? { kind: 'llm', model: model.trim() } : { kind: 'cohere', credentialId: rerank };
    try {
      setAnswer(await api<PlaygroundAnswer>('/api/memory/search', { method: 'POST', json: { source, query: query.trim(), mode, limit, threshold, ...(chosen && { rerank: chosen }) } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void search();
      }}
    >
      <Field id={`${id}-q`} label="Query">
        <Input id={`${id}-q`} value={query} maxLength={PLAYGROUND_LIMITS.query} onChange={(e) => setQuery(e.target.value)} placeholder="What would an agent ask?" autoFocus />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        {supported.length > 1 ? (
          <Segmented label="Mode" size="sm" value={mode} onChange={setMode} options={supported.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        ) : (
          <Badge tone="muted">{MODE_LABEL[supported[0] ?? 'keyword']} only</Badge>
        )}
        <Field id={`${id}-limit`} label="Limit" className="w-20">
          <Input id={`${id}-limit`} type="number" min={PLAYGROUND_LIMITS.limit.min} max={PLAYGROUND_LIMITS.limit.max} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(50, Math.floor(Number(e.target.value)) || 10)))} />
        </Field>
        <Field id={`${id}-threshold`} label="Threshold" className="w-24">
          <Input id={`${id}-threshold`} type="number" min={0} max={1} step={0.05} value={threshold} onChange={(e) => setThreshold(Math.max(0, Math.min(1, Number(e.target.value) || 0)))} />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field id={`${id}-rerank`} label="Rerank" className="min-w-[180px] flex-1">
          <Select id={`${id}-rerank`} value={rerank} onChange={(e) => setRerank(e.target.value)}>
            <option value="off">Off</option>
            <option value="llm">A local chat model scores each passage</option>
            {coheres.map((c) => (
              <option key={c.id} value={c.id}>
                Cohere: {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {rerank === 'llm' && (
          <Field id={`${id}-model`} label="Ollama model" className="min-w-[140px] flex-1">
            <Input id={`${id}-model`} value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!query.trim()}>
          <Search className="size-3.5" /> Search
        </Button>
        <span className="text-[11px] text-t3">Changes nothing: no note is kept alive, no usage is recorded.</span>
      </div>
      {error && (
        <p role="alert" className="rounded-[12px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
          {error}
        </p>
      )}
      {answer && <PlaygroundResults answer={answer} />}
    </form>
  );
}

/** The sheet around the panel. */
export function MemoryPlayground({ source, title, modes, threshold, onClose }: PlaygroundPanelProps & { title: string; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} title={title} className="md:max-w-[560px]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <PlaygroundPanel source={source} modes={modes} threshold={threshold} />
      </div>
    </Sheet>
  );
}

/** A button that opens the playground for `source` (one mount per place: a knowledge base, the notebook, the brain). */
export function PlaygroundButton({ source, title, modes, threshold, label = 'Try a search' }: PlaygroundPanelProps & { title: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Search className="size-3.5" /> {label}
      </Button>
      {open && <MemoryPlayground source={source} title={title} modes={modes} threshold={threshold} onClose={() => setOpen(false)} />}
    </>
  );
}
