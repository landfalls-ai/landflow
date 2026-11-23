'use client';
import { isChromelessPage } from '../shared/auth-paths';
import { BACKGROUND_HEADER } from '../shared/auth';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

/** A 401 from the API means the session ended: go to the sign-in page, then back here. */
function signInAgain(status: number) {
  if (status !== 401 || typeof window === 'undefined') return;
  const here = `${window.location.pathname}${window.location.search}`;
  if (isChromelessPage(window.location.pathname)) return;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

/**
 * `background: true` marks a request the person did not make (a poll, a heartbeat, a reload after a live event): it does
 * not count as use of the session, so the idle limit (LANDFLOW_SESSION_IDLE_HOURS) ends a session left open in a tab.
 */
export async function api<T>(path: string, init: RequestInit & { json?: unknown; background?: boolean } = {}): Promise<T> {
  const { json, background, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined && { 'content-type': 'application/json' }), ...(background && { [BACKGROUND_HEADER]: '1' }), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    signInAgain(response.status);
    throw new ApiError((body as { error?: string })?.error ?? `${response.status} ${response.statusText}`, response.status, body);
  }
  return body as T;
}

/** POST and consume a text/event-stream response. */
export async function streamEvents(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    signInAgain(response.status);
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    throw new ApiError(message, response.status);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}
