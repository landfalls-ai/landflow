'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { jsonRenderEnabled } from '@/lib/shared/ui-spec';

/**
 * The json-render flag as the host reports it (GET /api/settings, `jsonRender`: the Settings switch, else the environment
 * default), so flipping it in Settings needs no rebuild. `undefined` until the answer arrives; if the fetch fails, the
 * build-time default decides.
 */
export function useJsonRender(skip = false): boolean | undefined {
  const [on, setOn] = useState<boolean>();
  useEffect(() => {
    if (skip) return;
    let live = true;
    api<{ jsonRender: boolean }>('/api/settings')
      .then((r) => live && setOn(r.jsonRender))
      .catch(() => live && setOn(jsonRenderEnabled()));
    return () => {
      live = false;
    };
  }, [skip]);
  return on;
}
