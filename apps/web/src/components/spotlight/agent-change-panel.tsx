'use client';
/**
 * Spotlight on an agent's page (docs/assistant.md "Changing an agent"): the panel asks for a change to the agent, or asks
 * about it. A change is designed as a proposal (`POST /api/agents/design` with `base: { agentId }`: nothing saved) and shown as
 * a card of what would change; Apply to its draft saves it, the smoke test runs on the draft, and Publish waits for a pass
 * and goes through the eval gate (decision D3). A question goes to the brain's panel with the agent as its subject: answered,
 * never applied. The agent's page shows the saved draft (the `landflow:agent-changed` event).
 */
import { useRef, useState } from 'react';
import { Check, ExternalLink, Loader2, SquarePen, X } from 'lucide-react';
import { AskPanel, ASK_INPUT, type AskConversation, type AskTag } from '../brain/wiki/ask-panel';
import { Button } from '../ui/button';
import { CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, ChatError, UserBubble } from '../ui/chat';
import { ChatList, ChatMotion } from '../ui/chat-motion';
import { announceChange, designChange, draftMoved, publishChange, readDraft, saveChange, stillLeft, testDraft, useAgentDraft, type ChangeDesign } from '@/lib/client/agent-change'; // AG09: stillLeft, testDraft, useAgentDraft
import { agentChangeAsk } from '@/lib/shared/agent-ask';
import { agentChanges } from '@/lib/shared/agent-changes';
import { publishLine, smokeLine, type AgentPublish, type AgentSmoke } from '@/lib/shared/agent-card';
import { cn } from '@/lib/utils';

type Turn = { id: string; message: string; state: 'designing' | 'ready' | 'saving' | 'saved' | 'failed' | 'dismissed'; design?: ChangeDesign; error?: string; smoke?: AgentSmoke; publish?: AgentPublish; snapshot?: string; notice?: string };

