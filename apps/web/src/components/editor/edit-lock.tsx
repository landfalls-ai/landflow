'use client';
/**
 * The editor's edit lock (lib/server/auth/edit-locks.ts): one tab at a time edits a workflow. This tab asks for the
 * lock when the editor opens and heartbeats every 10 s; when someone else holds it, the canvas is read-only (the
 * store's editing actions become no-ops) and a banner says who is editing, with Take over for admins (or for you,
 * from your other tab). The lock is released when the tab closes, and `lock` events on /api/events hand it to the
 * next tab straight away. Saves carry the tab id (`x-landflow-editor-tab`), so a tab that lost the lock gets a 423.
 */
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { Eye, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type { EdgeChange, NodeChange } from '@xyflow/react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import { can, type EditLockView } from '@/lib/shared/auth';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { useViewer } from '@/components/auth/viewer';
import { Button } from '@/components/ui/button';
import { useEditor, type CanvasNode, type FlowEdge } from './store';

export const EDITOR_TAB_HEADER = 'x-landflow-editor-tab';

function newTabId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `tab_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface LockState {
  tabId: string;
  workflowId?: string;
  /** Someone else (or this user's other tab) holds the lock: the canvas is read-only. */
  readOnly: boolean;
  /** Who holds it when it isn't this tab. */
  holder?: EditLockView;
}

export const useEditLock = create<LockState>(() => ({ tabId: newTabId(), readOnly: false }));

/** Headers for a save from this tab. */
export const editorTabHeaders = (): Record<string, string> => ({ [EDITOR_TAB_HEADER]: useEditLock.getState().tabId });

// ---- read-only: the store's editing actions become no-ops ------------------------------------------------------

type Editing = Pick<
  ReturnType<typeof useEditor.getState>,
  | 'onNodesChange'
  | 'onEdgesChange'
  | 'onConnect'
  | 'addNode'
  | 'placeNode'
  | 'setPinData'
  | 'applyTemplate'
  | 'replaceGraph'
  | 'tidyUp'
  | 'updateNode'
  | 'renameNode'
  | 'removeNodes'
  | 'duplicateNode'
  | 'duplicateSelection'
  | 'paste'
  | 'mergeWorkflow'
  | 'addSticky'
  | 'updateSticky'
  | 'undo'
  | 'redo'
  | 'setMeta'
  | 'setSettings'
  | 'openPalette'
>;

let saved: Editing | undefined;

function setReadOnly(on: boolean) {
  if (on && !saved) {
    const state = useEditor.getState();
    const original: Editing = {
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
      addNode: state.addNode,
      placeNode: state.placeNode,
      setPinData: state.setPinData,
      applyTemplate: state.applyTemplate,
      replaceGraph: state.replaceGraph,
      tidyUp: state.tidyUp,
      updateNode: state.updateNode,
      renameNode: state.renameNode,
      removeNodes: state.removeNodes,
      duplicateNode: state.duplicateNode,
      duplicateSelection: state.duplicateSelection,
      paste: state.paste,
      mergeWorkflow: state.mergeWorkflow,
      addSticky: state.addSticky,
      updateSticky: state.updateSticky,
      undo: state.undo,
      redo: state.redo,
      setMeta: state.setMeta,
      setSettings: state.setSettings,
      openPalette: state.openPalette,
    };
    saved = original;
    const nothing = () => {};
    useEditor.setState({
      // Selecting and React Flow measuring nodes still work; moving, resizing and deleting don't.
      onNodesChange: (changes: NodeChange<CanvasNode>[]) => original.onNodesChange(changes.filter((c) => c.type === 'select' || (c.type === 'dimensions' && c.resizing === undefined))),
      onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => original.onEdgesChange(changes.filter((c) => c.type === 'select')),
      onConnect: nothing,
      addNode: () => undefined,
      placeNode: () => undefined,
      setPinData: nothing,
      applyTemplate: nothing,
      replaceGraph: () => nothing,
      tidyUp: nothing,
      updateNode: nothing,
      renameNode: () => false,
      removeNodes: nothing,
      duplicateNode: nothing,
      duplicateSelection: nothing,
      paste: () => 0,
      mergeWorkflow: () => 0,
      addSticky: () => '',
      updateSticky: nothing,
      undo: nothing,
      redo: nothing,
      setMeta: nothing,
      setSettings: nothing,
      openPalette: nothing,
    });
  } else if (!on && saved) {
    useEditor.setState(saved);
    saved = undefined;
  }
  useEditLock.setState({ readOnly: on });
}

/** Load the saved workflow again (someone else may have changed it while this tab was read-only). */
async function reload(workflowId: string) {
  const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`);
  const nodeTypes = Object.values(useEditor.getState().nodeTypes) as NodeTypeInfo[];
  useEditor.getState().load(workflow, nodeTypes);
  return workflow;
}

