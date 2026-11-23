/**
 * Addresses the host derives from the environment, resolved at call time. One place for the fallbacks that were
 * repeated across the server (the public URL in nine files, the Ollama address in thirteen).
 */
import { envString, envUrl } from './parse';

const port = () => process.env.PORT ?? 3000;

/** Base of links the host hands out: LANDFLOW_PUBLIC_URL (trailing slashes removed), else http://localhost:$PORT. */
export function publicUrl(): string {
  return (envString('LANDFLOW_PUBLIC_URL') ?? `http://localhost:${port()}`).replace(/\/+$/, '');
}

export const publicUrlConfigured = (): boolean => Boolean(envString('LANDFLOW_PUBLIC_URL'));

/** Ollama's address: OLLAMA_URL, else the local default. Every site used the same default. */
export function ollamaUrl(): string {
  return envUrl('OLLAMA_URL') ?? 'http://127.0.0.1:11434';
}

/**
 * Where child node plugins and the marketplace fetch the registry: LANDFLOW_MARKETPLACE_REGISTRY_URL, else the public
 * URL, else 127.0.0.1 (not localhost: child processes connect to it, and localhost may resolve to ::1 where the host
 * does not listen).
 */
export function marketplaceRegistryUrl(): string {
  return process.env.LANDFLOW_MARKETPLACE_REGISTRY_URL ?? envString('LANDFLOW_PUBLIC_URL') ?? `http://127.0.0.1:${port()}`;
}
