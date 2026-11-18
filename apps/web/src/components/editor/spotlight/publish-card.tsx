'use client';
/**
 * Spotlight's publish card (AG21, docs/assistant.md "Agents and teams"): `propose_publish` offers the editor's draft,
 * `propose_agent_update` an update of the production version to newer agent versions. The card titles itself
 * `publishOfferLine`, lists what the version runs, and is the only way anything publishes: a draft offer has **Publish** (with
 * a block, **Publish <agent> first** or, secondary, **Publish with <agent> vN as published**); an update offer has **Test**
 * (a run of the production graph with the new versions), then **Publish v<next>**, enabled only after a passing test.
 */
import { useEffect } from 'react';
import { Check, ExternalLink, FlaskConical, Loader2, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import { availableLine, publishOfferLine, runVersionsLine, type PublishOffer, type RunVersions } from '@/lib/shared/agent-versions';
import { heldLine, type GateVerdict } from '@/lib/shared/agent-eval';
import { Button } from '../../ui/button';
import { useAssistant } from '../assistant';
import { useEditor } from '../store';
import { BlockNotice, blocksOf, publishVersion } from '../publish-control';
import type { PublishCardState } from './publish-part';
import { UnattendedLines } from './unattended-line'; // AG23:

const sameOffer = (a: PublishOffer, b: PublishOffer) => a.workflowId === b.workflowId && a.kind === b.kind && a.nextVersion === b.nextVersion;

function setCard(itemId: string, offer: PublishOffer, card: PublishCardState) {
  useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'publishOffer' && sameOffer(p.offer, offer) ? { ...p, card } : p)));
}

interface RunAnswer {
  execution: { status: string; error?: { message: string }; versions?: RunVersions };
}

/** What a test run says now: passed, waiting for a person's answer, or failed. */
async function readRun(executionId: string): Promise<Extract<PublishCardState, { phase: 'tested' }>> {
  const { execution } = await api<RunAnswer>(`/api/executions/${executionId}`, { background: true });
  const line = execution.versions ? runVersionsLine(execution.versions) : undefined;
  if (execution.status === 'success') return { phase: 'tested', executionId, result: 'passed', ...(line && { line }) };
  if (execution.status === 'error' || execution.status === 'canceled') return { phase: 'tested', executionId, result: 'failed', ...(line && { line }), error: execution.error?.message ?? 'The test run did not finish' };
  return { phase: 'tested', executionId, result: 'waiting', ...(line && { line }) };
}

async function test(itemId: string, offer: PublishOffer) {
  setCard(itemId, offer, { phase: 'testing' });
  try {
    const started = await api<{ executionId: string; status: string }>(`/api/workflows/${offer.workflowId}/test-update`, { method: 'POST', json: { agents: (offer.updates ?? []).map((u) => u.agentId) } });
    setCard(itemId, offer, await readRun(started.executionId));
  } catch (e) {
    setCard(itemId, offer, { phase: 'failed', error: (e as Error).message });
  }
}

async function publish(itemId: string, offer: PublishOffer, how?: 'publish-first' | 'as-published', executionId?: string) {
  setCard(itemId, offer, { phase: 'publishing', ...(executionId && { executionId }) });
  try {
    const result = await publishVersion(offer.workflowId, offer.kind === 'update' ? { update: { agents: (offer.updates ?? []).map((u) => u.agentId) }, ...(executionId && { testedExecutionId: executionId }) } : { ...(how && { agents: how }) });
    if (result.approvalRequired) return setCard(itemId, offer, { phase: 'published', line: 'Sent for approval: someone else has to approve it before it goes live.' });
    setCard(itemId, offer, { phase: 'published', versionNumber: result.published?.versionNumber });
  } catch (e) {
    const blocks = blocksOf(e);
    // AG24: a held eval gate is answered with its verdict: the score and what it was judged on show on every attempt, never the bare message.
    const held = e instanceof ApiError && e.status === 409 ? (e.body as { code?: string; gate?: { verdict?: GateVerdict } } | undefined) : undefined;
    const verdict = held?.code === 'agent_publish_held' ? held.gate?.verdict : undefined;
    setCard(itemId, offer, blocks ? { phase: 'blocked', blocks } : { phase: 'failed', error: (e as Error).message, ...(executionId && { executionId }), ...(verdict && { held: verdict }) });
  }
}

