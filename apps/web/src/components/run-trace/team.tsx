'use client';
/** The Team tab: who called whom (a vertical layout, no sideways scroll) and a card per actor. */
import { useState } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { teamSnapshotOf, type TeamSnapshot, type TeamSnapshotMember } from '@/lib/shared/agent-teams';
import { fixCyclesOf, type FixCycle } from '@/lib/shared/fix-cycles';
import { resolveRunProfile } from '@/lib/shared/run-profiles';
import { cut, edgeParts, fmtMs, preview, spendLine, type RunActorStats, type RunEdge, type RunModel, type RunRound, type RunTurn, type RunTurnItem } from '@/lib/shared/run-trace-model';
import { Badge } from '../ui/badge';
import { EmptyState } from '../ui/empty-state';
import { ConnectionChips } from './connections';
import { Avatar, Card, SectionTitle, Tap, ToneBadge, actorColor } from './parts';
import type { Open } from './sheet';

/** Team members: everyone but the models (their calls count for the agent that made them). */
const members = (model: RunModel) => model.actors.filter((a) => a.actor.type !== 'model');

/** Layers by distance from whoever started the run. */
function layers(model: RunModel): string[][] {
  const ids = members(model).map((a) => a.actor.id);
  const start = model.run?.actor.id && ids.includes(model.run.actor.id) ? model.run.actor.id : ids[0];
  if (!start) return [];
  const depth: Record<string, number> = { [start]: 0 };
  const queue = [start];
  while (queue.length) {
    const x = queue.shift()!;
    for (const e of model.edges) {
      const y = e.from === x ? e.to : e.to === x ? e.from : undefined;
      if (y && depth[y] === undefined && ids.includes(y)) {
        depth[y] = depth[x] + 1;
        queue.push(y);
      }
    }
  }
  const out: string[][] = [];
  for (const id of ids) (out[depth[id] ?? 0] ??= []).push(id);
  return out.filter(Boolean);
}

function EdgePill({ edge, model }: { edge: RunEdge; model: RunModel }) {
  const a = model.actors.find((x) => x.actor.id === edge.from)?.actor;
  const b = model.actors.find((x) => x.actor.id === edge.to)?.actor;
  const parts = edgeParts(edge);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-hair bg-sf px-2.5 py-1 text-[12px] text-t2">
      <span className="truncate">{a?.name}</span>
      <ArrowRight className="size-3 shrink-0 text-t3" />
      <span className="truncate">{b?.name}</span>
      {parts.length > 0 && <b className="shrink-0 font-semibold text-t1">{parts.join(' · ')}</b>}
    </span>
  );
}

/** Consecutive tool calls as one line: "Bash ×6 · Edit ×2". */
function groupTools(items: RunTurnItem[]): Array<RunTurnItem | { tools: RunTurnItem[]; key: string }> {
  const out: Array<RunTurnItem | { tools: RunTurnItem[]; key: string }> = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.type !== 'tool') out.push(item);
    else if (last && 'tools' in last) last.tools.push(item);
    else out.push({ tools: [item], key: `g:${item.key}` });
  }
  return out;
}

