'use client';
/**
 * The editor's "…" menu in the top bar: settings, tags, version history, Git history (its dialog says when source
 * control is not set up), share, move (those three need a saved workflow), download as JSON, save as template, one Import… (a paste box and a file drop, Landflow or
 * n8n) and the keyboard shortcuts. The items are listed by `menuItems` (./chrome).
 */
import { useState } from 'react';
import { ArrowRightLeft, Download, FileUp, GitCommitHorizontal, History, Keyboard, LayoutTemplate, MoreHorizontal, Settings2, Share2, Tag } from 'lucide-react';
import { toast } from 'sonner';
import { MoveToProjectDialog, ShareDialog } from '../projects/share-dialog';
import { SaveTemplateDialog } from '../templates/save-template-dialog';
import { Button } from '../ui/button';
import { MenuItem, MenuSeparator, Popover } from '../ui/popover';
import { GitHistoryDialog } from './git-history';
import { menuItems } from './chrome';
import { ImportDialog } from './import-dialog';
import { SettingsDialog } from './settings-dialog';
import { useShortcuts } from './shortcuts-dialog';
import { useEditor } from './store';
import { TagsDialog } from './tags-editor';
import { useVersionHistory } from './version-history';

/** File name for a workflow download: "Order sync" → "order-sync.json". */
export function workflowFileName(name: string) {
  return `${name.trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'}.json`;
}

/** Save the open workflow (including unsaved edits) as a JSON file. Ids and run-time fields are left for the importer to replace. */
function download() {
  const { id: _id, active: _active, createdAt: _created, updatedAt: _updated, folderId: _folder, ...workflow } = useEditor.getState().toWorkflow();
  const blob = new Blob([JSON.stringify({ ...workflow, meta: { exportedFrom: 'landflow', exportedAt: new Date().toISOString() } }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: workflowFileName(workflow.name) });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${link.download}`);
}

export function WorkflowMenu({ onSave }: { onSave: () => Promise<boolean> }) {
  const [dialog, setDialog] = useState<'settings' | 'tags' | 'import' | 'share' | 'move' | 'template' | 'git'>();
  const workflowId = useEditor((s) => s.workflowId);
  const name = useEditor((s) => s.name);
  const tagCount = useEditor((s) => s.tags.length);
  const shown = menuItems({ saved: Boolean(workflowId) });
  return (
    <>
      <Popover
        trigger={({ open, toggle }) => (
          <Button variant={open ? 'outline' : 'ghost'} size="icon" onClick={toggle} aria-label="Workflow menu" title="More" aria-expanded={open}>
            <MoreHorizontal className="size-4" />
          </Button>
        )}
        className="min-w-[230px]"
      >
        {(close) => {
          const item = (fn: () => void) => () => {
            close();
            fn();
          };
          return (
            <>
              <MenuItem onClick={item(() => setDialog('settings'))}>
                <Settings2 /> Settings
              </MenuItem>
              <MenuItem onClick={item(() => setDialog('tags'))} hint={tagCount ? String(tagCount) : undefined}>
                <Tag /> Tags…
              </MenuItem>
              <MenuItem onClick={item(() => useVersionHistory.getState().setOpen(true))}>
                <History /> Version history
              </MenuItem>
              {shown.includes('git-history') && (
                <MenuItem onClick={item(() => setDialog('git'))}>
                  <GitCommitHorizontal /> Git history…
                </MenuItem>
              )}
              {shown.includes('share') && (
                <>
                  <MenuItem onClick={item(() => setDialog('share'))}>
                    <Share2 /> Share…
                  </MenuItem>
                  <MenuItem onClick={item(() => setDialog('move'))}>
                    <ArrowRightLeft /> Move to project…
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              <MenuItem onClick={item(download)}>
                <Download /> Download JSON
              </MenuItem>
              <MenuItem onClick={item(() => setDialog('template'))}>
                <LayoutTemplate /> Save as template…
              </MenuItem>
              <MenuItem onClick={item(() => setDialog('import'))} hint="Landflow, n8n">
                <FileUp /> Import…
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={item(() => useShortcuts.getState().setOpen(true))} hint="?">
                <Keyboard /> Keyboard shortcuts
              </MenuItem>
            </>
          );
        }}
      </Popover>
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(undefined)} onSave={onSave} />}
      {dialog === 'tags' && <TagsDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'git' && workflowId && <GitHistoryDialog workflowId={workflowId} onClose={() => setDialog(undefined)} />}
      {dialog === 'share' && <ShareDialog kind="workflow" id={workflowId} name={name} onClose={() => setDialog(undefined)} />}
      {dialog === 'move' && <MoveToProjectDialog kind="workflow" id={workflowId} name={name} onClose={() => setDialog(undefined)} />}
      {dialog === 'template' && <SaveTemplateDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(undefined)} />}
    </>
  );
}
