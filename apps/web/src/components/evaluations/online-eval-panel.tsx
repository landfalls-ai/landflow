'use client';
/**
 * Online grading of one agent (a standalone agent, or an AI Agent node of a workflow): the settings
 * (on/off, sample rate, rubric, judge model, low-score threshold), the totals, a 30-day trend of the
 * daily mean score and the latest scores, low ones flagged. Shared by the agent page's Evaluations tab
 * and a workflow's Evaluations tab.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight, ExternalLink, Flag, Gauge, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/client/format';
import type { AgentModel, ModelProvider } from '@/lib/shared/agents';
import type { OnlineEvalConfig, OnlineEvalReport, OnlineEvalScore, OnlineEvalTrendPoint } from '@/lib/shared/evaluations';
import { useCredentials } from '../credentials/use-credentials';
import { DEFAULT_OLLAMA_URL, PROVIDERS } from '../agents/util';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { FieldLabel, Input, Select, Switch, Textarea } from '../ui/inputs';

/** What PUT takes: `model: null` goes back to the agent's own model. */
export type OnlineEvalPatch = Partial<Omit<OnlineEvalConfig, 'model'>> & { model?: AgentModel | null };

/** Green at 4–5, red at or below the threshold, amber between. */
export function scoreTone(score: number, lowScore: number): Tone {
  if (score <= lowScore) return 'danger';
  return score >= 4 ? 'success' : 'warning';
}

const trim = (n: number, digits = 1) => n.toFixed(digits).replace(/\.0+$/, '');

