'use client';
/**
 * Spotlight in the Brain workbench is Ask the brain (docs/second-brain.md#the-brain-page): the conversation lives in
 * `ask-panel.tsx`, docked beside the page. This file keeps the names importers know: the open file Spotlight is asked
 * from, the questions it suggests, and `BrainSpotlight`, which shows the panel.
 */
import type { AskConversation } from './ask-panel';
import { ASK_INPUT, AskPanel } from './ask-panel';

export const SPOTLIGHT_INPUT = ASK_INPUT;

/** The open file, as Spotlight knows it: a page (asked about), or index/log (asked about everything). */
export interface SpotlightFile {
  ref: string;
  name: string;
  page: boolean;
  /** For the starters: the busiest shared page, when the file is the index. */
  topShared?: string;
}

/** Questions to start from, about the open file. */
export function bubblesFor(file?: SpotlightFile): string[] {
  if (file?.page) return [`What is the latest on ${file.name}?`, `Who else works on ${file.name}?`, `Is any team duplicating ${file.name}?`];
  return [file?.topShared ? `Who is working on ${file.topShared}, and from which teams?` : 'Which customers did more than one team work on?', 'What changed this week?', 'Which initiatives have no owner?'];
}

/** The panel, asked from the open file (about the page unless its chip is removed). */
export function BrainSpotlight({ file, onClose, conversation, model }: { file?: SpotlightFile; onClose: () => void; conversation?: AskConversation; model?: string }) {
  return <AskPanel {...(file?.page && { about: { ref: file.ref, name: file.name } })} onClose={onClose} {...(conversation && { conversation })} {...(model && { model })} starters={bubblesFor(file)} />;
}

/** Put the caret in the Ask box (when it is open). */
export function focusBrainSpotlight() {
  document.getElementById(SPOTLIGHT_INPUT)?.focus();
}
