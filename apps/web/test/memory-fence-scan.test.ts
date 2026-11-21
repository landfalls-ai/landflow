/**
 * The fence's source scan (C03 FR-7): a prompt-building module under agents/, notebook/, brain/ or agent-teams/ must not put a
 * fact's `statement` or a note's / memory's `text` into a template string without `wrapMemory(` or `escapeFenceText(` on the
 * same line. A hit that is a prompt is fixed; one that is not (an embedding input, a line the callers wrap) is listed below
 * with its reason. An allow-list entry that no longer matches anything fails, so the list only shrinks with the code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'src', 'lib', 'server');
const DIRS = ['agents', 'notebook', 'brain', 'agent-teams'];

/** A template string that interpolates a fact statement or a note/memory text. */
const RISKY = /`[^`]*\$\{[^}]*\b(?:\w+\.statement|(?:note|n|mem|memory|notes?\[[^\]]*\])\.text)\b/;
const FENCED = /wrapMemory\(|escapeFenceText\(/;

/** The lines of a source that put memory text into a template without the fence on the same line. */
export function unfencedLines(source: string): { line: number; text: string }[] {
  return source.split('\n').flatMap((text, i) => (RISKY.test(text) && !FENCED.test(text) ? [{ line: i + 1, text }] : []));
}

const ALLOWED: { file: string; contains: string; reason: string }[] = [
  { file: 'notebook/service.ts', contains: 'by ${note.author}', reason: 'lineOf is one line, not a block: its callers (notebookBlock, note_search) hand it to wrapMemory, which escapes the whole line' },
  { file: 'notebook/service.ts', contains: "decisions.map((n) => `- ${n.text}`)", reason: 'a line handed to the wrapMemory call that wraps this whole array' },
  { file: 'notebook/service.ts', contains: "open.map((n) => `- ${n.text}`)", reason: 'a line handed to the wrapMemory call that wraps this whole array' },
  { file: 'notebook/service.ts', contains: "disputed.map((n) => `- ${n.text}`)", reason: 'a line handed to the wrapMemory call that wraps this whole array' },
  { file: 'brain/wiki.ts', contains: 'const factLine', reason: 'a line; the summary and Ask prompts hand every factLine to wrapMemory' },
  { file: 'brain/facts.ts', contains: '${f.kind} ${f.statement}', reason: 'embedding input, never a prompt' },
  { file: 'brain/study.ts', contains: '${f.subjectName ?? f.subjectId}: ${f.statement}', reason: 'embedding input, never a prompt' },
  { file: 'brain/similar.ts', contains: '${fact.subjectName', reason: 'word-overlap scoring, never a prompt' },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('memory text reaches prompts only through the fence', () => {
  it('flags a template that interpolates note text (AS-6) and passes a wrapped one', () => {
    expect(unfencedLines('const p = `Notes:\\n${note.text}`;')).toHaveLength(1);
    expect(unfencedLines('const p = `Facts:\\n${f.statement}`;')).toHaveLength(1);
    expect(unfencedLines("const p = wrapMemory('team-notebook', [note.text]);")).toHaveLength(0);
    expect(unfencedLines('const p = `${escapeFenceText(note.text)}`;')).toHaveLength(0);
  });

  it('finds no unfenced use in agents/, notebook/, brain/ or agent-teams/ beyond the listed ones', () => {
    const used = new Set<number>();
    const stray: string[] = [];
    for (const file of DIRS.flatMap((d) => walk(join(ROOT, d)))) {
      const rel = relative(ROOT, file);
      for (const hit of unfencedLines(readFileSync(file, 'utf8'))) {
        const at = ALLOWED.findIndex((a) => a.file === rel && hit.text.includes(a.contains));
        if (at >= 0) used.add(at);
        else stray.push(`${rel}:${hit.line}: ${hit.text.trim()}`);
      }
    }
    expect(stray, 'memory text in a prompt without the fence; use wrapMemory(...) or list it with a reason').toEqual([]);
    const stale = ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.contains}`);
    expect(stale, 'allow-list entries that match nothing').toEqual([]);
  });
});