function sameConfig(a: OnlineEvalConfig, b: OnlineEvalConfig) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The judge: "the agent's own model" or a provider, model id, credential and server. */
function JudgeModel({ model, onChange, fallbackLabel }: { model?: AgentModel; onChange: (model?: AgentModel) => void; fallbackLabel: string }) {
  const { credentials } = useCredentials();
  const provider = PROVIDERS.find((p) => p.value === model?.provider);
  const options = (credentials ?? []).filter((c) => c.type === provider?.credentialType);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div>
        <FieldLabel>Judge</FieldLabel>
        <Select
          value={model?.provider ?? ''}
          onChange={(e) => {
            const next = e.target.value as ModelProvider | '';
            if (!next) return onChange(undefined);
            onChange({ provider: next, model: next === model?.provider ? model.model : '', ...(next === 'ollama' && { baseUrl: DEFAULT_OLLAMA_URL }) });
          }}
        >
          <option value="">{fallbackLabel}</option>
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>
      {model && (
        <div>
          <FieldLabel>Model</FieldLabel>
          <Input
            value={model.model}
            onChange={(e) => onChange({ ...model, model: e.target.value })}
            placeholder={model.provider === 'anthropic' ? 'claude-sonnet-5-5' : model.provider === 'ollama' ? 'qwen3-coder:30b' : 'gpt-5-mini'}
            className="font-mono"
          />
        </div>
      )}
      {model && provider?.credentialType && (
        <div>
          <FieldLabel>Credential{provider.credentialRequired ? '' : ' (optional)'}</FieldLabel>
          <Select
            value={model.credential?.id ?? ''}
            onChange={(e) => {
              const credential = options.find((c) => c.id === e.target.value);
              const { credential: _old, ...rest } = model;
              onChange(credential ? { ...rest, credential: { id: credential.id, name: credential.name } } : rest);
            }}
          >
            <option value="">{provider.credentialRequired ? 'Choose a credential…' : 'Environment key'}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {model?.provider === 'ollama' && (
        <div>
          <FieldLabel>Server</FieldLabel>
          <Input value={model.baseUrl ?? ''} onChange={(e) => onChange({ ...model, baseUrl: e.target.value })} placeholder={DEFAULT_OLLAMA_URL} className="font-mono" />
        </div>
      )}
    </div>
  );
}

function Settings({ config, onSave, fallbackLabel }: { config: OnlineEvalConfig; onSave: (patch: OnlineEvalPatch) => Promise<unknown>; fallbackLabel: string }) {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(config), [config]);
  const dirty = !sameConfig(draft, config);
  const invalid = Boolean(draft.model && !draft.model.model.trim());

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ enabled: draft.enabled, sampleRate: draft.sampleRate, rubric: draft.rubric, lowScore: draft.lowScore, model: draft.model ?? null });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-t1">Grade finished conversations</div>
          <div className="text-[12px] leading-snug text-t3">An LLM judge scores a sample of runs from 1 to 5 against the rubric, in the background.</div>
        </div>
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Grade finished conversations" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <FieldLabel>Sample rate</FieldLabel>
          <div className="relative">
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft.sampleRate}
              onChange={(e) => setDraft({ ...draft, sampleRate: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
              className="pr-8 tabular-nums"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-t3">%</span>
          </div>
        </div>
        <div>
          <FieldLabel>Flag scores at or below</FieldLabel>
          <Select value={draft.lowScore} onChange={(e) => setDraft({ ...draft, lowScore: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} / 5
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <FieldLabel>Rubric</FieldLabel>
        <Textarea rows={3} value={draft.rubric} onChange={(e) => setDraft({ ...draft, rubric: e.target.value })} placeholder="What a good answer looks like." />
      </div>
      <JudgeModel model={draft.model} onChange={(model) => setDraft(model ? { ...draft, model } : (({ model: _m, ...rest }) => rest)(draft))} fallbackLabel={fallbackLabel} />
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(config)}>
            Discard
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!dirty || invalid} loading={saving} onClick={() => void save()}>
          <Save className="size-3.5" /> Save
        </Button>
      </div>
    </div>
  );
}

const TREND_H = 132;
const PAD = { top: 10, right: 8, bottom: 22, left: 26 };

/** Daily mean score (1–5) over the last 30 days, with the days that had flagged scores marked. */
export function ScoreTrend({ trend, lowScore }: { trend: OnlineEvalTrendPoint[]; lowScore: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number>();
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = TREND_H - PAD.top - PAD.bottom;
  const x = (i: number) => (trend.length < 2 ? innerW / 2 : (i / (trend.length - 1)) * innerW);
  const y = (score: number) => innerH - ((score - 1) / 4) * innerH;
  const path = trend.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.average)}`).join('');
  const hovered = hover === undefined ? undefined : trend[hover];

  return (
    <div ref={box} className="relative w-full select-none" style={{ height: TREND_H }} onMouseLeave={() => setHover(undefined)}>
      {width > 0 && (
        <svg width={width} height={TREND_H} role="img" aria-label={`Daily mean score over ${trend.length} days`} className="block overflow-visible">
          <g transform={`translate(${PAD.left},${PAD.top})`}>
            <rect x={0} y={y(lowScore)} width={innerW} height={innerH - y(lowScore)} style={{ fill: 'color-mix(in oklab, var(--rd) 7%, transparent)' }} />
            {[1, 2, 3, 4, 5].map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line x1={0} x2={innerW} style={{ stroke: tick === 1 ? 'var(--bd)' : 'var(--hair)' }} shapeRendering="crispEdges" />
                <text x={-8} dy="0.32em" textAnchor="end" className="tabular-nums" style={{ fill: 'var(--t3)', fontSize: 11 }}>
                  {tick}
                </text>
              </g>
            ))}
            <path d={path} fill="none" style={{ stroke: 'var(--viz-1)', strokeWidth: 2 }} strokeLinejoin="round" strokeLinecap="round" />
            {trend.map((p, i) => (
              <circle
                key={p.day}
                cx={x(i)}
                cy={y(p.average)}
                r={hover === i ? 4.5 : 3}
                style={{ fill: p.flagged ? 'var(--rd)' : 'var(--viz-1)', stroke: 'var(--sf)', strokeWidth: 1.5 }}
              />
            ))}
            {trend.length > 0 && (
              <>
                <text x={0} y={innerH + 16} style={{ fill: 'var(--t3)', fontSize: 11 }}>
                  {trend[0].day.slice(5)}
                </text>
                {trend.length > 1 && (
                  <text x={innerW} y={innerH + 16} textAnchor="end" style={{ fill: 'var(--t3)', fontSize: 11 }}>
                    {trend[trend.length - 1].day.slice(5)}
                  </text>
                )}
              </>
            )}
            {trend.map((p, i) => (
              <rect
                key={`hit-${p.day}`}
                x={x(i) - Math.max(6, innerW / Math.max(1, trend.length) / 2)}
                y={0}
                width={Math.max(12, innerW / Math.max(1, trend.length))}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </g>
        </svg>
      )}
      {hovered && hover !== undefined && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-hair bg-sf px-2.5 py-1.5 text-[12px] shadow-[0_6px_20px_rgba(0,0,0,0.12)]"
          style={{ left: Math.min(Math.max(PAD.left + x(hover), 70), width - 70) }}
        >
          <div className="font-semibold text-t1">{hovered.day}</div>
          <div className="tabular-nums text-t2">
            Mean {trim(hovered.average, 2)} · {hovered.count} graded
            {hovered.flagged > 0 && <span className="text-rd"> · {hovered.flagged} flagged</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-hair bg-wl px-3 py-2">
      <div className="text-[11px] text-t3">{label}</div>
      <div className="flex items-baseline gap-1.5 text-[17px] font-semibold tabular-nums text-t1">
        {value}
        {children}
      </div>
    </div>
  );
}

function ScoreRow({ score, lowScore, link }: { score: OnlineEvalScore; lowScore: number; link?: { href: string; label: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cn('rounded-[10px] border border-hair bg-sf px-3 py-2', score.flagged && 'border-l-[3px] border-l-rd')}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-2.5 text-left" aria-expanded={open}>
        <Badge tone={scoreTone(score.score, lowScore)} className="mt-px tabular-nums">
          {score.score} / 5
        </Badge>
        <span className="min-w-0 flex-1">
          <span className={cn('block text-[13px] text-t1', !open && 'truncate')}>{score.input || '(no input)'}</span>
          <span className={cn('block text-[12px] text-t3', !open && 'truncate')}>{score.reasoning}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-t3">
          {score.flagged && <Flag className="size-3 text-rd" />}
          {timeAgo(score.createdAt)}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-hair pt-2 text-[12px] animate-in">
          <div>
            <div className="font-semibold text-t2">Reply</div>
            <p className="whitespace-pre-wrap text-t1">{score.output || '(empty)'}</p>
          </div>
          {score.tools && score.tools.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-semibold text-t2">Tools</span>
              {score.tools.map((tool, i) => (
                <Badge key={`${tool}-${i}`} tone="muted" className="font-mono font-medium">
                  {tool}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 text-t3">
            <span className="font-mono">{score.judge}</span>
            {link && (
              <Link href={link.href} className="ml-auto inline-flex items-center gap-1 text-ac hover:underline">
                {link.label} <ExternalLink className="size-3" />
              </Link>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The panel: settings on top, then totals, trend and scores. `linkOf` points a score at the session or
 * execution it graded; `actions` sits next to the title (e.g. "Grade a session now").
 */
export function OnlineEvalPanel({
  report,
  onSave,
  linkOf,
  actions,
  fallbackLabel = 'The agent’s own model',
  empty,
}: {
  report: OnlineEvalReport;
  onSave: (patch: OnlineEvalPatch) => Promise<unknown>;
  linkOf?: (score: OnlineEvalScore) => { href: string; label: string } | undefined;
  actions?: ReactNode;
  fallbackLabel?: string;
  empty?: ReactNode;
}) {
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const { config } = report;
  const scores = useMemo(() => (flaggedOnly ? report.scores.filter((s) => s.flagged) : report.scores), [report.scores, flaggedOnly]);
  const change = report.change;

  return (
    <div className="space-y-4">
      <Settings config={config} onSave={onSave} fallbackLabel={fallbackLabel} />
      <div className="border-t border-hair pt-4">
        <div className="mb-2.5 flex items-center gap-2">
          <Gauge className="size-4 text-t3" />
          <h3 className="text-[13px] font-semibold text-t1">Scores</h3>
          <div className="ml-auto flex items-center gap-1.5">{actions}</div>
        </div>
        {report.total === 0 ? (
          (empty ?? <EmptyState compact title="No scores yet" hint={config.enabled ? `About ${config.sampleRate}% of finished runs are graded; scores show up here.` : 'Turn grading on to score finished runs.'} />)
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Graded" value={report.total} />
              <Stat label="Mean score" value={report.average !== undefined ? trim(report.average, 2) : '—'}>
                <span className="text-[11px] font-normal text-t3">/ 5</span>
              </Stat>
              <Stat label="Flagged" value={<span className={report.flagged ? 'text-rd' : undefined}>{report.flagged}</span>} />
              <Stat
                label="Last 10 vs 10 before"
                value={
                  change === undefined ? (
                    '—'
                  ) : (
                    <span className={cn('inline-flex items-center gap-0.5', change > 0.05 ? 'text-gn' : change < -0.05 ? 'text-rd' : 'text-t2')}>
                      {change > 0.05 ? <ArrowUpRight className="size-4" /> : change < -0.05 ? <ArrowDownRight className="size-4" /> : null}
                      {change > 0 ? '+' : ''}
                      {trim(change, 2)}
                    </span>
                  )
                }
              />
            </div>
            {report.trend.length > 0 && (
              <div className="mt-3 rounded-[10px] border border-hair bg-wl px-2 pb-1 pt-2">
                <ScoreTrend trend={report.trend} lowScore={config.lowScore} />
              </div>
            )}
            <div className="mb-1.5 mt-3 flex items-center gap-2">
              <span className="text-[12px] text-t3">Latest {report.scores.length}</span>
              <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-t2">
                <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} className="size-3.5 cursor-pointer accent-ac2" />
                Flagged only
              </label>
            </div>
            <ul className="space-y-1.5">
              {scores.map((score) => (
                <ScoreRow key={score.id} score={score} lowScore={config.lowScore} link={linkOf?.(score)} />
              ))}
              {!scores.length && <li className="py-4 text-center text-[12px] text-t3">No flagged scores.</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
