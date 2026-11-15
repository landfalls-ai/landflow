'use client';
/**
 * `?ask=proposal:<id>` on the editor (docs/second-brain.md#build-it-with-spotlight): "Build it" on a suggestion opens a
 * new workflow with this parameter. The editor loads the suggestion, Spotlight sends its build prompt as the person's
 * message once (the click on Build it was theirs), and the parameter leaves the URL so a reload doesn't send it again.
 * No schema here: this module reaches the browser, and the request is a plain GET.
 */
import { useEffect, useRef } from 'react';
import { api } from '@/lib/client/api';
import { useBuildFlow } from '../ai-builder';
import { useAssistant } from '../assistant';
import { useEditor } from '../store';
import { draftWholeFlow } from './draft-flow';

const PREFIX = 'proposal:';

/** The suggestion id in a query string's `ask` parameter, or undefined (anything but `proposal:<id>` is ignored). */
export function parseAsk(search: string): string | undefined {
  const value = new URLSearchParams(search).get('ask');
  if (!value?.startsWith(PREFIX)) return undefined;
  const id = value.slice(PREFIX.length).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

/** The query string without `ask`, keeping the rest (`''` when nothing is left). */
export function withoutAsk(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('ask');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * The build prompt to send, or undefined. Only the workflow Build it created for this suggestion may send it: an applied
 * suggestion whose `createdWorkflowId` is this workflow. Any other link (`?ask=` on someone else's workflow) is dropped.
 */
export function promptToSend(proposal: { status?: string; createdWorkflowId?: string; buildPrompt?: string }, workflowId: string): string | undefined {
  if (proposal.status !== 'applied' || proposal.createdWorkflowId !== workflowId) return undefined;
  return proposal.buildPrompt?.trim() || undefined;
}

/**
 * Sends the suggestion's build prompt once the editor holds its workflow, and only on an empty canvas, where it drafts
 * the whole flow (as the first message does). A canvas with nodes means the prompt already ran (a link opened again
 * later), so nothing is sent. `ready` is true once the workflow has loaded.
 */
export function useAskParam(ready: boolean) {
  const { build } = useBuildFlow();
  const done = useRef(false);
  const workflowId = useEditor((s) => s.workflowId);
  useEffect(() => {
    if (!ready || !workflowId || done.current || typeof window === 'undefined') return;
    const id = parseAsk(window.location.search);
    if (!id) return;
    done.current = true;
    // Out of the URL first: a reload or Back must not send it again.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${withoutAsk(window.location.search)}${window.location.hash}`);
    void (async () => {
      let prompt: string | undefined;
      try {
        prompt = promptToSend((await api<{ proposal: { status?: string; createdWorkflowId?: string; buildPrompt?: string } }>(`/api/proposals/${encodeURIComponent(id)}`, { background: true })).proposal, workflowId);
      } catch {
        return;
      }
      if (!prompt || useAssistant.getState().pending || useAssistant.getState().drafting) return;
      if (useEditor.getState().nodes.length) return;
      useAssistant.getState().setCollapsed(false);
      await draftWholeFlow(prompt, build);
    })();
  }, [ready, workflowId, build]);
}
