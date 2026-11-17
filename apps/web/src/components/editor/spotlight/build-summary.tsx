'use client';
/**
 * SB15 (docs/assistant.md "Empty canvas"): the card a first draft ends with. The steps in words (folded after five), what
 * was assumed, what is left for the person (each item one button: open the step, or offer the credential picker, which
 * never picks: decision D2) and what no node here can do. A left row is "done" when the canvas says so (a field filled, a
 * credential set), read on every render, never stored.
 */
import { useState } from 'react';
import { CircleCheck, Hand } from 'lucide-react';
import { cn } from '@/lib/utils';
import { credentialLabel, isFilled, type DraftSummary } from '@/lib/shared/draft-summary';
import type { DraftLeft } from '@/lib/shared/draft-left';
import { Button } from '../../ui/button';
import { qualifiedCredentialType, useCredentials } from '../../credentials/use-credentials';
import { useEditor } from '../store';
import { CredentialPicker } from './credential-picker';

/** Steps shown before "Show all N". */
export const STEPS_SHOWN = 5;

const BUTTON = 'max-md:h-11 max-md:px-4';

function Heading({ children }: { children: string }) {
  return <p className="text-[11.5px] font-semibold text-t1">{children}</p>;
}

/** The picker of one credential item, once the person asks for it: with none to pick from, it opens the "create" dialog. */
function PickerHost({ item, nodeId, type, slots, onPicked }: { item: DraftLeft; nodeId: string; type: string; slots: string[]; onPicked: () => void }) {
  const workflowId = useEditor((s) => s.workflowId);
  const { credentials } = useCredentials();
  const accepted = new Set(slots.map((slot) => qualifiedCredentialType(type, slot)));
  const none = credentials !== undefined && !credentials.some((c) => accepted.has(c.type));
  return <CredentialPicker workflowId={workflowId} nodeId={nodeId} node={item.node} nodeType={type} credentialTypes={slots} onPicked={onPicked} startCreating={none} />;
}

function LeftRow({ item, onOpen }: { item: DraftLeft; onOpen: (name: string) => void }) {
  const [picking, setPicking] = useState(false);
  const step = useEditor((s) => (item.node ? s.nodes.map((n) => n.data.wf).find((n) => n.name === item.node) : undefined));
  const descriptor = useEditor((s) => (step ? s.nodeTypes[step.type]?.descriptor : undefined));
  const slots = (descriptor?.credentials ?? []).map((c) => c.name);
  const chosen = step && item.kind === 'credential' ? Object.values(step.credentials ?? {}).find((c) => c?.id) : undefined;
  const filled = step && item.field && item.kind !== 'credential' && item.kind !== 'dropped' ? isFilled(step.parameters?.[item.field]) : false;
  const gone = item.kind !== 'dropped' && Boolean(item.node) && !step;
  const done = Boolean(chosen) || filled || gone;
  const label = credentialLabel(item);
  const pick = label ? `Pick ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} credential` : 'Pick a credential';
  return (
    <div className="space-y-1.5" data-testid="summary-left" data-state={done ? 'done' : 'open'}>
      <div className="flex items-start gap-1.5 text-[12.5px] leading-snug">
        {done ? <CircleCheck className="mt-px size-3.5 shrink-0 text-ok" /> : <Hand className="mt-px size-3.5 shrink-0 text-warn" />}
        <span className={cn('min-w-0 [overflow-wrap:anywhere]', done ? 'text-t3' : 'text-t2')}>{item.text}</span>
      </div>
      {done ? (
        <p className="pl-5 text-[11.5px] text-t3">{chosen ? `Using “${chosen.name}”.` : gone ? 'That step is no longer here.' : 'Done.'}</p>
      ) : item.kind === 'credential' && step ? (
        <div className="space-y-1.5 pl-5">
          <Button size="sm" variant="primary" className={BUTTON} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
            {pick}
          </Button>
          {picking && <PickerHost item={item} nodeId={step.id} type={step.type} slots={slots} onPicked={() => setPicking(false)} />}
        </div>
      ) : item.kind !== 'dropped' && step ? (
        <div className="pl-5">
          <Button size="sm" variant="primary" className={BUTTON} onClick={() => onOpen(item.node)}>
            Open “{item.node}”
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Left items grouped by step, in the order the steps first appear. */
export function groupedLeft(left: DraftLeft[]): DraftLeft[] {
  const nodes = [...new Set(left.map((l) => l.node))];
  return nodes.flatMap((node) => left.filter((l) => l.node === node));
}

export function BuildSummaryCard({ summary, onOpen }: { summary: DraftSummary; workflowName: string; onOpen: (name: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? summary.steps : summary.steps.slice(0, STEPS_SHOWN);
  const left = groupedLeft(summary.left);
  return (
    <div role="group" aria-label="Build summary" className="animate-fade-up space-y-2.5 rounded-xl border border-hair bg-sf p-2.5" data-testid="build-summary">
      <div className="space-y-1">
        <Heading>Steps</Heading>
        <ol className="space-y-0.5 text-[12.5px] leading-snug text-t2" data-testid="summary-steps">
          {shown.map((line) => (
            <li key={line} className="[overflow-wrap:anywhere]">
              {line}
            </li>
          ))}
        </ol>
        {summary.steps.length > STEPS_SHOWN && (
          <button type="button" aria-expanded={all} onClick={() => setAll((a) => !a)} className="min-h-6 rounded-full text-[11.5px] font-semibold text-ac hover:underline max-md:min-h-11">
            {all ? 'Show fewer' : `Show all ${summary.steps.length}`}
          </button>
        )}
      </div>
      {summary.assumptions.length > 0 && (
        <div className="space-y-1" data-testid="summary-assumed">
          <Heading>Assumed</Heading>
          {summary.assumptions.map((line) => (
            <p key={line} className="text-[12.5px] leading-snug text-t2 [overflow-wrap:anywhere]">
              {line}
            </p>
          ))}
        </div>
      )}
      {left.length > 0 && (
        <div className="space-y-2" data-testid="summary-left-list">
          <Heading>Left for you</Heading>
          {left.map((item, i) => (
            <LeftRow key={`${item.node}-${item.field ?? ''}-${item.kind}-${i}`} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
      {summary.cannot.length > 0 && (
        <div className="space-y-1" data-testid="summary-cannot">
          <Heading>Not possible here</Heading>
          {summary.cannot.map((line) => (
            <p key={line} className="text-[12.5px] leading-snug text-t2 [overflow-wrap:anywhere]">
              {line}
            </p>
          ))}
        </div>
      )}
      <p className="text-[11.5px] text-t3">⌘Z undoes the whole build.</p>
    </div>
  );
}