function toolSummary(tools: RunTurnItem[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const name = t.label.split(':')[0];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ');
}

/** One turn: why, what it did (requests, tool calls, words), what came back. */
function TurnRow({ turn, open }: { turn: RunTurn; open: (o: Open) => void }) {
  const running = turn.status === 'running' || turn.status === 'waiting';
  return (
    <li className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12.5px]">
      <Tap onClick={() => open({ kind: 'span', id: turn.spanId })} label={`Turn ${turn.n}`} className="rounded-lg">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-t3">
          <b className="font-semibold text-t1">{turn.kind === 'request' ? `Request ${turn.n}` : `Turn ${turn.n}`}</b>
          {turn.round && <span>round {turn.round}</span>}
          {turn.caller && <span>from {turn.caller.name}</span>}
          <span className="ml-auto font-mono tabular-nums">{running ? 'running …' : fmtMs(turn.ms)}</span>
        </div>
        {turn.reason && (
          <p className="mt-1 line-clamp-3 break-words text-t1">
            <span className="text-t3">Why </span>
            {preview(turn.reason, 300)}
          </p>
        )}
      </Tap>
      {turn.did.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {groupTools(turn.did).map((entry) =>
            'tools' in entry ? (
              <li key={entry.key} className="break-words text-t2">
                <span className="text-t3">Used </span>
                {toolSummary(entry.tools)}
                {entry.tools.some((t) => t.status === 'error') && <span className="text-rd"> · {entry.tools.filter((t) => t.status === 'error').length} failed</span>}
              </li>
            ) : entry.type === 'said' ? (
              <li key={entry.key} className="line-clamp-3 break-words border-l-2 border-hair pl-2 text-t2">
                {preview(entry.text ?? '', 260)}
              </li>
            ) : (
              <li key={entry.key} className="break-words text-t2">
                <button type="button" onClick={() => open({ kind: 'span', id: entry.spanId })} className="block w-full text-left">
                  <span className="text-t3">Asked </span>
                  <b className="font-semibold text-t1">{entry.label}</b>
                  {entry.reason && <span className="line-clamp-2"> — {preview(entry.reason, 200)}</span>}
                  {entry.text && (
                    <span className={cn('line-clamp-2 block', entry.status === 'error' ? 'text-rd' : 'text-t3')}>
                      Back: {preview(entry.text, 200)}
                      <span className="font-mono text-[11px]">
                        {' '}
                        · {fmtMs(entry.ms)}
                        {entry.steps > 0 ? ` · ${entry.steps} steps` : ''}
                      </span>
                    </span>
                  )}
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {turn.answer && <p className="mt-1.5 line-clamp-3 break-words text-t2">{preview(turn.answer, 260)}</p>}
      {turn.back && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ToneBadge tone={turn.back.tone}>{turn.back.result}</ToneBadge>
          {turn.back.steps > 0 && <Badge tone="neutral">{turn.back.steps} steps</Badge>}
          {turn.back.failedSteps > 0 && <Badge tone="danger">{turn.back.failedSteps} failed</Badge>}
          {(turn.back.error || turn.back.text) && (
            <span className={cn('line-clamp-2 min-w-0 flex-1 break-words text-[12px]', turn.back.error ? 'text-rd' : 'text-t3')}>{preview(turn.back.error ?? turn.back.text ?? '', 160)}</span>
          )}
        </div>
      )}
    </li>
  );
}

/** A member's turns, collapsed until opened (a phone shows the card, not the whole run). */
function Turns({ turns, open }: { turns: RunTurn[]; open: (o: Open) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-expanded={shown}
        className="flex min-h-9 items-center gap-1.5 rounded-full border border-hair px-3 text-[12px] text-t2 hover:text-t1"
      >
        <ChevronRight className={cn('size-3 transition-transform', shown && 'rotate-90')} />
        {turns.length} turn{turns.length > 1 ? 's' : ''}
      </button>
      {shown && (
        <ul className="mt-1.5 space-y-1.5">
          {turns.map((turn) => (
            <TurnRow key={turn.key} turn={turn} open={open} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** "typecheck 19 → 13, never passed": tap for the last run. */
function FixChips({ cycles, open }: { cycles: FixCycle[]; open: (o: Open) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {cycles.map((cycle) => (
        <button
          key={cycle.check}
          type="button"
          onClick={() => open({ kind: 'span', id: cycle.runs[cycle.runs.length - 1].spanId })}
          title={`${cycle.label}: ${cycle.runs.map((r) => `${r.passed ? 'passed' : r.errors !== undefined ? `${r.errors} errors` : 'failed'} after ${r.changes} change${r.changes === 1 ? '' : 's'}`).join(', ')}`}
          className="min-h-8 max-w-full rounded-full text-left focus-visible:outline-2 focus-visible:outline-ac"
        >
          <Badge tone={cycle.passed ? 'success' : 'danger'} className="max-w-full whitespace-normal rounded-full px-2.5 py-1 text-[12px] font-medium">
            {cycle.trend}
          </Badge>
        </button>
      ))}
    </div>
  );
}

export function ActorCard({ s, open, turns = [], cycles = [], rounds = [] }: { s: RunActorStats; open: (o: Open) => void; turns?: RunTurn[]; cycles?: FixCycle[]; rounds?: RunRound[] }) {
  const li: Array<{ text: React.ReactNode; bad?: boolean }> = [];
  if (s.asked)
    li.push({
      text: (
        <>
          Asked <b>×{s.asked}</b> · worked <b>{fmtMs(s.workMs)}</b> · {s.results.join(', ')}
        </>
      ),
    });
  if (s.steps)
    li.push({
      text: (
        <>
          <b>{s.steps}</b> steps
          {s.failedSteps ? (
            <>
              {' '}
              · <b>{s.failedSteps}</b> failed
            </>
          ) : null}
        </>
      ),
      bad: s.failedSteps > 0,
    });
  if (s.calls)
    li.push({
      text: (
        <>
          Asked other agents <b>×{s.calls}</b>
        </>
      ),
    });
  const spent = spendLine(s);
  if (spent) li.push({ text: spent });
  if (s.toolCalls && !s.asked)
    li.push({
      text: (
        <>
          Used tools <b>×{s.toolCalls}</b>
        </>
      ),
    });
  if (s.messages)
    li.push({
      text: (
        <>
          Sent <b>{s.messages}</b> message{s.messages > 1 ? 's' : ''}
        </>
      ),
    });
  if (s.waits)
    li.push({
      text: (
        <>
          Answered <b>{s.waitsAnswered}</b> of <b>{s.waits}</b> request
          {s.waits > 1 ? 's' : ''} for a person
        </>
      ),
    });
  for (const a of s.artifacts)
    li.push({
      text: (
        <>
          Produced: <b>{cut(a.artifact.name, 44)}</b>
        </>
      ),
    });
  // A check that failed in an earlier round sent the work back; only the last round's failures still stand.
  const last = rounds.at(-1)?.n;
  const listed = new Set<string>();
  for (const c of s.failedChecks) {
    const key = `${c.spanId}|${c.check.name}`;
    if (listed.has(key)) continue;
    listed.add(key);
    const t = Date.parse(c.at);
    const n = (rounds.find((r) => r.spanIds.includes(c.spanId)) ?? rounds.find((r) => t >= r.t0 && (!r.t1 || t <= r.t1)))?.n;
    li.push(n !== undefined && n !== last ? { text: <>Round {n}: {cut(c.check.name, 60)} failed, sent back</> } : { text: <>Check failed: {cut(c.check.name, 60)}</>, bad: true });
  }
  if (!li.length && s.workMs === 0) li.push({ text: 'Took part, nothing else recorded' });
  return (
    <Card>
      <Tap onClick={() => open({ kind: 'actor', id: s.actor.id })} className="rounded-xl hover:bg-acdim/40">
        <div className="flex items-center gap-2.5">
          <Avatar actor={s.actor} />
          <div className="min-w-0">
            <b className="block truncate text-[14px] font-semibold text-t1">{s.actor.name}</b>
            <span className="block truncate text-[12px] text-t3">{s.actor.role ?? (s.actor.type === 'human' ? 'person' : s.actor.type)}</span>
          </div>
        </div>
        <ConnectionChips connections={s.actor.connections} className="mt-2" />
        <ul className="mt-2 space-y-1 text-[12.5px] text-t2">
          {li.map((x, i) => (
            <li key={i} className={cn('break-words', x.bad && 'text-rd')}>
              {x.text}
            </li>
          ))}
        </ul>
      </Tap>
      {cycles.length > 0 && <FixChips cycles={cycles} open={open} />}
      {turns.length > 0 && <Turns turns={turns} open={open} />}
    </Card>
  );
}

/** The reporting lines of a team run, as recorded: an indented tree, one column, so it reads on a phone. */
function TeamChart({ team, model, open }: { team: TeamSnapshot; model: RunModel; open: (o: Open) => void }) {
  const working = new Set(model.working.map((w) => w.actor.name));
  const waiting = new Set(model.needsYou.filter((n) => n.kind === 'wait').map((n) => n.actor?.name));
  const reportsOf = (id: string) => team.members.filter((m) => m.reportsTo === id);
  const roots = team.members.filter((m) => !m.reportsTo || !team.members.some((x) => x.id === m.reportsTo));
  const titleOf = (id: string) => team.members.find((m) => m.id === id)?.title;
  const row = (m: TeamSnapshotMember, seen: Set<string>): React.ReactNode => {
    if (seen.has(m.id)) return null;
    seen.add(m.id);
    const stats = model.actors.find((a) => a.actor.name === m.title);
    const actor = stats?.actor ?? { id: `member:${m.id}`, name: m.title, type: 'agent' as const };
    const connections = actor.connections?.length ? actor.connections : m.connections;
    const live = working.has(m.title) || waiting.has(m.title);
    const reviews = (m.reviews ?? []).map(titleOf).filter(Boolean);
    return (
      <li key={m.id}>
        <Tap onClick={() => open({ kind: 'actor', id: actor.id })} label={m.title} className="rounded-xl">
          <span className={cn('flex items-center gap-2.5 rounded-xl border bg-sf px-3 py-2', live ? 'animate-pulse-soft border-ac' : 'border-hair')}>
            <Avatar actor={actor} />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[13px] font-semibold text-t1">{m.title}</b>
              <span className="block truncate text-[11.5px] text-t3">{live ? 'working now' : (m.role ?? (m.kind === 'a2a' ? 'remote agent' : 'agent'))}</span>
              <ConnectionChips connections={connections} max={6} className="mt-1" />
            </span>
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {reviews.length > 0 && <Badge tone="neutral">reviews {reviews.join(', ')}</Badge>}
              {stats && stats.asked > 0 && <Badge tone="neutral">asked ×{stats.asked}</Badge>}
            </span>
          </span>
        </Tap>
        {reportsOf(m.id).length > 0 && <ul className="ml-4 mt-1.5 space-y-1.5 border-l border-hair pl-3">{reportsOf(m.id).map((r) => row(r, seen))}</ul>}
      </li>
    );
  };
  const seen = new Set<string>();
  return (
    <div>
      <p className="mb-2 px-0.5 text-[12px] text-t3">
        {team.name}
        {team.version ? ` v${team.version}` : ''}
        {team.goal ? ` · ${cut(team.goal, 120)}` : ''}
      </p>
      <ul role="tree" aria-label="Who reports to whom" className="space-y-1.5">
        {roots.map((m) => row(m, seen))}
      </ul>
    </div>
  );
}

export function Team({ model, open }: { model: RunModel; open: (o: Open) => void }) {
  const recorded = model.order.map((s) => teamSnapshotOf(s.attrs)).find(Boolean);
  const rows = layers(model);
  if (!rows.length) return <EmptyState compact title="Nobody yet" hint="The team shows as agents and people take part." />;
  const layerOf = (id: string) => rows.findIndex((r) => r.includes(id));
  const working = new Set(model.working.map((w) => w.actor.id));
  const waitingOn = new Set(model.needsYou.filter((n) => n.kind === 'wait').map((n) => n.actor?.id));
  const edges = model.edges.filter((e) => layerOf(e.from) >= 0 && layerOf(e.to) >= 0);
  const cycles = fixCyclesOf(model, resolveRunProfile(model.run?.attrs.profile));
  return (
    <div>
      {recorded ? (
        <TeamChart team={recorded} model={model} open={open} />
      ) : (
        <div role="img" aria-label="Who called whom" className="flex flex-col items-stretch">
          {rows.map((ids, i) => {
            const between = edges.filter((e) => Math.min(layerOf(e.from), layerOf(e.to)) === i);
            return (
              <div key={i} className="flex flex-col items-center">
                {/* Full width, so a box's 46% is of the screen and a lone box keeps its name. */}
                <div className="flex w-full flex-wrap justify-center gap-2">
                  {ids.map((id) => {
                    const a = model.actors.find((x) => x.actor.id === id)!.actor;
                    const live = working.has(id) || waitingOn.has(id);
                    return (
                      <Tap key={id} onClick={() => open({ kind: 'actor', id })} label={a.name} className="w-auto max-w-[46%]">
                        <span
                          className={cn(
                            'flex items-center gap-2 rounded-xl border-2 bg-sf px-3 py-2',
                            a.type === 'human' && 'rounded-full',
                            live && 'animate-pulse-soft',
                          )}
                          style={{ borderColor: actorColor(a) }}
                        >
                          {a.type === 'agent' ? <Avatar actor={a} size={22} /> : <span className="size-2.5 shrink-0 rounded-full" style={{ background: actorColor(a) }} />}
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-semibold">{a.name}</span>
                            <span className="block text-[11px] text-t3">
                              {live ? (a.type === 'human' ? 'deciding now' : 'working now') : a.type === 'human' ? 'person' : a.type}
                            </span>
                          </span>
                        </span>
                      </Tap>
                    );
                  })}
                </div>
                {between.length > 0 && (
                  <div className="flex flex-col items-center">
                    <span className="h-3 w-px bg-bd" aria-hidden />
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {between.map((e) => (
                        <EdgePill key={`${e.from}>${e.to}`} edge={e} model={model} />
                      ))}
                    </div>
                    {i < rows.length - 1 && <span className="h-3 w-px bg-bd" aria-hidden />}
                  </div>
                )}
                {between.length === 0 && i < rows.length - 1 && <span className="h-5 w-px bg-bd" aria-hidden />}
              </div>
            );
          })}
        </div>
      )}
      <SectionTitle>Everyone</SectionTitle>
      <div className="flex flex-col gap-2">
        {members(model).map((s) => (
          <ActorCard key={s.actor.id} s={s} open={open} turns={model.turns[s.actor.id]} cycles={cycles.filter((c) => c.actor.id === s.actor.id)} rounds={model.rounds} />
        ))}
      </div>
    </div>
  );
}
