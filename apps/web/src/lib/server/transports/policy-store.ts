/**
 * The per-plugin transport policy in the database (`plugin_transport_policies`, migration 1700): `{ mode, pinned?,
 * allowed?, objective }` per plugin id, shared by every main and worker in queue mode. It replaces the registry's
 * in-memory `preferredTransport`: a preferred transport is now `{ mode: 'pinned', pinned }`, since choosing "gRPC" on
 * the Plugins page meant "use gRPC", and the policy survives restarts and is the same on every process.
 *
 * Reads come from a small cache, dropped when this process writes and when another process changes the table
 * (Postgres replication, or the SQLite broadcast in queue mode: lib/server/db/replication.ts).
 */
import { z } from 'zod';
import { DEFAULT_TRANSPORT_POLICY, type TransportKind, type TransportPolicy } from '../../shared/transports';
import { database, type Database } from '../db';
import { onTablesChanged } from '../db/replication';
import { parse } from '../db/rows';
import { singleton } from '../singleton';

const KIND = z.string().min(1).max(32).regex(/^[a-z][a-z0-9+.-]*$/, 'A transport kind is lower-case: http, grpc, kafka…');

/** A complete policy, as PATCH /api/plugins/:id accepts it in `policy`. */
export const transportPolicySchema = z
  .strictObject({
    mode: z.enum(['auto', 'pinned']).default('auto'),
    pinned: KIND.optional(),
    allowed: z.array(KIND).max(32).optional(),
    objective: z.enum(['balanced', 'latency', 'throughput']).default('balanced'),
  })
  .superRefine((policy, ctx) => {
    if (policy.mode === 'pinned' && !policy.pinned) ctx.addIssue({ code: 'custom', path: ['pinned'], message: 'A pinned policy names the transport' });
    if (policy.allowed && !policy.allowed.length) ctx.addIssue({ code: 'custom', path: ['allowed'], message: 'The allow-list names at least one transport (or leave it out)' });
    if (policy.pinned && policy.allowed && !policy.allowed.includes(policy.pinned)) ctx.addIssue({ code: 'custom', path: ['pinned'], message: 'The pinned transport must be in the allow-list' });
  });

/** A policy as stored: `pinned` only with `mode: 'pinned'`, `allowed` deduplicated, nothing else. */
export function normalizePolicy(input: Partial<TransportPolicy>): TransportPolicy {
  const mode = input.mode ?? 'auto';
  const allowed = input.allowed ? [...new Set(input.allowed)] : undefined;
  return {
    mode,
    ...(mode === 'pinned' && input.pinned && { pinned: input.pinned }),
    ...(allowed?.length && { allowed }),
    objective: input.objective ?? 'balanced',
  };
}

/** Today's `preferredTransport` body as a policy: a transport → pinned to it; none → Auto (the objective is kept). */
export function policyFromPreferred(preferred: TransportKind | null | undefined, current: TransportPolicy = DEFAULT_TRANSPORT_POLICY): TransportPolicy {
  return normalizePolicy(preferred ? { ...current, mode: 'pinned', pinned: preferred } : { ...current, mode: 'auto', pinned: undefined });
}

/** Whether a policy is the default (such a row is deleted rather than stored). */
export const isDefaultPolicy = (policy: TransportPolicy) => policy.mode === 'auto' && !policy.allowed && policy.objective === 'balanced';

interface Row {
  plugin_id: string;
  policy: string;
}

export interface PolicyStoreOptions {
  db?: () => Database;
}

export class TransportPolicyStore {
  private cache?: Map<string, TransportPolicy>;
  private readonly db: () => Database;

  constructor(options: PolicyStoreOptions = {}) {
    this.db = options.db ?? database;
    onTablesChanged((change) => {
      if (change.tables.has('plugin_transport_policies')) this.invalidate();
    });
  }

  private policies(): Map<string, TransportPolicy> {
    if (!this.cache) {
      this.cache = new Map();
      for (const row of this.db().all<Row>('SELECT plugin_id, policy FROM plugin_transport_policies')) {
        const stored = parse<Partial<TransportPolicy>>(row.policy);
        if (stored) this.cache.set(row.plugin_id, normalizePolicy(stored));
      }
    }
    return this.cache;
  }

  /** Forget the cached rows (the next read goes to the table). */
  invalidate(): void {
    this.cache = undefined;
  }

  /** The plugin's policy, Auto/balanced when none is stored. */
  get(pluginId: string): TransportPolicy {
    return this.policies().get(pluginId) ?? DEFAULT_TRANSPORT_POLICY;
  }

  /** Every stored (non-default) policy by plugin id. */
  list(): Record<string, TransportPolicy> {
    return Object.fromEntries(this.policies());
  }

  /** Store a plugin's policy (the default policy removes the row); returns what was stored. */
  set(pluginId: string, input: Partial<TransportPolicy>, updatedBy?: string): TransportPolicy {
    const policy = normalizePolicy(input);
    if (isDefaultPolicy(policy)) this.db().delete('plugin_transport_policies', { plugin_id: pluginId });
    else this.db().upsert('plugin_transport_policies', { plugin_id: pluginId, policy: JSON.stringify(policy), updated_at: new Date().toISOString(), updated_by: updatedBy ?? null });
    this.invalidate();
    return policy;
  }

  /** Back to Auto (the row goes). */
  remove(pluginId: string): boolean {
    const removed = this.db().delete('plugin_transport_policies', { plugin_id: pluginId }) > 0;
    this.invalidate();
    return removed;
  }
}

export const transportPolicies = singleton('transport-policies', () => new TransportPolicyStore());
