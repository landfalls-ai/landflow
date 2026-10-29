'use client';
/**
 * The composite types' names and icons for the read-only canvases (executions, versions, template previews), fetched
 * once per page load. A type the list doesn't have shows as its id.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { CompositeTypeInfo } from '@/lib/shared/composites';

type Names = Record<string, { displayName: string; icon?: string }>;

let cached: Promise<Names> | undefined;

export function useCompositeNames(enabled: boolean): Names {
  const [names, setNames] = useState<Names>({});
  useEffect(() => {
    if (!enabled) return;
    cached ??= api<{ composites: CompositeTypeInfo[] }>('/api/composites')
      .then(({ composites }) => Object.fromEntries(composites.map((c) => [c.type, { displayName: c.descriptor.displayName, ...(c.descriptor.icon && { icon: c.descriptor.icon }) }])))
      .catch(() => ((cached = undefined), {}));
    let live = true;
    void cached.then((value) => live && setNames(value));
    return () => {
      live = false;
    };
  }, [enabled]);
  return names;
}
