'use client';
/**
 * The signed-in user, for client components: the root layout checks the session on the server and hands the viewer
 * to this provider; `useViewer()` reads it (null on public pages). Role checks use `can` from lib/shared/auth.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { Viewer } from '@/lib/shared/auth';
import { clearPreferencesCache } from '@/lib/client/preferences';

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({ viewer, children }: { viewer: Viewer | null; children: ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

export function useViewer(): Viewer | null {
  return useContext(ViewerContext);
}

/** Sign out and go to the sign-in page (a full load, so nothing of the old session stays on screen), or to the SAML IdP's logout. */
export async function signOut() {
  clearPreferencesCache();
  const result = (await fetch('/api/auth/logout', { method: 'POST' })
    .then((r) => r.json())
    .catch(() => undefined)) as { redirect?: string } | undefined;
  window.location.assign(result?.redirect ?? '/login');
}

/** Initials for an avatar: "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts.at(-1)![0] : '')).toUpperCase();
}
