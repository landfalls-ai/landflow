/**
 * The editor's chrome as plain functions (docs/features/editor.md): which one panel the right column shows, when a
 * draft saves itself, when the minimap shows, which controls the top bar and the ⋯ menu hold. The editor and its menu
 * read these; test/editor-chrome.test.ts checks them in node.
 */
import { create } from 'zustand';

/** The right column holds one panel: Spotlight, the flow chat, or neither (chat closed, Spotlight folded to its strip). */
export type ChatColumn = 'spotlight' | 'chat' | null;

/** What changes the column: the Execute bar's chat button, the chat's close button, ⌘I and the Spotlight | Chat strip. */
export type ColumnAction = 'open-chat' | 'close-chat' | 'toggle-chat' | 'show-spotlight' | 'show-chat';

/** The column after an action. Never both: one value holds one panel. */
export function chatColumnAfter(state: ChatColumn, action: ColumnAction): ChatColumn {
  switch (action) {
    case 'open-chat':
    case 'show-chat':
      return 'chat';
    case 'show-spotlight':
      return 'spotlight';
    case 'close-chat':
      return state === 'chat' ? 'spotlight' : state;
    case 'toggle-chat':
      return state === 'chat' ? 'spotlight' : 'chat';
  }
}

/** The panel to show: the chat only while the workflow still has a chat trigger. */
export function visibleColumn(state: ChatColumn, hasChat: boolean): ChatColumn {
  return state === 'chat' && !hasChat ? 'spotlight' : state;
}

/** The Spotlight | Chat strip: a workflow with a chat trigger, and a column that is open (not Spotlight folded to its strip). */
export function showColumnSwitch({ hasChat, column, spotlightFolded }: { hasChat: boolean; column: ChatColumn; spotlightFolded: boolean }): boolean {
  return hasChat && (column === 'chat' || !spotlightFolded);
}

export const useChatColumn = create<{ column: ChatColumn; apply(action: ColumnAction): void }>((set) => ({
  column: null,
  apply: (action) => set((s) => ({ column: chatColumnAfter(s.column, action) })),
}));

/** Autosave waits this long after the last edit. */
export const AUTOSAVE_MS = 2000;

/**
 * A draft saves itself when it has unsaved changes, this tab can edit (not read-only, and holds the edit lock) and the
 * save needs nobody's approval. `governed` is a save that waits for approval: it keeps its Save button.
 */
export function shouldAutosave({ dirty, readOnly, governed, locked }: { dirty: boolean; readOnly: boolean; governed: boolean; locked: boolean }): boolean {
  return dirty && !readOnly && !governed && locked;
}

/** The minimap earns its room only on a big flow. */
export const MINIMAP_ABOVE = 25;
export const showMinimap = (nodeCount: number): boolean => nodeCount > MINIMAP_ABOVE;

export type TopBarControl = 'back' | 'name' | 'save-state' | 'save' | 'spotlight' | 'run' | 'publish' | 'more';

/** The top bar, left to right: seven controls, and Save only where autosave is off. (The tabs are navigation, not a control.) */
export function topBarControls({ governed }: { governed: boolean }): TopBarControl[] {
  const controls: TopBarControl[] = ['back', 'name', 'save-state'];
  if (governed) controls.push('save');
  controls.push('spotlight', 'run', 'publish', 'more');
  return controls;
}

export type MenuItemId = 'settings' | 'tags' | 'version-history' | 'git-history' | 'share' | 'move' | 'download' | 'template' | 'import' | 'shortcuts';

/** The ⋯ menu: Git history only when source control is configured; Share and Move need a saved workflow. */
export function menuItems({ sourceControl, saved }: { sourceControl: boolean; saved: boolean }): MenuItemId[] {
  return [
    'settings',
    'tags',
    'version-history',
    ...(sourceControl ? (['git-history'] as const) : []),
    ...(saved ? (['share', 'move'] as const) : []),
    'download',
    'template',
    'import',
    'shortcuts',
  ];
}

/** What the Publish button says: "Publish" for a draft, "Live v3" once a version is live (a dot beside it marks unpublished changes). */
export function publishLabel({ published, versionNumber }: { published: boolean; versionNumber?: number }): string {
  if (!published) return 'Publish';
  return versionNumber ? `Live v${versionNumber}` : 'Live';
}

/**
 * The model that answers in the flow chat: the one chat-model node wired to an AI node (`ai_languageModel`), by its
 * `model` parameter. None when there are several (or a model set by an expression), so the chip never guesses.
 */
export function chatModelOf(
  nodes: Array<{ id: string; type: string; parameters: Record<string, unknown> }>,
  edges: Array<{ source: string; connectionType?: string }>,
): { model: string; local: boolean } | undefined {
  const sources = new Set(edges.filter((e) => e.connectionType === 'ai_languageModel').map((e) => e.source));
  const models = nodes.filter((n) => sources.has(n.id)).map((n) => ({ model: n.parameters.model, local: /ollama/i.test(n.type) }));
  const named = models.filter((m): m is { model: string; local: boolean } => typeof m.model === 'string' && m.model.trim() !== '' && !m.model.includes('{{'));
  const distinct = new Set(named.map((m) => `${m.model}|${m.local}`));
  return named.length === models.length && distinct.size === 1 ? named[0] : undefined;
}
