/**
 * One harness list, one runtime label list (C15 FR-8, AS-3, AS-7): a source scan fails when a module declares its own list of
 * harness ids or a label map for the kagent runtimes outside the registry (packages/protocol/src/harnesses.ts), and the kagent
 * card and a refused deploy use the registry's words.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KAGENT_RUNTIME_LABELS } from '@landflow/protocol/harnesses';

const SRC = join(__dirname, '..', 'src');

/** A harness id list: two known ids as neighbouring string literals in a list. */
const HARNESS_LIST = /\[\s*'(?:claude-code|cursor|codex|gemini|vscode|opencode)'\s*,\s*'(?:claude-code|cursor|codex|gemini|vscode|opencode|generic|claude-desktop)'/;
/** A label map for the runtimes. */
const RUNTIME_MAP = /Record<\s*KagentRuntime\s*,\s*string\s*>/;

export function offenders(files: Array<{ path: string; text: string }>): string[] {
  return files.filter((f) => (HARNESS_LIST.test(f.text) || RUNTIME_MAP.test(f.text))).map((f) => f.path);
}

function sources(dir: string, out: Array<{ path: string; text: string }> = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push({ path: relative(SRC, path), text: readFileSync(path, 'utf8') });
  }
  return out;
}

describe('the registry is the only list', () => {
  it('flags a module that declares its own harness list or runtime label map (AS-7)', () => {
    expect(offenders([{ path: 'a.ts', text: "const IDS = ['claude-code', 'cursor', 'codex'];" }])).toEqual(['a.ts']);
    expect(offenders([{ path: 'b.ts', text: 'const L: Record<KagentRuntime, string> = {} as never;' }])).toEqual(['b.ts']);
    expect(offenders([{ path: 'c.ts', text: "const one = ['claude-code'];" }])).toEqual([]);
  });
  it('finds none in the host source', () => {
    expect(offenders(sources(SRC))).toEqual([]);
  });
  it('/connect reads the registry for its list (C15 FR-1)', () => {
    const text = readFileSync(join(SRC, 'components/connect/harness-snippets.ts'), 'utf8');
    expect(text).toContain('@landflow/protocol/harnesses');
    expect(HARNESS_LIST.test(text)).toBe(false);
  });
});

describe('runtime labels (C15 AS-3)', () => {
  it('the kagent card and the deploy messages read the registry', () => {
    for (const file of ['components/agents/kagent-card.tsx', 'lib/server/kagent/deploy.ts']) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text).toContain('KAGENT_RUNTIME_LABELS');
    }
    expect(KAGENT_RUNTIME_LABELS.codex).toBe('Codex');
  });
});
