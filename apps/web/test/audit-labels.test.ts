/**
 * Every action the server records with a literal name has a label in AUDIT_ACTIONS (lib/shared/audit.ts): the audit log's
 * action filter lists the labels, and an event recorded without a summary shows its label.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/lib/shared/audit';

const SRC = join(__dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('audit labels', () => {
  it('cover every literal action passed to recordAudit', () => {
    const used = new Set<string>();
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/recordAudit\(\{\s*action:\s*'([a-z_.]+)'/g)) used.add(match[1]!);
    }
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((action) => !(action in AUDIT_ACTIONS)).sort()).toEqual([]);
  });
});
