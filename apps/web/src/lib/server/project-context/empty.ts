import type { RunContext } from '../../shared/project-context';

/** A context with nothing in it (no provider, or the switch is off). Kept apart from provider.ts, which registers itself on import. */
export const emptyContext = (at: string = new Date().toISOString()): RunContext => ({ mode: 'off', text: '', compact: '', line: '', hash: '', at, practices: [] });
