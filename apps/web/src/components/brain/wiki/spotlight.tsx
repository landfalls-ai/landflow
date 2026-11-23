/**
 * What the app's one Spotlight (components/spotlight/shell-spotlight.tsx) needs from the Brain workbench when it asks the
 * brain (docs/second-brain.md#the-brain-page): the open file it is asked from, and the questions it suggests. The
 * conversation itself is `ask-panel.tsx`, opened by the shell.
 */

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
