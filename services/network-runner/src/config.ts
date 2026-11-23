/** The runner's settings: environment variables only (FR-10). */
import { hostname } from 'node:os';
import { parseAllow, type AllowEntry } from './allow';

export const VERSION = '0.1.0';

export interface RunnerConfig {
  /** The Landflow host (`https://…`; `http://` only for this machine or Docker's host name). */
  url: URL;
  token: string;
  name: string;
  allow: AllowEntry[];
  /** Calls made at once. */
  concurrency: number;
  /** Waits after a failed poll: 1 s growing to 30 s (a test shortens them). */
  retryMs?: number[];
  /** How long a runner at capacity waits between heartbeats (default 5 s). */
  idleMs?: number;
}

const LOCAL_HTTP = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

export function loadConfig(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const raw = env.LANDFLOW_URL?.trim();
  if (!raw) throw new Error('LANDFLOW_URL is required: the address of your Landflow host, e.g. https://landflow.example.com');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LANDFLOW_URL is not a URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HTTP.has(url.hostname))) {
    throw new Error('LANDFLOW_URL must be https:// (http:// is accepted only for localhost and host.docker.internal): the token travels in every request');
  }
  const token = env.LANDFLOW_RUNNER_TOKEN?.trim();
  if (!token) throw new Error('LANDFLOW_RUNNER_TOKEN is required: register the runner in Settings → Networks');
  const concurrency = Number(env.LANDFLOW_RUNNER_CONCURRENCY ?? 8);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('LANDFLOW_RUNNER_CONCURRENCY is a whole number from 1 to 64');
  return { url, token, name: env.LANDFLOW_RUNNER_NAME?.trim() || hostname(), allow: parseAllow(env.LANDFLOW_RUNNER_ALLOW), concurrency };
}
