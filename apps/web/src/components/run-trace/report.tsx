'use client';
/** The Report tab: the generic run report, plain facts from the model. */
import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { RUN_PROFILES } from '@/lib/shared/run-profiles';
import { checksLine, type RunReport } from '@/lib/shared/run-report';
import { formatCost } from '@/lib/shared/ai-usage';
import { cut, edgeParts, fmtMs, preview, resultOf, spendLine, textOf, type RunModel } from '@/lib/shared/run-trace-model';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Select } from '../ui/inputs';
import { ModelMark } from './connections';
import { Card, SectionTitle, Tap, ToneBadge, who } from './parts';
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

/** One sentence per fact, no interpretation. */
/** Who took part: everyone but models and the flow itself. */
const teamOf = (model: RunModel) => model.actors.filter((a) => a.actor.type !== 'model' && a.actor.type !== 'system');

/** The name of the profile the run started with. */
function resolvedName(model: RunModel): string {
  const setting = model.run?.attrs.profile;
  return typeof setting === 'string' && setting in RUN_PROFILES ? RUN_PROFILES[setting as keyof typeof RUN_PROFILES].name : setting && typeof setting === 'object' ? 'custom' : RUN_PROFILES.generic.name;
}

function summary(model: RunModel, report: RunReport): string {
  const team = teamOf(model);
  const requests = model.order.filter((s) => s.kind === 'delegate' || s.kind === 'handoff');
  const results = requests.map((s) => resultOf(s)[0]);
  const count = (l: string) => results.filter((r) => r === l).length;
  const parts = [`${team.length} took part${model.status === 'success' || model.status === 'error' ? `, over ${fmtMs(model.t1 - model.t0)}` : ''}.`];
  if (requests.length)
    parts.push(
      `${requests.length} request${requests.length > 1 ? 's' : ''} to other agents: ${count('Delivered')} delivered, ${count('Answered')} answered, ${count('Left undelivered')} left undelivered.`,
    );
  if (model.failedSteps.length)
    parts.push(
      `${model.failedSteps.length} step${model.failedSteps.length > 1 ? 's' : ''} failed${model.failedSteps.some((f) => f.hidden) ? `, ${model.failedSteps.filter((f) => f.hidden).length} of them inside a call that still ended well` : ''}.`,
    );
  const line = checksLine(report);
  parts.push(`${line[0].toUpperCase()}${line.slice(1)}.`);
  return parts.join(' ');
}

/**
 * `report`: the Run report node's checks over the journal, live, with the profile the run started with (Settings → Run
 * Trace), or the one picked here (`profile`, `onProfile`: look at a run through another profile without changing the flow).
 */
