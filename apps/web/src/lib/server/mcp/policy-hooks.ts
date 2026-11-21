/**
 * MCP policy hooks (C14), the store: the admin-defined webhooks asked before an outbound MCP request. One JSON document
 * in `settings` (`mcp-policy-hooks`), re-read at most once a second so every process (hosts and queue workers) follows a
 * change within a second, as the governance policy does. Changes are audited here, never the credential, only its id.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { recordAudit } from '../audit';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { parse } from '../db/rows';
import { HttpError } from '../errors';
import { assertUrlAllowed } from '../net/safe-fetch';
import { singleton } from '../singleton';
import { isProduction } from '../config';
import { MAX_POLICY_HOOKS, type McpPolicyHook, type McpPolicyHookView } from '../../shared/mcp-policy';
import { logger } from '../telemetry';
import { hostMetrics } from '../telemetry/metrics';
import { hookInput, hookPatch, storedHooks, type HookInput, type HookPatch } from './policy-hooks-schema';

export const HOOKS_SETTINGS_KEY = 'mcp-policy-hooks';
export const HOOK_CREDENTIAL_TYPE = 'core.httpBearerAuth';
const CACHE_MS = 1_000;

export class PolicyHookError extends HttpError {
  static readonly errorName: string = 'PolicyHookError';
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

const cache = () => singleton('mcp-policy-hooks-cache', () => ({ at: 0, loaded: undefined as Loaded | undefined }));

interface Loaded {
  hooks: McpPolicyHook[];
  /** The settings row exists but cannot be read or holds an invalid hook: the calls it should have gated are unguarded. */
  broken: boolean;
}

/** One uncached read of the settings row. A missing row is no hooks; an unreadable or invalid one is `broken`, never silently empty. */
function readFresh(): Loaded {
  let row: string | undefined;
  try {
    row = database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', HOOKS_SETTINGS_KEY)?.value;
  } catch {
    // No database yet (startup): nothing was ever saved, so no hooks.
    return { hooks: [], broken: false };
  }
  if (!row) return { hooks: [], broken: false };
  const parsed = storedHooks.safeParse(parse<unknown>(row));
  if (!parsed.success) {
    logger.error('mcp policy hooks unreadable', { key: HOOKS_SETTINGS_KEY, issues: parsed.error.issues.length });
    hostMetrics().mcpPolicyStoreErrors.add(1);
    return { hooks: [], broken: true };
  }
  return { hooks: parsed.data.hooks as McpPolicyHook[], broken: false };
}

function load(): Loaded {
  const state = cache();
  if (state.loaded && Date.now() - state.at < CACHE_MS) return state.loaded;
  state.loaded = readFresh();
  state.at = Date.now();
  return state.loaded;
}

/** Drop the 1 s read cache (tests, and after a write in this process). */
export const invalidatePolicyHooks = () => {
  cache().loaded = undefined;
};

/** The hooks in force, oldest first (cached for a second; no database yet means none). */
export const listPolicyHooks = (): McpPolicyHook[] => load().hooks;

/** Whether the stored hooks cannot be read: in production the check then blocks the calls (fail closed). */
export const policyHooksUnreadable = (): boolean => load().broken;

export const getPolicyHook = (id: string): McpPolicyHook | undefined => listPolicyHooks().find((hook) => hook.id === id);

/**
 * Change the list: read it fresh (not the 1 s cache), apply `change` and write it back in one synchronous transaction, so
 * two admins' changes (or two processes') cannot overwrite each other from a stale copy.
 */
function mutate<T>(change: (hooks: McpPolicyHook[]) => { hooks: McpPolicyHook[]; result: T }): T {
  const out = database().transaction(() => {
    const { hooks } = readFresh();
    const next = change(hooks);
    database().upsert('settings', { key: HOOKS_SETTINGS_KEY, value: JSON.stringify({ hooks: next.hooks }) });
    return next.result;
  });
  cache().loaded = undefined;
  return out;
}

/** The hook for the API: the credential as its id and name, never its data. */
export function hookView(hook: McpPolicyHook): McpPolicyHookView {
  const { credentialId, ...rest } = hook;
  const credential = credentialId ? credentials.get(credentialId) : undefined;
  return { ...rest, ...(credentialId && { credential: { id: credentialId, name: credential?.name ?? 'Deleted credential' } }) };
}

/** The checks every write runs: the URL under the outbound rules (AS-8), the credential, the signing it needs. */
function validate(hook: McpPolicyHook) {
  let url: URL;
  try {
    url = new URL(hook.url);
  } catch {
    throw new PolicyHookError('Enter an http:// or https:// URL');
  }
  // The bearer token would cross the network in the clear.
  if (isProduction() && hook.auth === 'bearer' && url.protocol !== 'https:') throw new PolicyHookError('A bearer token needs an https:// URL in the production profile (HMAC signing does not send the key)');
  try {
    assertUrlAllowed(url);
  } catch (error) {
    throw new PolicyHookError((error as Error).message);
  }
  if (hook.auth !== 'none' && !hook.credentialId) throw new PolicyHookError(`Choose a Bearer Auth credential: it ${hook.auth === 'hmac' ? 'signs' : 'authenticates'} the request`);
  if (hook.credentialId) {
    const found = credentials.get(hook.credentialId);
    if (!found) throw new PolicyHookError('That credential does not exist');
    if (found.type !== HOOK_CREDENTIAL_TYPE) throw new PolicyHookError('The credential must be a Bearer Auth credential');
  }
}

