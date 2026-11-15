/**
 * The seams of project context (docs/projects-and-goals.md#how-it-is-built): the goals store sets the data source
 * (lib/server/goals/context-source.ts), the provider sets itself (lib/server/project-context/provider.ts), and the agents
 * runtime, remote agents, teams and the usage meter read them, so none of them imports another. Both are set by side-effect
 * imports at the top of lib/server/runtime.ts (both roles); tests set fakes. The context of the agent run in progress
 * travels in AsyncLocalStorage, like the usage scope. The third slot is the practices store's selector
 * (docs/practices.md): nothing sets it in wave 7, so no run gets practices until wave P2 does. Written by the plan for
 * Paperclip wave 7 and Practices wave P1: change it only in a later wave.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextDataSource, PracticesSource, RunContext, RunContextProvider } from '../../shared/project-context';
import { singleton } from '../singleton';

const slots = () =>
  singleton('project-context-seams', () => ({
    data: undefined as ContextDataSource | undefined,
    provider: undefined as RunContextProvider | undefined,
    practices: undefined as PracticesSource | undefined,
  }));
const runs = () => singleton('project-context-run', () => new AsyncLocalStorage<RunContext>());

/** The goals store's reader (undefined: none loaded, so no block). */
export function setContextDataSource(source: ContextDataSource | undefined): void {
  slots().data = source;
}
export const contextDataSource = (): ContextDataSource | undefined => slots().data;

/** The provider that resolves a run's project and goal and builds its block. */
export function setRunContextProvider(provider: RunContextProvider | undefined): void {
  slots().provider = provider;
}
export const runContextProvider = (): RunContextProvider | undefined => slots().provider;

/** The practices store's selector (undefined: none set, so no run gets practices; wave P2 sets it). */
export function setPracticesSource(source: PracticesSource | undefined): void {
  slots().practices = source;
}
export const practicesSource = (): PracticesSource | undefined => slots().practices;

/** Run `fn` with `context` as the current agent run's (the agents runtime does, around one run). */
export const withRunContext = <T>(context: RunContext, fn: () => T): T => runs().run(context, fn);
/** The context of the agent run in progress, if any. */
export const currentRunContext = (): RunContext | undefined => runs().getStore();
