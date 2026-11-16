'use client';
/** Saved credentials and the credential types plugins publish, shared by the credentials page and the node panel. */
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/client/api';
import type { CredentialSummary, CredentialTypeInfo } from '@/lib/shared/types';

interface CredentialsState {
  credentials?: CredentialSummary[];
  types?: CredentialTypeInfo[];
  error?: string;
  refresh(): Promise<void>;
}

export const useCredentialStore = create<CredentialsState>((set) => ({
  async refresh() {
    try {
      const [{ credentials }, { types }] = await Promise.all([
        api<{ credentials: CredentialSummary[] }>('/api/credentials'),
        api<{ types: CredentialTypeInfo[] }>('/api/credential-types'),
      ]);
      set({ credentials, types, error: undefined });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },
}));

/** Loads on first use; call `refresh()` after a change. */
export function useCredentials() {
  const state = useCredentialStore();
  useEffect(() => {
    void useCredentialStore.getState().refresh();
  }, []);
  return state;
}

/** A requirement name from a node descriptor ("telegramApi") as the fully-qualified type ("messaging.telegramApi"). */
export function qualifiedCredentialType(nodeType: string, requirement: string) {
  return requirement.includes('.') ? requirement : `${nodeType.slice(0, nodeType.indexOf('.'))}.${requirement}`;
}

/**
 * The credentials to pick on their own, like n8n: for each requirement without one, the only credential of its type
 * among `candidates` (what this workflow's project may use). All in one object so no pick overwrites another; undefined
 * when nothing is to be picked.
 */
export function autoPicks(
  nodeType: string,
  requirements: Array<{ name: string }>,
  candidates: Array<{ id: string; name: string; type: string }>,
  value: Record<string, { id: string; name: string }> | undefined,
): Record<string, { id: string; name: string }> | undefined {
  let next: Record<string, { id: string; name: string }> | undefined;
  for (const requirement of requirements) {
    if (value?.[requirement.name]) continue;
    const matches = candidates.filter((c) => c.type === qualifiedCredentialType(nodeType, requirement.name));
    if (matches.length === 1) (next ??= { ...value })[requirement.name] = { id: matches[0].id, name: matches[0].name };
  }
  return next;
}

/**
 * One step of the node panel's auto-pick. Nothing happens while the choice isn't known (the credentials aren't loaded, or
 * the workflow's project hasn't said which it may use: `scoped` without `scopeKnown`) or when the edit won't be saved
 * (`readOnly`). `settled` are the requirements already seen with a credential or picked, so one the person clears stays empty;
 * the step returns the updated list and the one update to make (undefined: none).
 */
export function autoPickStep(input: {
  nodeType: string;
  requirements: Array<{ name: string }>;
  candidates: Array<{ id: string; name: string; type: string }> | undefined;
  scoped: boolean;
  scopeKnown: boolean;
  readOnly?: boolean;
  settled: ReadonlySet<string>;
  value: Record<string, { id: string; name: string }> | undefined;
}): { settled: Set<string>; next?: Record<string, { id: string; name: string }> } {
  const settled = new Set(input.settled);
  if (input.readOnly || !input.candidates || (input.scoped && !input.scopeKnown)) return { settled };
  const open = input.requirements.filter((r) => !settled.has(r.name));
  for (const r of input.requirements) if (input.value?.[r.name]) settled.add(r.name);
  const next = autoPicks(input.nodeType, open, input.candidates, input.value);
  for (const name of Object.keys(next ?? {})) settled.add(name);
  return { settled, next };
}
