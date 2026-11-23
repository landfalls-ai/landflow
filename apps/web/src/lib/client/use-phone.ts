'use client';
/** Whether the screen is phone-sized (below Tailwind's `md`, 768px): for what CSS alone can't change, such as a placeholder. */
import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export const usePhone = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );

/** The same check outside React, for an event handler: false on the server. */
export const isPhone = () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