const tidy = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

/** What an audit event says about a hook (no credential, only whether one is set). */
const summaryOf = (hook: McpPolicyHook) => ({ name: hook.name, host: safeHost(hook.url), enabled: hook.enabled, auth: hook.auth, failureMode: hook.failureMode, timeoutMs: hook.timeoutMs, methods: hook.match.methods.join(','), hosts: hook.match.hosts.join(','), tools: hook.match.tools.join(',') });

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const diff = (before: McpPolicyHook, after: McpPolicyHook) => {
  const a = summaryOf(before) as Record<string, unknown>;
  const b = summaryOf(after) as Record<string, unknown>;
  const changed = Object.keys(b).filter((key) => a[key] !== b[key]);
  return { changed: changed.join(','), from: JSON.stringify(Object.fromEntries(changed.map((key) => [key, a[key]]))), to: JSON.stringify(Object.fromEntries(changed.map((key) => [key, b[key]]))) };
};

/** Create a hook; the input is parsed here (defaults filled), so a route and a caller get the same one. */
export function createPolicyHook(raw: z.input<typeof hookInput>, actorId?: string): McpPolicyHook {
  const input: HookInput = hookInput.parse(raw);
  return mutate((hooks) => {
    if (hooks.length >= MAX_POLICY_HOOKS) throw new PolicyHookError(`At most ${MAX_POLICY_HOOKS} policy hooks`, 409);
    const now = new Date().toISOString();
    const hook: McpPolicyHook = {
      id: `ph_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      name: input.name,
      enabled: input.enabled,
      url: input.url,
      auth: input.auth,
      ...(input.credentialId && { credentialId: input.credentialId }),
      timeoutMs: input.timeoutMs,
      // A new hook fails closed in the production profile and open elsewhere; the choice is stored, so it never moves later.
      failureMode: input.failureMode ?? (isProduction() ? 'closed' : 'open'),
      match: {
        hosts: tidy(input.match.hosts).map((host) => host.toLowerCase()),
        ...(input.match.pathPrefix && { pathPrefix: input.match.pathPrefix }),
        tools: tidy(input.match.tools),
        methods: [...new Set(input.match.methods)],
        projects: tidy(input.match.projects),
      },
      createdAt: now,
      updatedAt: now,
    };
    validate(hook);
    recordAudit({ action: 'mcp.policy_hook.create', ...(actorId && { actor: { id: actorId } }), target: { type: 'mcp-policy-hook', id: hook.id, name: hook.name }, project: null, summary: `Created the MCP policy hook “${hook.name}”`, details: { to: JSON.stringify(summaryOf(hook)) } });
    return { hooks: [...hooks, hook], result: hook };
  });
}

export function updatePolicyHook(id: string, raw: z.input<typeof hookPatch>, actorId?: string): McpPolicyHook {
  const patch: HookPatch = hookPatch.parse(raw);
  return mutate((hooks) => {
    const before = hooks.find((hook) => hook.id === id);
    if (!before) throw new PolicyHookError('No such policy hook', 404);
    const { credentialId, match, ...rest } = patch;
    const next: McpPolicyHook = {
      ...before,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
      match: {
        ...before.match,
        ...(match?.hosts && { hosts: tidy(match.hosts).map((host) => host.toLowerCase()) }),
        ...(match?.tools && { tools: tidy(match.tools) }),
        ...(match?.methods && { methods: [...new Set(match.methods)] }),
        ...(match?.projects && { projects: tidy(match.projects) }),
      },
      updatedAt: new Date().toISOString(),
    };
    if (match && 'pathPrefix' in match) {
      if (match.pathPrefix) next.match.pathPrefix = match.pathPrefix;
      else delete next.match.pathPrefix;
    }
    if (credentialId === null) delete next.credentialId;
    else if (credentialId) next.credentialId = credentialId;
    validate(next);
    recordAudit({ action: 'mcp.policy_hook.update', ...(actorId && { actor: { id: actorId } }), target: { type: 'mcp-policy-hook', id, name: next.name }, project: null, summary: `Changed the MCP policy hook “${next.name}”`, details: { ...diff(before, next), credentialChanged: before.credentialId !== next.credentialId } });
    return { hooks: hooks.map((hook) => (hook.id === id ? next : hook)), result: next };
  });
}

export function deletePolicyHook(id: string, actorId?: string): void {
  mutate((hooks) => {
    const before = hooks.find((hook) => hook.id === id);
    if (!before) throw new PolicyHookError('No such policy hook', 404);
    recordAudit({ action: 'mcp.policy_hook.delete', ...(actorId && { actor: { id: actorId } }), target: { type: 'mcp-policy-hook', id, name: before.name }, project: null, summary: `Removed the MCP policy hook “${before.name}”`, details: { from: JSON.stringify(summaryOf(before)) } });
    return { hooks: hooks.filter((hook) => hook.id !== id), result: undefined };
  });
}