/** The change card: what would change, then Apply to its draft (a small read-only copy of the editor's card rows). */
function ChangeCard({ name, agentId, turn, onApply, onPublish, onDismiss, onTest }: { name: string; agentId: string; turn: Turn; onApply: () => void; onPublish: () => void; onDismiss: () => void; onTest: () => void /* AG09: */ }) {
  const draft = useAgentDraft(agentId); // AG09: the Left row follows the agent's draft, also after a credential is picked on its page
  const changes = turn.design?.changes ?? [];
  const notAdded = turn.design?.notAdded ?? []; // ag1-int:
  const left = [...stillLeft((turn.design?.needs ?? []).map((n) => n.text), draft) /* AG09: */, ...(turn.design?.missing ?? []).map((m) => `Not available here: ${m.capability}`)];
  const saved = turn.state === 'saved';
  return (
    <div data-testid="agent-change-card" className={cn('animate-fade-up rounded-xl border bg-sf p-2.5', saved ? 'border-gnbd' : 'border-acbd')}>
      <div className="flex items-center gap-1.5 text-[13px] font-semibold leading-snug text-t1 [overflow-wrap:anywhere]">
        {saved && <Check className="size-3.5 shrink-0 text-gn" />}
        {name}
      </div>
      <div className="mt-2 space-y-1.5 text-[12px] leading-snug">
        <div className="flex gap-2">
          <span className="w-[68px] shrink-0 text-t3">Changes</span>
          <div className="min-w-0 flex-1 text-t1 [overflow-wrap:anywhere]">
            {changes.length ? (
              <ul data-testid="agent-changes" className="space-y-0.5">
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <span className="text-t3">{notAdded.length ? 'No change.' : 'No change: the agent already has what you asked.'}</span>
            )}
          </div>
        </div>
        {/* ag1-int: the tools the change named that the agent did not get, and why. */}
        {notAdded.length > 0 && (
          <div className="flex gap-2">
            <span className="w-[68px] shrink-0 text-t3">Not added</span>
            <ul data-testid="agent-not-added" className="min-w-0 flex-1 space-y-0.5 text-t1 [overflow-wrap:anywhere]">
              {notAdded.map((n) => (
                <li key={n.name}>
                  {n.name}: {n.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {turn.notice && <p role="status" className="text-t2">{turn.notice}</p>}
        {left.length > 0 && (
          <div className="flex gap-2">
            <span className="w-[68px] shrink-0 text-t3">Left</span>
            <div className="min-w-0 flex-1 text-t1 [overflow-wrap:anywhere]">{left.slice(0, 4).join('; ')}</div>
          </div>
        )}
      </div>
      {turn.state === 'failed' && turn.error && (
        <p role="alert" className="mt-2 text-[12px] leading-snug text-rd [overflow-wrap:anywhere]">
          Couldn’t apply it: {turn.error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {saved ? (
          <>
            <span className={cn('min-w-0 text-[12px] font-semibold [overflow-wrap:anywhere]', turn.smoke?.state === 'failed' || turn.publish?.state === 'held' || turn.publish?.state === 'failed' ? 'text-rd' : turn.smoke?.state === 'passed' ? 'text-gn' : 'text-t2')}>
              Saved to its draft · {smokeLine(turn.smoke)}
              {turn.publish && ` · ${publishLine(turn.publish)}`}
            </span>
            {turn.smoke?.state === 'passed' && turn.publish?.state !== 'published' && (
              <Button size="sm" variant="primary" disabled={turn.publish?.state === 'publishing'} onClick={onPublish} className="max-md:h-11 max-md:px-4">
                {turn.publish?.state === 'publishing' && <Loader2 className="size-3.5 animate-spin" />}
                Publish
              </Button>
            )}
            {/* AG09: the smoke test again on the draft as it is (a credential picked since), no save. */}
            {turn.smoke?.state !== 'testing' && (
              <Button size="sm" variant="ghost" onClick={onTest} className="max-md:h-11 max-md:px-4">
                Test again
              </Button>
            )}
            <a href={`/agents/${agentId}`} className="flex min-h-7 items-center gap-0.5 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
              Draft <ExternalLink className="size-3" />
            </a>
          </>
        ) : (
          <>
            {changes.length > 0 && (
              <Button size="sm" variant="primary" disabled={turn.state === 'saving'} onClick={onApply} className="max-md:h-11 max-md:px-4">
                {turn.state === 'saving' && <Loader2 className="size-3.5 animate-spin" />}
                {turn.state === 'saving' ? 'Applying…' : turn.state === 'failed' ? 'Try again' : 'Apply to its draft'}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={turn.state === 'saving'} onClick={onDismiss} className="max-md:h-11 max-md:px-4">
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function AgentChangePanel({ agentId, name, onClose, conversation, heading, model, starters }: { agentId: string; name: string; onClose: () => void; conversation: AskConversation; heading?: React.ReactNode; model?: string; starters?: string[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState<{ question: string; key: number }>();
  const [view, setView] = useState<'change' | 'ask'>('change');
  const keys = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController>(undefined);
  const designing = turns.some((t) => t.state === 'designing');
  const patch = (id: string, fields: Partial<Turn>) => setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...fields } : t)));
  const tag: AskTag = { type: 'agent', id: agentId, name };

  const change = async (message: string) => {
    const id = `ch_${++keys.current}`;
    setTurns((all) => [...all, { id, message, state: 'designing' }]);
    const request = (abort.current = new AbortController());
    try {
      // The draft the design starts from. A change typed while a card still waits is designed from that card (as the editor does), and its lines are read against the draft.
      const draft = await readDraft(agentId);
      const waiting = [...turns].reverse().find((t) => t.state === 'ready' && t.design);
      const design = await designChange({ name, base: waiting?.design ? { config: waiting.design.config } : { agentId }, change: message }, request.signal);
      if (waiting && draft) design.changes = agentChanges(draft, design.config);
      patch(id, { state: 'ready', design, ...(draft && { snapshot: JSON.stringify(draft) }) });
    } catch (e) {
      patch(id, request.signal.aborted ? { state: 'dismissed' } : { state: 'failed', error: (e as Error).message });
    }
  };

  const send = (text: string) => {
    const message = text.trim();
    if (!message || designing) return;
    setInput('');
    // A change is designed and shown; anything else (a question, or words that are neither) is the brain's to answer, never applied.
    if (agentChangeAsk(message) === 'change') void change(message);
    else {
      setAsking({ question: message, key: ++keys.current });
      setView('ask');
    }
  };

  const apply = async (turn: Turn) => {
    if (!turn.design || turn.state === 'saving') return;
    patch(turn.id, { state: 'saving', error: undefined });
    try {
      // The promise of this card is its Changes row: if the draft moved since it was designed, say what applying does now before any save.
      const moved = await draftMoved(agentId, turn.snapshot, turn.design.config);
      if (moved) {
        patch(turn.id, { state: 'ready', snapshot: moved.snapshot, design: { ...turn.design, changes: moved.changes }, notice: 'The draft changed since this was designed. Here is what applying it does now; nothing was saved.' });
        return;
      }
      const smoke = await saveChange(agentId, turn.design.config, `Hello ${name}, what can you do?`);
      patch(turn.id, { state: 'saved', smoke });
    } catch (e) {
      patch(turn.id, { state: 'failed', error: (e as Error).message });
    }
  };

  // AG09: Test again runs the draft as it is now and saves nothing.
  const testAgain = async (turn: Turn) => {
    if (turn.smoke?.state === 'testing') return;
    patch(turn.id, { smoke: { state: 'testing' } });
    patch(turn.id, { smoke: await testDraft(agentId, `Hello ${name}, what can you do?`) });
  };

  const publish = async (turn: Turn) => {
    if (turn.smoke?.state !== 'passed' || turn.publish?.state === 'publishing') return;
    patch(turn.id, { publish: { state: 'publishing' } });
    const result = await publishChange(agentId);
    patch(turn.id, { publish: result });
    announceChange(agentId);
  };

  if (view === 'ask') {
    const back = (
      <span className="flex min-w-0 items-center gap-2">
        {heading}
        <button type="button" onClick={() => { setAsking(undefined); setView('change'); }} className="shrink-0 text-[12px] font-medium text-ac hover:underline max-md:min-h-11">
          Change it instead
        </button>
      </span>
    );
    return <AskPanel onClose={onClose} conversation={conversation} subject={tag} {...(asking && { request: asking })} heading={back} {...(model && { model })} starters={starters ?? []} />;
  }

  return (
    <ChatMotion>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hair px-3 text-[12px] text-t2 max-md:hidden">
          {heading}
          <button type="button" onClick={() => setTurns([])} disabled={!turns.length} className={cn(CHAT_ICON_BUTTON, 'ml-auto disabled:opacity-30')} title="Clear" aria-label="Clear">
            <SquarePen className="size-3.5" />
          </button>
          <button type="button" onClick={onClose} className={CHAT_ICON_BUTTON} title="Close (⌘K)" aria-label="Close Spotlight">
            <X className="size-3.5" />
          </button>
        </div>
        {turns.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto py-6">
            <ChatEmpty
              title={`Change ${name}`}
              help="Say what to change and read what would change before it is saved to its draft. Ask a question and the brain answers it; nothing is applied."
              starters={['Why does it have those tools?', 'Make its answers shorter']}
              onStarter={send}
            />
          </div>
        ) : (
          <ChatList className="min-h-0 flex-1 space-y-4 px-3 py-3">
            {turns.map((t) => (
              <div key={t.id} className="space-y-2.5">
                <UserBubble>{t.message}</UserBubble>
                {t.state === 'designing' && (
                  <p role="status" className="flex items-center gap-1.5 text-[12px] text-t3">
                    <Loader2 className="size-3.5 animate-spin" /> Designing the change to “{name}”…
                  </p>
                )}
                {t.state === 'dismissed' && <p className="text-[12px] text-t3">Dismissed: nothing was changed.</p>}
                {t.state === 'failed' && !t.design && (
                  <>
                    <ChatError message={`Couldn’t design the change: ${t.error ?? ''}`} />
                    <Button size="sm" variant="ghost" disabled={designing} onClick={() => { setTurns((all) => all.filter((x) => x.id !== t.id)); void change(t.message); }} className="max-md:h-11 max-md:px-4">
                      Try again
                    </Button>
                  </>
                )}
                {t.design && t.state !== 'dismissed' && <ChangeCard name={name} agentId={agentId} turn={t} onApply={() => void apply(t)} onPublish={() => void publish(t)} onDismiss={() => patch(t.id, { state: 'dismissed' })} onTest={() => void testAgain(t)} />}
              </div>
            ))}
          </ChatList>
        )}
        <div className="shrink-0 border-t border-hair p-2.5 max-md:border-0 max-md:pt-1">
          <ChatComposer
            id={ASK_INPUT}
            inputRef={box}
            className="border-bd bg-sf"
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={() => abort.current?.abort()}
            busy={designing}
            placeholder={`Ask for a change to ${name}, or ask about it`}
            label="Change this agent"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
      </div>
    </ChatMotion>
  );
}
