/**
 * A migration numbered below one a database already has still runs there, but after the higher ones, while a fresh
 * database runs it before them, so the order differs between databases and their schemas can diverge. Every new
 * migration therefore goes at the end with a version above the current highest.
 * This test enforces that; the out-of-order versions that already shipped are grandfathered below.
 */
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@/lib/server/db/schema';

/** Versions that shipped before this check, out of file order (1200 and 1300 follow 1400 and 1401). Never add to it. */
const GRANDFATHERED = new Set([1200, 1300]);

describe('migration order', () => {
  it('has unique versions', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([]);
  });

  it('puts every migration above all the ones before it', () => {
    const outOfOrder: number[] = [];
    let highest = -Infinity;
    for (const migration of MIGRATIONS) {
      if (migration.version < highest && !GRANDFATHERED.has(migration.version)) outOfOrder.push(migration.version);
      highest = Math.max(highest, migration.version);
    }
    expect(outOfOrder, 'append new migrations at the end with a version above the current highest').toEqual([]);
  });

  it('keeps the grandfathered list honest', () => {
    const versions = new Set(MIGRATIONS.map((m) => m.version));
    for (const v of GRANDFATHERED) expect(versions.has(v)).toBe(true);
  });
});
