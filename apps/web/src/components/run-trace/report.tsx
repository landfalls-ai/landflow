'use client';
/** The run report inside the Story: a summary on top (StorySummary) and the facts behind it, folded (ReportDetails). */
import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { DevOnly } from '@/lib/client/developer-details';
import { RUN_PROFILES } from '@/lib/shared/run-profiles';
import { checksLine, type RunReport } from '@/lib/shared/run-report';
import type { RunChanges } from '@/lib/shared/run-changes';
import { cut, edgeParts, fmtMs, preview, resultOf, spendLine, textOf, type RunModel } from '@/lib/shared/run-trace-model';
import { Button } from '../ui/button';
import { Select } from '../ui/inputs';
import { ModelMark } from './connections';
import { Card, SectionTitle, Tap, who } from './parts';
import { nextSteps, summaryTiles, participantsOf } from './run-trace-tabs';
import type { Open } from './sheet';

function List({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-sf">{children}</ul>;
}

function Item({ onOpen, mark, children, tone }: { onOpen?: () => void; mark: string; children: ReactNode; tone?: 'ok' | 'bad' | 'warn' }) {
  const body = (
    <span className="flex items-start gap-2.5 px-3.5 py-2.5 text-[13px] text-t1">
      <span
        className={cn(
          'mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold',
          tone === 'ok' ? 'bg-gndim text-gn' : tone === 'bad' ? 'bg-rddim text-rd' : tone === 'warn' ? 'bg-warndim text-warn' : 'bg-nudim text-t3',
        )}
        aria-hidden
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </span>
  );
  return (
    <li>
      {onOpen ? (
        <Tap onClick={onOpen} className="hover:bg-acdim/60">
          {body}
        </Tap>
      ) : (
        body
      )}
    </li>
  );
}

const Small = ({ children }: { children: ReactNode }) => <small className="block text-[12px] text-t3">{children}</small>;


/** The name of the profile the run started with. */
function resolvedName(model: RunModel): string {
  const setting = model.run?.attrs.profile;
  return typeof setting === 'string' && setting in RUN_PROFILES ? RUN_PROFILES[setting as keyof typeof RUN_PROFILES].name : setting && typeof setting === 'object' ? 'custom' : RUN_PROFILES.generic.name;
}

/** Requests and failed steps in a sentence or two, one sentence per fact; nothing when there were none. */
function summary(model: RunModel): string {
  const requests = model.order.filter((s) => s.kind === 'delegate' || s.kind === 'handoff');
  const results = requests.map((s) => resultOf(s)[0]);
  const count = (l: string) => results.filter((r) => r === l).length;
  const parts: string[] = [];
  if (requests.length)
    parts.push(
      `${requests.length} request${requests.length > 1 ? 's' : ''} to other agents: ${count('Delivered')} delivered, ${count('Answered')} answered, ${count('Left undelivered')} left undelivered.`,
    );
  if (model.failedSteps.length)
    parts.push(
      `${model.failedSteps.length} step${model.failedSteps.length > 1 ? 's' : ''} failed${model.failedSteps.some((f) => f.hidden) ? `, ${model.failedSteps.filter((f) => f.hidden).length} of them inside a call that still ended well` : ''}.`,
    );
  return parts.join(' ');
}

/**
 * The top of the Story: what was reported, how it was checked, the numbers that are not zero, a line in short, and what
 * should happen next when there is something. `profile`, `onProfile`: look at a run through another profile without
 * changing the flow (Settings → Run Trace sets the default).
 */
export function StorySummary({ model, report, changes, open, profile, onProfile }: { model: RunModel; report?: RunReport; changes?: RunChanges; open: (o: Open) => void; profile?: string; onProfile?: (id: string | undefined) => void }) {
  if (model.empty || !report) return null;
  const { outcome } = model;
  const text = summary(model);
  const saved = model.artifacts.filter((a) => a.artifact.kind === 'report').at(-1);
  const copy = () => {
    navigator.clipboard.writeText(saved?.artifact.text ?? report.markdown).then(
      () => toast.success('Report copied as Markdown'),
      () => toast.error('Could not copy'),
    );
  };
  // A passing run with no checks says nothing more than the header: no card, only a small profile picker.
  const showChecked = !(report.verdict === 'pass' && report.checks.length === 0);
  const next = nextSteps(report);
  const tiles = summaryTiles(model, changes);
  return (
    <section aria-label="Summary" data-testid="story-summary" className="mb-3 flex flex-col gap-2">
      {model.live && <p className="rounded-xl bg-warndim px-3 py-2 text-[12.5px] text-warn">The run is still going: this is the summary so far.</p>}
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
        {outcome.reported && (
          <Card className={showChecked ? undefined : 'min-[420px]:col-span-2'}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Reported</div>
            <div className="mt-1 line-clamp-4 text-[13.5px] text-t1">{preview(outcome.reported.text, 220)}</div>
            <div className="mt-1 text-[12px] text-t3">by {outcome.reported.by}</div>
          </Card>
        )}
        {showChecked && (
          <Card tone={report.verdict === 'fail' ? 'bad' : report.verdict === 'warn' ? 'warn' : 'ok'} className={outcome.reported ? undefined : 'min-[420px]:col-span-2'}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Checked</span>
              {onProfile ? (
                <Select aria-label="Check with the profile" className="h-7 w-auto py-0 text-[12px]" value={profile ?? ''} onChange={(e) => onProfile(e.target.value || undefined)}>
                  <option value="">The flow’s ({resolvedName(model)})</option>
                  {Object.values(RUN_PROFILES).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-[11px] text-t3">{report.profile.name}</span>
              )}
            </div>
            <div className="mt-1 text-[13.5px] font-semibold text-t1">{report.label}</div>
            {report.checks.length > 0 && <div className="mt-1 text-[12px] text-t3">{checksLine(report)[0].toUpperCase() + checksLine(report).slice(1)}</div>}
          </Card>
        )}
      </div>
      <div className={cn('grid gap-2 text-center', tiles.length === 1 ? 'grid-cols-1' : tiles.length === 2 || tiles.length === 4 ? 'grid-cols-2' : 'grid-cols-3')} data-testid="summary-tiles">
        {tiles.map(([v, l]) => (
          <div key={l} className="rounded-xl border border-hair bg-sf px-1 py-2">
            <b className="block text-[15px] font-semibold text-t1">{v}</b>
            <span className="text-[11px] text-t3">{l}</span>
          </div>
        ))}
      </div>
      {text && (
        <Card>
          <p className="text-[13.5px] leading-snug text-t1">{text}</p>
        </Card>
      )}
      {next.length > 0 && (
        <div data-testid="summary-next">
          <SectionTitle>What should happen next</SectionTitle>
          <List>
            {next.map((n, i) => (
              <Item key={i} mark="→">
                {n}
              </Item>
            ))}
          </List>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy className="size-3.5" /> Copy as Markdown
        </Button>
        {!showChecked && onProfile && (
          <Select aria-label="Check with the profile" className="h-8 w-auto py-0 text-[12px]" value={profile ?? ''} onChange={(e) => onProfile(e.target.value || undefined)}>
            <option value="">Check with a profile</option>
            {Object.values(RUN_PROFILES).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        {saved && (
          <Button variant="ghost" size="sm" onClick={() => open({ kind: 'artifact', id: saved.id })}>
            Saved report · {saved.actor?.name ?? 'Run report'}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Whether the facts behind the summary have anything to show. */
export function hasDetails(model: RunModel, report?: RunReport): boolean {
  if (model.empty || !report) return false;
  const kinds = new Set(model.order.map((s) => s.kind));
  return (
    model.failedSteps.length > 0 || report.checks.length > 0 || report.claims.length > 0 || report.problems.length > 0 || model.edges.length > 0 || model.cycles.length > 0 ||
    kinds.has('delegate') || kinds.has('handoff') || kinds.has('wait') || participantsOf(model).some((a) => a.tokensIn + a.tokensOut > 0)
  );
}

/** The facts behind the summary: failed steps, checks, claims, who called whom. Sections with nothing in them are not drawn. */
export function ReportDetails({ model, report, open }: { model: RunModel; report?: RunReport; open: (o: Open) => void }) {
  if (model.empty || !report) return null;
  const recorded = (spanId: string | undefined, name: string) => model.checks.find((c) => c.spanId === spanId && c.check.name === name);
  const openCheck = (spanId: string | undefined, name: string) => {
    const item = recorded(spanId, name);
    if (item) open({ kind: 'check', id: item.id });
    else if (spanId) open({ kind: 'span', id: spanId });
  };
  const failedReport = report.checks.filter((c) => (c.status === 'fail' || c.status === 'warn') && c.resolution?.decision !== 'accepted');
  const otherReport = report.checks.filter((c) => !failedReport.includes(c));
  const requests = model.order.filter((s) => s.kind === 'delegate' || s.kind === 'handoff');
  const waits = model.order.filter((s) => s.kind === 'wait');
  const team = participantsOf(model);
  const spenders = team.filter((a) => a.tokensIn + a.tokensOut > 0);
  const name = (id: string) => model.actors.find((a) => a.actor.id === id)?.actor;
  return (
    <div>
      {model.failedSteps.length > 0 && (
        <>
          <SectionTitle>Failed steps · {model.failedSteps.length}</SectionTitle>
          <List>
            {model.failedSteps.map((f) => (
              <Item key={f.spanId} mark="!" tone="bad" onOpen={() => open({ kind: 'span', id: f.spanId })}>
                {who(f.actor)} · {f.name}
                <Small>
                  {f.hidden ? 'The call above it still ended well. ' : ''}
                  {f.error ? cut(f.error, 120) : 'No message'}
                </Small>
              </Item>
            ))}
          </List>
        </>
      )}

      {report.checks.length > 0 && (
        <>
          <SectionTitle>
            Checks · {report.checks.filter((c) => c.status === 'fail').length} failed
            {report.checks.some((c) => c.status === 'warn') ? `, ${report.checks.filter((c) => c.status === 'warn').length} to look at` : ''}, {report.checks.filter((c) => c.status === 'pass').length} passed
          </SectionTitle>
          <List>
            {[...failedReport, ...otherReport].map((c) => (
              <Item
                key={c.id}
                mark={c.status === 'pass' ? '✓' : c.status === 'skip' ? '–' : c.status === 'fail' ? '✗' : '!'}
                tone={c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : undefined}
                onOpen={c.spanId ? () => openCheck(c.spanId, c.name) : undefined}
              >
                {c.name}
                <Small>
                  {c.check === 'node' && c.source !== 'builtin' ? (c.source === 'person' ? 'a person' : 'reported by a node') : 'built in'}
                  {c.resolution ? ` · ${c.resolution.decision === 'accepted' ? 'accepted as is' : 'sent back'} by ${c.resolution.by}` : ''}
                  {c.message ? ` · ${cut(c.message, 140)}` : ''}
                </Small>
              </Item>
            ))}
          </List>
        </>
      )}

      {report.claims.length > 0 && (
        <>
          <SectionTitle>Claims against evidence</SectionTitle>
          <List>
            {report.claims.map((c, i) => (
              <Item
                key={`${c.spanId}:${i}`}
                mark={c.verdict === 'proven' ? '✓' : c.verdict === 'contradicted' ? '✗' : '!'}
                tone={c.verdict === 'proven' ? 'ok' : c.verdict === 'contradicted' ? 'bad' : 'warn'}
                onOpen={() => open({ kind: 'span', id: c.evidenceSpanId ?? c.spanId })}
              >
                {c.actor.name}: “{preview(c.text, 140)}”
                <Small>
                  {c.verdict === 'proven' ? 'A step shows it' : c.verdict === 'contradicted' ? 'The last step that would show it failed' : 'No step shows it'}
                  {c.extracted ? ' · found in the reply' : ''}
                </Small>
              </Item>
            ))}
          </List>
        </>
      )}

      {report.problems.length > 0 && (
        <>
          <SectionTitle>Problems found</SectionTitle>
          <List>
            {report.problems.map((p, i) => (
              <Item key={`${p.spanId}:${i}`} mark={p.fixedBy ? '✓' : '!'} tone={p.fixedBy ? 'ok' : 'bad'} onOpen={() => open({ kind: 'span', id: p.spanId })}>
                {p.text}
                <Small>
                  found by {p.foundBy.name}
                  {p.fixedBy ? ` · fixed by ${p.fixedBy.name}${p.confirmed ? ', confirmed' : ''}` : ' · not fixed'}
                </Small>
              </Item>
            ))}
          </List>
        </>
      )}

      {model.edges.length > 0 && (
        <>
          <SectionTitle>Who called whom</SectionTitle>
          <List>
            {model.edges.map((e) => (
              <Item key={`${e.from}>${e.to}`} mark="→" onOpen={() => open({ kind: 'actor', id: e.to })}>
                <b>{name(e.from)?.name}</b> → <b>{name(e.to)?.name}</b>
                <Small>{edgeParts(e).join(' · ') || 'started by the flow'}</Small>
              </Item>
            ))}
          </List>
        </>
      )}

      {requests.length > 0 && (
        <>
          <SectionTitle>Each request's result</SectionTitle>
          <List>
            {requests.map((s) => {
              const [label, tone] = resultOf(s);
              return (
                <Item
                  key={s.id}
                  mark={tone === 'bad' ? '!' : tone === 'ok' ? '◆' : '·'}
                  tone={tone === 'warn' ? 'warn' : tone || undefined}
                  onOpen={() => open({ kind: 'span', id: s.id })}
                >
                  <b>{s.actor.name}</b> · {label}
                  <Small>
                    {s.steps} steps
                    {s.failedSteps ? `, ${s.failedSteps} failed` : ''} · {fmtMs(s.ms)}
                  </Small>
                </Item>
              );
            })}
          </List>
        </>
      )}

      {spenders.length > 0 && (
        <>
          <SectionTitle>What each agent used</SectionTitle>
          <List>
            {spenders.map((a) => (
              <Item key={a.actor.id} mark={a.priced ? '$' : '·'} onOpen={() => open({ kind: 'actor', id: a.actor.id })}>
                <b>{a.actor.name}</b>
                {a.workMs ? ` · ${fmtMs(a.workMs)}` : ''}
                <DevOnly>
                  <Small>
                    <ModelMark connections={a.actor.connections} model={a.models[0]} />
                    {spendLine(a)}
                  </Small>
                </DevOnly>
              </Item>
            ))}
          </List>
        </>
      )}

      {model.cycles.length > 0 && (
        <>
          <SectionTitle>Cycles</SectionTitle>
          <List>
            {model.cycles.map((c) => (
              <Item key={`${c.a}|${c.b}`} mark="↻">
                <b>{name(c.a)?.name}</b> asked <b>{name(c.b)?.name}</b> ×{c.ab}
                {c.ba > 0 && <>, and back ×{c.ba}</>}
                <Small>{c.rounds > 0 ? `${c.rounds} round${c.rounds > 1 ? 's' : ''} back and forth` : 'asked more than once'}</Small>
              </Item>
            ))}
          </List>
        </>
      )}

      {waits.length > 0 && (
        <>
          <SectionTitle>Waits for people</SectionTitle>
          <List>
            {waits.map((w) => (
              <Item
                key={w.id}
                mark={w.status === 'running' || w.status === 'waiting' ? '…' : '✓'}
                tone={w.status === 'success' ? 'ok' : 'warn'}
                onOpen={() => open({ kind: 'span', id: w.id })}
              >
                {w.name}
                <Small>
                  {w.actor.name} ·{' '}
                  {w.status === 'success'
                    ? `answered after ${fmtMs(w.ms)}`
                    : w.status === 'running' || w.status === 'waiting'
                      ? `waiting ${fmtMs(w.ms)}`
                      : w.status}
                  {textOf(w.output) ? ` · ${preview(textOf(w.output), 80)}` : ''}
                </Small>
              </Item>
            ))}
          </List>
        </>
      )}

    </div>
  );
}
