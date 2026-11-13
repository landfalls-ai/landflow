/**
 * The sandbox choice is kept on globalThis, so a second copy of the engine module (Next compiles the package once per
 * module graph) sees what the first was told at boot.
 */
import { describe, expect, it, vi } from 'vitest';

describe('expression sandbox choice across module graphs', () => {
  it('set through one module instance, read by a fresh one', async () => {
    const first = await import('@landflow/engine');
    first.configureExpressionSandbox({ backend: 'isolate', memoryMb: 123 });
    vi.resetModules();
    const second = await import('@landflow/engine');
    expect(second).not.toBe(first);
    const holder = globalThis as unknown as Record<symbol, { backend?: string; memoryMb?: number } | undefined>;
    expect(holder[Symbol.for('landflow.expression.sandbox.options')]).toEqual({ backend: 'isolate', memoryMb: 123 });
    second.configureExpressionSandbox({});
    expect(holder[Symbol.for('landflow.expression.sandbox.options')]).toEqual({});
  });
});
