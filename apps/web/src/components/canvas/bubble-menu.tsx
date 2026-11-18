'use client';
/**
 * AG16 (wave ag4): a bubble's menu (a click or Enter on it), and what it opens. *Open on <agent>'s page* (a new tab at the
 * ability), *Change…* (the agent page's own dialog for that tool, or a model or memory choice), *Remove from <agent>*, and
 * *Pick a credential* when the tool has none (the agent page's tool dialog in a new tab: a person picks, Spotlight never does,
 * D2). Every edit changes the agent's DRAFT through lib/client/agent-edit.ts: never the flow, live after Publish. When more than
 * one workflow runs the agent the edit asks first ("Alert triager runs in 2 workflows: this changes both"). A version view
 * (`readOnly`) offers only the agent's page.
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmChange, toastEdit, usedByWords } from './bubble-confirm';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { MenuItem, MenuSeparator } from '../ui/popover';
import { loadModelChoices, removeFromAgent, setAgentMemory, setAgentModel, toolIdOfBubble, type ModelChoice } from '@/lib/client/agent-edit';
import { agentLink } from '@/lib/client/agent-bubble-data';
import { readDraft } from '@/lib/client/agent-change';
import type { Bubble } from '@/lib/shared/agent-bubbles';
import { cn } from '@/lib/utils';

const openOf = (b: Bubble) => (b.slot === 'model' ? 'model' : b.slot === 'memory' ? 'memory' : 'capabilities');

export type BubbleAction = 'change' | 'remove';

/** The menu's items. `act` closes the menu and hands the choice to the node, which owns the dialogs (a menu's panel goes with it). */
export function BubbleMenu({
  agentId,
  agentName,
  bubble,
  readOnly,
  version,
  act,
  close,
}: {
  agentId: string;
  agentName: string;
  bubble: Bubble;
  workflowId?: string;
  usedBy?: ReadonlyArray<{ workflowId: string; name: string }>;
  readOnly?: boolean;
  version?: number;
  act: (action: BubbleAction) => void;
  close: () => void;
}) {
  const toolId = toolIdOfBubble(bubble.id);
  const page = (
    <MenuItem
      onClick={() => {
        close();
        window.open(agentLink(agentId, openOf(bubble), toolId), '_blank', 'noopener');
      }}
    >
      <ExternalLink /> Open on {agentName}’s page{version !== undefined ? ` (now)` : ''}
    </MenuItem>
  );
  if (readOnly) return page;
  const removed = bubble.pending === 'removed';
  return (
    <>
      {page}
      {bubble.credential === 'missing' && toolId && (
        <MenuItem
          onClick={() => {
            close();
            window.open(agentLink(agentId, 'capabilities', toolId), '_blank', 'noopener');
          }}
        >
          <KeyRound /> Pick a credential
        </MenuItem>
      )}
      {!removed && (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              close();
              act('change');
            }}
          >
            <Pencil /> Change…
          </MenuItem>
          {/* The model and memory are always the agent's: a memory is changed, not removed; a model is replaced. */}
          {bubble.slot === 'tool' && (
            <MenuItem
              danger
              onClick={() => {
                close();
                act('remove');
              }}
            >
              <Trash2 /> Remove from {agentName}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
}

const ToolDialogs = lazy(() => import('./bubble-tool-dialogs'));

/** What a menu choice opens: a confirm when more than this workflow runs the agent, then the edit or its dialog. */
export function BubbleActions({
  agentId,
  agentName,
  bubble,
  usedBy,
  action,
  onDone,
}: {
  agentId: string;
  agentName: string;
  bubble: Bubble;
  usedBy?: ReadonlyArray<{ workflowId: string; name: string }>;
  action: BubbleAction;
  onDone: () => void;
}) {
  const words = usedByWords(agentName, usedBy);
  // A removal confirms only when it touches several workflows; Change opens its own dialog first, and confirms on Save.
  const [confirmed, setConfirmed] = useState(!words);
  const toolId = toolIdOfBubble(bubble.id);

  if (action === 'remove') {
    if (!confirmed && words) return <ConfirmChange words={words} onCancel={onDone} onConfirm={() => setConfirmed(true)} />;
    return <Remove agentId={agentId} agentName={agentName} bubble={bubble} toolId={toolId} onDone={onDone} />;
  }
  if (bubble.slot === 'model') return <ModelChange agentId={agentId} agentName={agentName} words={words} onDone={onDone} />;
  if (bubble.slot === 'memory') return <MemoryChange agentId={agentId} agentName={agentName} words={words} onDone={onDone} />;
  return (
    <Suspense fallback={null}>
      <ToolDialogs agentId={agentId} agentName={agentName} toolId={toolId} words={words} onDone={onDone} />
    </Suspense>
  );
}

/** Run an edit once, say what it did, then finish. */
function useOnce(run: () => Promise<void>, onDone: () => void) {
  useEffect(() => {
    let live = true;
    void run()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => live && onDone());
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function Remove({ agentId, agentName, bubble, toolId, onDone }: { agentId: string; agentName: string; bubble: Bubble; toolId?: string; onDone: () => void }) {
  useOnce(async () => {
    if (!toolId) return;
    const { smoke } = await removeFromAgent(agentId, toolId);
    toastEdit(agentName, `Removed ${bubble.label} from`, smoke);
  }, onDone);
  return null;
}

/** A list of choices in a dialog, the current one marked. */
function Choices({ title, subtitle, children, onClose }: { title: string; subtitle?: ReactNode; children: ReactNode; onClose: () => void }) {
  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose} width={460} footer={<Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>}>
      <div className="flex flex-col gap-1">{children}</div>
    </Dialog>
  );
}

const choiceClass = (current: boolean) => cn('flex w-full flex-col rounded-xl border px-3 py-2 text-left text-[13px] transition-colors hover:bg-acdim max-md:min-h-11', current ? 'border-acbd bg-acdim' : 'border-hair');

function ModelChange({ agentId, agentName, words, onDone }: { agentId: string; agentName: string; words?: string; onDone: () => void }) {
  const [choices, setChoices] = useState<ModelChoice[]>();
  const [current, setCurrent] = useState<string>();
  const [picked, setPicked] = useState<ModelChoice>();
  useEffect(() => {
    let live = true;
    void readDraft(agentId).then(async (draft) => {
      const model = draft?.model as { provider?: string; model?: string } | undefined;
      const list = await loadModelChoices(model);
      if (!live) return;
      setCurrent(model?.model);
      setChoices(list);
    });
    return () => {
      live = false;
    };
  }, [agentId]);
  if (picked && words) return <ConfirmChange words={words} onCancel={onDone} onConfirm={() => void apply(picked)} />;
  async function apply(choice: ModelChoice) {
    onDone();
    try {
      const { smoke } = await setAgentModel(agentId, choice);
      toastEdit(agentName, `Set the model of`, smoke);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Choices title={`Change ${agentName}’s model`} subtitle="The agent’s model, in its draft" onClose={onDone}>
      {!choices && <p className="text-[13px] text-t3">Loading the models…</p>}
      {choices?.length === 0 && <p className="text-[13px] text-t3">No models could be listed here: set it on the agent’s page.</p>}
      {choices?.map((c) => (
        <button key={`${c.provider}/${c.model}`} type="button" className={choiceClass(c.model === current)} onClick={() => (words ? setPicked(c) : void apply(c))}>
          <span className="font-semibold text-t1">{c.label}</span>
          <span className="text-[12px] text-t3">{c.provider}{c.description ? ` · ${c.description}` : ''}</span>
        </button>
      ))}
    </Choices>
  );
}

function MemoryChange({ agentId, agentName, words, onDone }: { agentId: string; agentName: string; words?: string; onDone: () => void }) {
  const [picked, setPicked] = useState<boolean>();
  async function apply(crossSession: boolean) {
    onDone();
    try {
      const { smoke } = await setAgentMemory(agentId, crossSession);
      toastEdit(agentName, 'Set the memory of', smoke);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  if (picked !== undefined && words) return <ConfirmChange words={words} onCancel={onDone} onConfirm={() => void apply(picked)} />;
  const choose = (v: boolean) => (words ? setPicked(v) : void apply(v));
  return (
    <Choices title={`Change ${agentName}’s memory`} subtitle="What the agent remembers" onClose={onDone}>
      <button type="button" className={choiceClass(false)} onClick={() => choose(false)}>
        <span className="font-semibold text-t1">This conversation</span>
        <span className="text-[12px] text-t3">It remembers what was said in the current conversation only</span>
      </button>
      <button type="button" className={choiceClass(false)} onClick={() => choose(true)}>
        <span className="font-semibold text-t1">Across sessions</span>
        <span className="text-[12px] text-t3">It keeps notes about each person between conversations</span>
      </button>
    </Choices>
  );
}
