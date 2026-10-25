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
const statusListeners = new Set<() => void>();

function setConnected(value: boolean) {
  connected = value;
  statusListeners.forEach((l) => l());
}

function ensureSource() {
  if (source || typeof window === 'undefined') return;
  source = new EventSource('/api/events');
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = (message) => {
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
