'use client';
/**
 * One shared EventSource for the whole tab; components subscribe to it.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { StreamEvent } from '../shared/types';

type Listener = (event: StreamEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;
let connected = false;
let retryDelay = 0;
const statusListeners = new Set<() => void>();

function setConnected(value: boolean) {
  connected = value;
  statusListeners.forEach((l) => l());
}

function ensureSource() {
  if (source || typeof window === 'undefined') return;
  const current = new EventSource('/api/events');
  source = current;
  current.onopen = () => {
    retryDelay = 0;
    setConnected(true);
  };
  current.onerror = () => {
    setConnected(false);
    // A network drop is retried by the browser itself. A non-200 answer (a 429 from the rate limit, a 503 while the
    // host restarts, a 401) closes the EventSource for good: open a new one, backing off up to a minute.
    if (current.readyState !== EventSource.CLOSED) return;
    current.close();
    if (source === current) source = undefined;
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 2_000, 60_000);
    setTimeout(ensureSource, retryDelay);
  };
  current.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as StreamEvent;
      listeners.forEach((listener) => listener(event));
    } catch {}
  };
}

export function useLiveEvents(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureSource();
    const wrapped: Listener = (event) => ref.current(event);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}

export function useLiveConnected() {
  return useSyncExternalStore(
    (cb) => {
      ensureSource();
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => connected,
    () => false,
  );
}
