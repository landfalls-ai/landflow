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