export function PublishCardView({ itemId, offer, card }: { itemId: string; offer: PublishOffer; card?: PublishCardState }) {
  const state: PublishCardState = card ?? { phase: 'idle' };
  const workflowId = useEditor((s) => s.workflowId);
  const dirty = useEditor((s) => s.dirty);
  const here = workflowId === offer.workflowId;
  // A test that waits for a person's answer (an approval) passes once they answer it: look again until it ends.
  const waiting = state.phase === 'tested' && state.result === 'waiting' ? state.executionId : undefined;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void readRun(waiting).then((next) => next.result !== 'waiting' && setCard(itemId, offer, next)).catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [waiting, itemId, offer]);
  const blocks = state.phase === 'blocked' ? state.blocks : offer.blocks;
  const passed = state.phase === 'tested' && state.result === 'passed';
  const busy = state.phase === 'testing' || state.phase === 'publishing';
  const done = state.phase === 'published';
  const runs = [...new Map(offer.pins.map((p) => [p.agentId, p])).values()];
  return (
    <div data-testid="publish-card" className={cn('animate-fade-up rounded-xl border bg-sf p-2.5 transition-colors duration-200 motion-reduce:transition-none', done ? 'border-gnbd' : 'border-acbd')}>
      <div className="flex items-center gap-1.5 text-[13px] font-semibold leading-snug text-t1 [overflow-wrap:anywhere]">
        {done ? <Check className="size-3.5 shrink-0 text-gn" /> : <Rocket className="size-3.5 shrink-0 text-ac" />}
        {publishOfferLine(offer)}
      </div>
      <div className="mt-1 flex flex-col gap-0.5 text-[12px] leading-snug text-t2">
        {offer.kind === 'update' && (offer.updates ?? []).map((u) => <div key={u.agentId}>{availableLine(u)}</div>)}
        {runs.map((p) => (
          <div key={p.agentId}>
            Runs {p.agentName ?? p.agentId} v{p.version}
          </div>
        ))}
        {!runs.length && <div>It runs no saved agent, so there are no versions to pin.</div>}
      </div>
      {!done && <UnattendedLines workflowId={offer.workflowId} version={offer.kind === 'draft' ? 'draft' : undefined} update={offer.kind === 'update' ? (offer.updates ?? []).map((u) => u.agentId) : undefined} className="mt-1.5" />}{/* AG23: */}
      {blocks?.length && !done ? <BlockNotice className="mt-2" blocks={blocks} busy={busy} onChoose={(how) => void publish(itemId, offer, how)} /> : null}
      {state.phase === 'tested' && (
        <div data-testid="publish-test" className={cn('mt-2 rounded-lg border px-2 py-1.5 text-[12px] leading-snug', state.result === 'passed' ? 'border-gnbd bg-gndim text-t1' : state.result === 'waiting' ? 'border-warnbd bg-warndim text-t1' : 'border-rdbd bg-rddim text-t1')}>
          {state.result === 'passed' ? 'The test passed' : state.result === 'waiting' ? 'The test is waiting for your answer: approve or deny it under Needs you, then this card goes on' : `The test failed${state.error ? `: ${state.error}` : ''}`}
          {state.line && <div className="text-t2">{state.line}</div>}
          <a className="mt-0.5 inline-flex items-center gap-1 text-ac hover:underline" href={`/workflows/${offer.workflowId}/runs/${state.executionId}`} target="_blank" rel="noreferrer">
            Open the run <ExternalLink className="size-3" />
          </a>
        </div>
      )}
      {state.phase === 'failed' && (
        <div data-testid={state.held ? 'publish-held' : undefined} className="mt-2 text-[12px] leading-snug text-rd [overflow-wrap:anywhere]">
          {state.held ? heldLine(state.held) : state.error} {/* AG24: */}
        </div>
      )}
      {state.phase === 'published' && <div className="mt-2 text-[12px] leading-snug text-t1">{state.line ?? `Published${state.versionNumber ? ` v${state.versionNumber}` : ''}: production runs it now.`}</div>}
      {!done && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {offer.kind === 'update' ? (
            <>
              <Button size="sm" variant={passed ? 'outline' : 'primary'} loading={state.phase === 'testing'} disabled={busy || !here} onClick={() => void test(itemId, offer)}>
                <FlaskConical className="size-3.5" /> {state.phase === 'tested' ? 'Test again' : 'Test'}
              </Button>
              <Button size="sm" variant="primary" loading={state.phase === 'publishing'} disabled={busy || !passed || !here} onClick={() => passed && void publish(itemId, offer, undefined, state.executionId)}>
                <Rocket className="size-3.5" /> Publish v{offer.nextVersion}
              </Button>
            </>
          ) : (
            !blocks?.length && (
              <Button size="sm" variant="primary" loading={state.phase === 'publishing'} disabled={busy || dirty || !here} onClick={() => void publish(itemId, offer)}>
                {state.phase === 'publishing' ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />} Publish
              </Button>
            )
          )}
          {!here && <span className="text-[11px] text-t3">Open this workflow to use the card.</span>}
          {here && dirty && offer.kind === 'draft' && <span className="text-[11px] text-t3">Waiting for the autosave.</span>}
        </div>
      )}
    </div>
  );
}
