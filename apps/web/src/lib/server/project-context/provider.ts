/**
 * The run-context provider (docs/agents.md#project-context): resolves a run's project and goal, loads them through the
 * goals store's seam and builds the block. It sets itself on import (lib/server/runtime.ts imports it).
 */
import { createHash } from 'node:crypto';
import { envFlag } from '../config';
import type { ContextMode, RunContext, RunContextProvider, RunContextRef } from '../../shared/project-context';
import { contextLine, projectContext, type ProjectContextInput } from './build';
import { refFromSession, resolveRun, runLine } from './resolve';
import { contextDataSource, setRunContextProvider } from './seam';

export { refFromSession };

/** A context with nothing in it (no provider, or the switch is off). */
export const emptyContext = (at: string = new Date().toISOString()): RunContext => ({ mode: 'off', text: '', compact: '', line: '', hash: '', at, practices: [] });

const hashOf = (text: string) => (text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '');

export const projectContextProvider: RunContextProvider = {
  resolve: resolveRun,
  build(ref: RunContextRef, mode: ContextMode, at: string = new Date().toISOString()): RunContext {
    const { projectId, goalId } = resolveRun(ref);
    const source = contextDataSource();
    const off = mode === 'off' || !envFlag('LANDFLOW_PROJECT_CONTEXT', true) || !source;
    const project = projectId ? source?.project(projectId) : undefined;
    const chain = goalId ? (source?.goalChain(goalId) ?? []) : [];
    const goal = chain.at(-1);
    const base = { ...(projectId && { projectId }), ...(project && { projectName: project.name }), ...(goalId && { goalId }), ...(goal && { goalTitle: goal.title }) };
    if (off) return { ...base, mode: 'off', text: '', compact: '', line: '', hash: '', at, practices: [] };
    const input: ProjectContextInput = { mission: source.mission(), ...(project && { project }), chain, run: { text: runLine(ref) } };
    const text = projectContext(input, mode === 'compact' ? 'compact' : 'full');
    return { ...base, mode, text, compact: projectContext(input, 'compact'), line: contextLine(input), hash: hashOf(text), at, practices: [] };
  },
};

setRunContextProvider(projectContextProvider);
