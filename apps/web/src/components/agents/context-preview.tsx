'use client';
/**
 * What an agent will be given in a project: the "Where this work fits" block in its Project context mode, and the approved
 * practices it follows, exactly as a run would get them (GET /api/agents/:id/context-preview). Reads only. On a phone the
 * preview opens in the shared dialog, which is a bottom sheet there.
 */
import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { api } from '@/lib/client/api';
import { CONTEXT_MODE_LABELS } from '@/lib/shared/project-context';
import { Button } from '../ui/button';
import { Dialog } from './dialog';
import { injectedText, previewUrl, type ContextPreviewAnswer } from './project-names';

/** The preview of one project (the agent's home without `projectId`); `undefined` while loading, an error message when it fails. */
export function useContextPreview(agentId: string, projectId: string | undefined, enabled = true, key = ''): { preview?: ContextPreviewAnswer; error?: string } {
  const [state, setState] = useState<{ preview?: ContextPreviewAnswer; error?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // A short pause: the settings switches autosave, and the preview reads the saved agent.
    const timer = setTimeout(() => {
      api<ContextPreviewAnswer>(previewUrl(agentId, projectId))
        .then((preview) => live && setState({ preview }))
        .catch((e: Error) => live && setState({ error: e.message }));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [agentId, projectId, enabled, key]);
  return state;
}

/** The two blocks and their handles (the body of the sheet; the sheet needs a browser). */
export function ContextPreviewBody({ preview, error }: { preview?: ContextPreviewAnswer; error?: string }) {
  if (error) return <p role="alert" className="text-[13px] text-rd">Couldn’t build the preview: {error}</p>;
  if (!preview) return <p className="text-[13px] text-t3">Loading…</p>;
  const text = injectedText(preview);
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-snug text-t3">
        Project context: <strong className="text-t2">{CONTEXT_MODE_LABELS[preview.mode]}</strong>.{' '}
        {preview.mode === 'off' ? 'The agent gets no project block.' : 'The block is added to the system prompt of each run.'}
      </p>
      {preview.practices.list.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Practices it will follow">
          {preview.practices.list.map((p) => (
            <li key={`${p.handle}@${p.version}`} className="rounded-full border border-hair bg-wl px-2.5 py-0.5 font-mono text-[11px] text-t2">
              {p.handle}@{p.version}
            </li>
          ))}
        </ul>
      )}
      {text ? (
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-hair bg-wl p-3 font-mono text-[12px] leading-[1.6] text-t2" tabIndex={0} aria-label="What the agent will be given">
          {text}
        </pre>
      ) : (
        <p className="rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] text-t3">Nothing to add: this project has no goal or brief for the agent, and no practices apply.</p>
      )}
    </div>
  );
}

/** A button that opens the preview of a project for an agent. */
export function ContextPreviewButton({ agentId, projectId, projectName, settingsKey }: { agentId: string; projectId?: string; projectName?: string; settingsKey?: string }) {
  const [open, setOpen] = useState(false);
  const state = useContextPreview(agentId, projectId, open, settingsKey);
  return (
    <>
      <Button size="sm" variant="ghost" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Eye className="size-3.5" /> What it will be given
      </Button>
      {open && (
        <Dialog title="What the agent will be given" subtitle={projectName ? `In ${projectName}` : 'In its home project'} onClose={() => setOpen(false)} width={640}>
          <ContextPreviewBody {...state} />
        </Dialog>
      )}
    </>
  );
}
