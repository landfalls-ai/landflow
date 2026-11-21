/**
 * The signed memory key (docs/a2a.md#memory-on-kagent, C09 D5). An agent on kagent has no person to ask "who am I talking to",
 * so when Landflow sends the first message of a conversation to a Landflow agent on kagent with cross-session memory on, it adds
 * a key naming that agent and that person. The memory tools on the agent's MCP endpoint open only memories a valid key names.
 *
 * `mk_<base64url{a,u,e}>.<hmac>`: the agent id, the person's user id and the expiry (24 hours), signed with HMAC-SHA256 under
 * `vault.deriveKey('agent-memory-key')` and checked against every key of the ring (`deriveKeys`), so a key rotation does not void
 * a conversation in flight. Signed rather than remembered, so it works when the A2A call and the MCP call land on different
 * processes (queue mode). A key opens one person's memories for one agent, which that agent already reads in its own runs; it is
 * never logged and never put on a span.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { credentials } from '../credentials/vault';
import { hasMemoryUser } from '../agents/memory';
import { rememberSecretValues } from '../secrets/redact';

const LABEL = 'agent-memory-key';
export const MEMORY_KEY_TTL_MS = 24 * 3_600_000;
export { MEMORY_KEY_PATTERN } from './memory-scrub';

const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

/** A key for `userId` talking to agent `agentId`, valid for 24 hours from `now`. */
export function memoryKeyFor(agentId: string, userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ a: agentId, u: userId, e: now + MEMORY_KEY_TTL_MS })).toString('base64url');
  const key = `mk_${payload}.${sign(credentials.deriveKey(LABEL), payload)}`;
  // The central redactor learns it: node outputs and errors, executions, the journal, logs, the approvals inbox and alerts never show it.
  rememberSecretValues(key, { lines: false });
  return key;
}

/** The person a key names for `agentId`; undefined for a key that is forged, expired, or for another agent. */
export function openMemoryKey(key: unknown, agentId: string, now = Date.now()): { userId: string } | undefined {
  if (typeof key !== 'string' || !key.startsWith('mk_') || key.length > 1_000) return undefined;
  const dot = key.lastIndexOf('.');
  if (dot < 0) return undefined;
  const payload = key.slice(3, dot);
  const given = Buffer.from(key.slice(dot + 1));
  const valid = credentials.deriveKeys(LABEL).some((k) => {
    const expected = Buffer.from(sign(k, payload));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return undefined;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { a?: unknown; u?: unknown; e?: unknown };
    if (body.a !== agentId || typeof body.u !== 'string' || typeof body.e !== 'number' || body.e <= now || body.e > now + MEMORY_KEY_TTL_MS + 60_000 || !hasMemoryUser(body.u)) return undefined;
    return { userId: body.u };
  } catch {
    return undefined;
  }
}
