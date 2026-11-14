'use client';
/**
 * "Show developer details": one per-person switch (docs/ui-review.md#developer-details), off by default and kept on the
 * server with the person's other preferences. Ids, type ids, transports, languages, hashes, mode chips and model lines
 * are drawn only when it is on; nothing else decides it.
 */
import type { ReactNode } from 'react';
import { usePreference } from './preferences';

export function useDeveloperDetails(): boolean {
  return usePreference('developerDetails');
}

/** Renders its children only when the person turned on developer details. */
export function DevOnly({ children }: { children: ReactNode }) {
  return useDeveloperDetails() ? <>{children}</> : null;
}
