/**
 * Citations (docs/practices.md#citations-and-verified): a citation is verified only where its excerpt is in the text of
 * the file a trusted flow read at that commit. A caller's say-so never counts.
 */
import type { PracticeCitation } from '../../shared/practices';

type Unverified = Omit<PracticeCitation, 'verified'>;
type File = { repo: string; sha: string; path: string; content: string };

const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/** Each citation with `verified` set: true when `files` has the same repo, sha and path and its text holds the excerpt. */
export function verifyCitations(citations: readonly Unverified[], files?: ReadonlyArray<File>): PracticeCitation[] {
  return citations.map((citation) => {
    const excerpt = lf(citation.excerpt).trim();
    const verified =
      excerpt.length > 0 &&
      Boolean(files?.some((file) => file.repo === citation.repo && file.sha === citation.sha && file.path === citation.path && lf(file.content).includes(excerpt)));
    return { ...citation, verified };
  });
}