export function Report({ model, report, open, profile, onProfile }: { model: RunModel; report?: RunReport; open: (o: Open) => void; profile?: string; onProfile?: (id: string | undefined) => void }) {
  if (model.empty || !report) return <EmptyState compact title="Nothing recorded yet" hint="The report builds from the facts as the run goes." />;
  const { outcome } = model;
  // Files agents wrote count as made, as the Artifacts tab shows them.
  const made = model.artifacts.length + report.files.length;
  const saved = model.artifacts.filter((a) => a.artifact.kind === 'report').at(-1);
  const recorded = (spanId: string | undefined, name: string) => model.checks.find((c) => c.spanId === spanId && c.check.name === name);
  const openCheck = (spanId: string | undefined, name: string) => {
    const item = recorded(spanId, name);
    if (item) open({ kind: 'check', id: item.id });
    else if (spanId) open({ kind: 'span', id: spanId });
  };
  const copy = () => {
    navigator.clipboard.writeText(saved?.artifact.text ?? report.markdown).then(
      () => toast.success('Report copied as Markdown'),
      () => toast.error('Could not copy'),
    );
  };
  const failedReport = report.checks.filter((c) => (c.status === 'fail' || c.status === 'warn') && c.resolution?.decision !== 'accepted');
  const otherReport = report.checks.filter((c) => !failedReport.includes(c));
  const requests = model.order.filter((s) => s.kind === 'delegate' || s.kind === 'handoff');
  const waits = model.order.filter((s) => s.kind === 'wait');
  const failedChecks = model.checks.filter((c) => c.check.status === 'fail' || c.check.status === 'warn');
  const okChecks = model.checks.filter((c) => c.check.status === 'pass' || c.check.status === 'skip');
  const team = teamOf(model);
  const spenders = team.filter((a) => a.tokensIn + a.tokensOut > 0);
  const name = (id: string) => model.actors.find((a) => a.actor.id === id)?.actor;
  return (
    <div>
      {model.live && <p className="mb-3 rounded-xl bg-warndim px-3 py-2 text-[12.5px] text-warn">The run is still going: this is the report so far.</p>}
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
        <Card>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Reported</div>
          <div className="mt-1 line-clamp-4 text-[13.5px] text-t1">{outcome.reported ? preview(outcome.reported.text, 220) : 'Nothing reported'}</div>
          {outcome.reported && <div className="mt-1 text-[12px] text-t3">by {outcome.reported.by}</div>}
        </Card>
        <Card tone={report.verdict === 'fail' ? 'bad' : report.verdict === 'warn' ? 'warn' : 'ok'}>
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
          <div className="mt-1 text-[12px] text-t3">{checksLine(report)[0].toUpperCase() + checksLine(report).slice(1)}</div>
        </Card>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        {[
          [fmtMs(model.t1 - model.t0), 'run time'],
          [String(team.length), 'taking part'],
          [String(requests.length), 'requests'],
          [(model.tokens.inputTokens + model.tokens.outputTokens).toLocaleString(), model.tokens.costUsd !== undefined ? `tokens · ${formatCost(model.tokens.costUsd)}` : 'tokens'],
          [String(model.failedSteps.length), 'failed steps'],
          [String(made), 'artifacts'],
        ].map(([v, l]) => (
          <div key={l} className="rounded-xl border border-hair bg-sf px-1 py-2">
            <b className="block text-[15px] font-semibold text-t1">{v}</b>
            <span className="text-[11px] text-t3">{l}</span>
          </div>
        ))}
      </div>

      <SectionTitle>In short · from the facts below</SectionTitle>
      <Card>
        <p className="text-[13.5px] leading-snug text-t1">{summary(model, report)}</p>
      </Card>

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

      <SectionTitle>What should happen next</SectionTitle>
      <List>
        {report.next.map((n, i) => (
          <Item key={i} mark={report.verdict === 'pass' ? '✓' : '→'} tone={report.verdict === 'pass' ? 'ok' : undefined}>
            {n}
          </Item>
        ))}
      </List>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy className="size-3.5" /> Copy as Markdown
        </Button>
        {saved && (
          <Button variant="ghost" size="sm" onClick={() => open({ kind: 'artifact', id: saved.id })}>
            Saved report · {saved.actor?.name ?? 'Run report'}
          </Button>
        )}
      </div>

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
                <Small>
                  <ModelMark connections={a.actor.connections} model={a.models[0]} />
                  {spendLine(a)}
                </Small>
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

      <SectionTitle>Artifacts · {made}</SectionTitle>
      {made ? (
        <List>
          {model.artifacts.map((a) => (
            <Item key={a.id} mark="◆" tone="ok" onOpen={() => open({ kind: 'artifact', id: a.id })}>
              {a.artifact.name}
              <Small>
                {a.artifact.kind ?? 'artifact'}
                {a.actor ? ` · ${a.actor.name}` : ''}
              </Small>
            </Item>
          ))}
          {report.files.map((file) => (
            <Item key={file.path} mark="◆" tone="ok" onOpen={() => open({ kind: 'span', id: file.spanId })}>
              <span className="break-all font-mono text-[12.5px]">{file.path}</span>
              <Small>
                {file.created ? 'file written' : 'file changed'}
                {file.by.length ? ` · ${file.by.join(', ')}` : ''} · +{file.additions} −{file.deletions}
              </Small>
            </Item>
          ))}
        </List>
      ) : (
        <p className="px-1 text-[13px] text-t3">Nothing was made.</p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ToneBadge tone="">{model.status}</ToneBadge>
        <Badge tone="muted">{model.order.length} spans</Badge>
      </div>
    </div>
  );
}