type LockResponse = { mine: boolean; lock: EditLockView; heartbeatMs: number };

/**
 * Hold (or wait for) the workflow's edit lock while the editor is open. Returns `takeOver`, for the banner.
 */
export function useEditLockSync(workflowId: string, loaded: boolean) {
  const sync = useCallback(
    async (takeover = false) => {
      const { tabId, readOnly } = useEditLock.getState();
      const { mine, lock } = await api<LockResponse>(`/api/workflows/${workflowId}/lock`, { method: 'POST', json: { tabId, ...(takeover && { takeover: true }) } });
      if (mine) {
        if (readOnly) {
          // Back to editing: start from what's saved, then allow edits.
          await reload(workflowId);
          setReadOnly(false);
        }
        useEditLock.setState({ holder: undefined });
        return;
      }
      if (!readOnly) {
        const dirty = useEditor.getState().dirty;
        setReadOnly(true);
        if (useEditLock.getState().holder === undefined && dirty) toast.warning(`${lock.userName} is editing this workflow now: your unsaved changes can’t be saved`);
      }
      useEditLock.setState({ holder: lock });
    },
    [workflowId],
  );

  // Ask for the lock when the workflow has loaded, heartbeat, and release it when the editor closes.
  useEffect(() => {
    if (!loaded) return;
    useEditLock.setState({ workflowId });
    let stopped = false;
    let lastSeen: string | undefined;
    const beat = async () => {
      try {
        await sync();
        // Read-only tabs follow the editor's saves.
        if (useEditLock.getState().readOnly && !stopped) {
          const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`);
          if (lastSeen && workflow.updatedAt !== lastSeen) await reload(workflowId);
          lastSeen = workflow.updatedAt;
        }
      } catch {
        // Offline for a moment: the next beat tries again (the lock outlives a missed beat).
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), 10_000);
    const release = () => {
      const { tabId, readOnly } = useEditLock.getState();
      if (!readOnly) void fetch(`/api/workflows/${workflowId}/lock?tabId=${encodeURIComponent(tabId)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', release);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('pagehide', release);
      release();
      setReadOnly(false);
      useEditLock.setState({ workflowId: undefined, holder: undefined });
    };
  }, [loaded, workflowId, sync]);

  // Freed or taken over: react straight away instead of at the next heartbeat.
  useLiveEvents((event) => {
    if (event.channel !== 'lock' || event.workflowId !== workflowId || !loaded) return;
    const { tabId, readOnly } = useEditLock.getState();
    if (!event.lock && readOnly) void sync().catch(() => {});
    else if (event.lock && event.lock.tabId !== tabId) {
      if (!readOnly) toast.warning(`${event.lock.userName} took over editing this workflow`);
      void sync().catch(() => {});
    }
  });

  return {
    takeOver: () =>
      sync(true)
        .then(() => toast.success('You’re editing this workflow'))
        .catch((e: Error) => toast.error(e.message)),
  };
}

/** Under the editor's top bar while someone else is editing: who, since when, and Take over. */
export function EditLockBanner({ onTakeOver }: { onTakeOver: () => void }) {
  const viewer = useViewer();
  const readOnly = useEditLock((s) => s.readOnly);
  const holder = useEditLock((s) => s.holder);
  if (!readOnly || !holder) return null;
  const yours = holder.userId === viewer?.id;
  const canTakeOver = yours || can(viewer, 'workflows:takeover');
  return (
    <div role="status" className="flex h-10 shrink-0 items-center gap-2.5 border-b border-warnbd bg-warndim px-4 text-[13px] animate-fade-up">
      {yours ? <Eye className="size-3.5 text-warn" /> : <Lock className="size-3.5 text-warn" />}
      <span className="text-t1">
        {yours ? (
          'You’re editing this workflow in another tab'
        ) : (
          <>
            <span className="font-semibold">{holder.userName}</span> is editing
          </>
        )}
      </span>
      <span className="text-[12px] text-t3">opened {timeAgo(holder.since)} · read-only here</span>
      {canTakeOver && (
        <Button size="sm" variant="primary" className="ml-auto" onClick={onTakeOver} title={yours ? 'Edit here instead' : `Take over from ${holder.userName}: their unsaved changes are lost`}>
          {yours ? 'Edit here' : 'Take over'}
        </Button>
      )}
    </div>
  );
}
