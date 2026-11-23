/**
 * C31: what the host does with project keys, above the vault: re-sealing after a move, rotating one project's key,
 * retiring a deleted project's keys and destroying them later, root rotation's re-wrap, and the owner's `migrate` (every
 * credential onto its project's key, one at a time, so a run that stops is simply run again) and `revert` (everything
 * back onto the ring, the way back before a downgrade to a host without version 3 values). Creating a key and the root
 * re-wrap are audited fail-open (as root rotation is); rotating a project's key, destroying one, migrate and revert are
 * audited fail-closed. Only counts, ids and versions are ever audited or logged, never key bytes.
 *
 * Destroying is deliberately late (the delayed crypto-shred): a rotation or a project delete only retires a key. A sweep
 * (run by `migrate`) deletes a retired key once it has been retired for KEY_DESTROY_GRACE_MS, so no process is still
 * sealing with it from a cache, and only when no stored credential names it, checked in Postgres, not in this process's
 * copy, which another process may have just written to.
 */
import { recordAudit, type AuditInput } from '../audit';
import { auditFailClosed } from '../config/audit';
import { logger } from '../telemetry/logger';
import { credentials, type CredentialVault } from './vault';
import { KEY_DESTROY_GRACE_MS, type ProjectKeyStore, type RewrapResult } from './project-key-store';

export interface ResealResult {
  resealed: number;
  current: number;
  /** Credential ids that could not be opened or written: they stay as they were, readable. */
  failed: string[];
  /** Credentials with no project to seal with (migrate only). */
  skipped: number;
  /** Credential ids whose project's key has not reached this process yet: a later run finishes them. */
  pending: string[];
}

export interface ProjectKeysStatus {
  projects: Array<{ projectId: string; name?: string; active?: number; retired: number[]; credentials: number }>;
  /** Credentials still sealed with a ring key. */
  onRing: number;
  /** `<projectId>:<version>` of keys this process can't unwrap (the ring lacks the key that wrapped them). */
  unreadable: string[];
}

function resealEach(vault: CredentialVault, ids: string[], target: 'project' | 'ring'): ResealResult {
  const result: ResealResult = { resealed: 0, current: 0, failed: [], skipped: 0, pending: [] };
  for (const id of ids) {
    try {
      const done = vault.resealOne(id, target);
      if (done === 'resealed') result.resealed += 1;
      else if (done === 'current') result.current += 1;
      else if (done === 'pending') result.pending.push(id);
      else result.skipped += 1;
    } catch (error) {
      logger.warn('a credential could not be re-sealed', { 'landflow.credential.id': id, 'landflow.project_key.target': target, error: error instanceof Error ? error.name : 'error' });
      result.failed.push(id);
    }
  }
  return result;
}

/** Fail-closed audit around a change that has to wait: the event is recorded first and a failure refuses the change; otherwise the change runs and its event follows. */
async function auditedAsync<T>(input: (result: T | undefined) => AuditInput, change: () => Promise<T>): Promise<T> {
  if (auditFailClosed()) {
    recordAudit(input(undefined), { required: true });
    return change();
  }
  const result = await change();
  recordAudit(input(result));
  return result;
}

/** The operations on one vault's project keys (tests run two vaults, as two processes would); `projectKeys` is the host's. */
export function projectKeysOf(vault: CredentialVault) {
  const store = (): ProjectKeyStore => vault.projectKeys;

  /** Every distinct project the given credentials would be sealed for, each with a key this process can use. */
  const ensureFor = async (ids: string[]) => {
    for (const project of new Set(ids.flatMap((id) => vault.projectFor(id) ?? []))) await vault.ensureProjectKey(project);
  };

  const audited = (result: RewrapResult): RewrapResult => {
    if (result.rewrapped || result.failed.length) {
      recordAudit({
        action: 'encryption.project_key.rewrapped',
        target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
        summary: `Re-wrapped ${result.rewrapped} project key${result.rewrapped === 1 ? '' : 's'} with ${vault.primaryKid}`,
        details: { primary: vault.primaryKid, rewrapped: result.rewrapped, current: result.current, failed: result.failed.length },
      });
    }
    return result;
  };

  const self = {
    /** The credentials sealed with this project's keys. */
    credentialsOf(projectId: string): string[] {
      return [...vault.projectKeyUse()].filter(([, [project]]) => project === projectId).map(([id]) => id);
    },

    /**
     * After a move: seal each moved credential with its new project's key (D11). A failure leaves it on the old key, readable, and counted.
     * One whose project's key has not reached this process (queue mode) is `pending`: it is finished in the background as soon as the key exists.
     */
    resealCredentials(ids: string[]): ResealResult {
      const result = resealEach(vault, ids, 'project');
      if (result.pending.length) {
        const pending = result.pending;
        void ensureFor(pending)
          .then(() => resealEach(vault, pending, 'project'))
          .catch((error) => logger.warn('moved credentials could not be re-sealed yet; migrate finishes them', { error: error instanceof Error ? error.name : 'error' }));
      }
      return result;
    },

    /**
     * Root rotation (FR-4): every key whose wrap names another ring key is wrapped again with the primary; no credential row
     * is touched. Fail-open audit.
     */
    async rewrapAll(): Promise<RewrapResult> {
      return audited(await store().rewrapAll());
    },

    /** `rewrapAll` where nothing has to wait (SQLite): the synchronous form `rotateEncryption` uses. */
    rewrapAllNow(): RewrapResult {
      return audited(store().rewrapAllSync());
    },

    /**
     * Rotate one project's key (FR-7): a new active version, that project's credentials re-sealed one at a time. The old version is
     * retired, not destroyed: another process may still be sealing with it, so a later sweep deletes it (after the grace period, once
     * nothing names it). Fail-closed audit.
     */
    rotate(projectId: string): Promise<{ version: number; resealed: number; failed: string[] }> {
      return auditedAsync(
        (result) => ({
          action: 'encryption.project_key.rotated',
          target: { type: 'project', id: projectId },
          project: projectId,
          summary: `Rotated the encryption key of project ${projectId}`,
          details: { projectId, ...(result && { version: result.version, resealed: result.resealed, failed: result.failed.length }) },
        }),
        async () => {
          const named = self.credentialsOf(projectId);
          const { version } = await store().addVersion(projectId);
          const done = resealEach(vault, named, 'project');
          return { version, resealed: done.resealed, failed: done.failed };
        },
      );
    },

    /**
     * A project went (its credentials moved or were deleted): its keys are retired, nothing more. They are deleted by a later sweep, after
     * the grace period and once no credential names them. Until then a copy of the database holds the wrapped key.
     */
    async projectRemoved(projectId: string): Promise<void> {
      await store().retireAll(projectId);
    },

    /**
     * Every credential onto its project's active key, one at a time and idempotent (keys are made first, in Postgres, where that is the
     * rule); then the sweep. Fail-closed audit.
     */
    migrate(exists?: (projectId: string) => boolean, nowMs?: number): Promise<ResealResult & { destroyed: string[]; done: boolean }> {
      return auditedAsync(
        (result) => ({
          action: 'encryption.project_key.migrated',
          target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
          summary: 'Moved credentials onto project keys',
          details: { ...(result && { resealed: result.resealed, current: result.current, failed: result.failed.length, pending: result.pending.length, skipped: result.skipped, destroyed: result.destroyed.length }) },
        }),
        async () => {
          const ids = vault.sealedWithAll().map((c) => c.id);
          await ensureFor(ids);
          const done = resealEach(vault, ids, 'project');
          const destroyed = await self.sweep(exists, nowMs);
          return { ...done, destroyed, done: done.failed.length === 0 && done.pending.length === 0 };
        },
      );
    },

    /** Every credential back onto the ring's primary key as version 2 (before a downgrade to a host without project keys). Keys are kept. Fail-closed audit. */
    async revert(): Promise<ResealResult & { onProjectKeys: number; done: boolean }> {
      const input = (result: (ResealResult & { onProjectKeys: number }) | undefined): AuditInput => ({
        action: 'encryption.project_key.reverted',
        target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
        summary: 'Moved credentials back onto the key ring',
        details: { ...(result && { resealed: result.resealed, current: result.current, failed: result.failed.length, onProjectKeys: result.onProjectKeys }) },
      });
      if (auditFailClosed()) recordAudit(input(undefined), { required: true });
      const done = resealEach(vault, vault.sealedWithAll().map((c) => c.id), 'ring');
      // This process's own writes must have reached Postgres before it is asked what still names a project key.
      const named = new Set([...vault.projectKeyUse().values()].map(([project, version]) => `${project}:${version}`));
      for (const id of (await store().namedInDatabase()) ?? []) named.add(id);
      const onProjectKeys = named.size;
      const result = { ...done, onProjectKeys };
      if (!auditFailClosed()) recordAudit(input(result));
      return { ...result, done: done.failed.length === 0 && onProjectKeys === 0 };
    },

    /**
     * Delete retired keys that have been retired for the grace period and that no stored credential names (Postgres is asked, after this
     * process's own writes reached it, as well as this process's copy). Keys of projects `exists` says are gone are retired first and
     * deleted by a later sweep. Fail-closed audit. Returns `<projectId>:<version>` of each deleted key.
     */
    async sweep(exists?: (projectId: string) => boolean, nowMs = Date.now()): Promise<string[]> {
      let rows = await store().allRows();
      if (!rows) {
        logger.warn('project keys were not swept: this process’s writes have not reached the database yet');
        return [];
      }
      if (exists) {
        const missing = [...new Set(rows.map((row) => row.project_id))].filter((project) => !exists(project));
        for (const project of missing) await store().retireAll(project);
        if (missing.length) rows = (await store().allRows()) ?? rows;
      }
      const named = new Set([...vault.projectKeyUse().values()].map(([project, version]) => `${project}:${version}`));
      for (const id of (await store().namedInDatabase()) ?? []) named.add(id);
      const due = rows.filter((row) => row.state === 'retired' && row.retired_at && Date.parse(row.retired_at) <= nowMs - KEY_DESTROY_GRACE_MS && !named.has(`${row.project_id}:${row.version}`));
      if (!due.length) return [];
      const gone: string[] = [];
      await auditedAsync(
        (result) => ({
          action: 'encryption.project_key.destroyed',
          target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
          summary: 'Destroyed retired project keys',
          details: { count: result?.length ?? due.length, keys: due.map((row) => `${row.project_id}:${row.version}`).join(',') },
        }),
        async () => {
          for (const row of due) if (await store().destroyDue(row.project_id, row.version, KEY_DESTROY_GRACE_MS - (nowMs - Date.now()))) gone.push(`${row.project_id}:${row.version}`);
          return gone;
        },
      );
      return gone;
    },

    /** Where everything stands: per project its versions and credentials, and what is still on the ring. `nameOf` adds project names. */
    status(nameOf?: (projectId: string) => string | undefined): ProjectKeysStatus {
      const use = vault.projectKeyUse();
      const count = new Map<string, number>();
      for (const [project] of use.values()) count.set(project, (count.get(project) ?? 0) + 1);
      const byProject = new Map<string, ReturnType<ProjectKeyStore['rows']>>();
      for (const row of store().rows()) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
      const unreadable: string[] = [];
      const projects = [...new Set([...byProject.keys(), ...count.keys()])].sort().map((projectId) => {
        const rows = byProject.get(projectId) ?? [];
        // Looked at without keeping the key in memory.
        for (const row of rows) if (!store().canUnwrap(row)) unreadable.push(`${projectId}:${row.version}`);
        const name = nameOf?.(projectId);
        const active = rows.find((row) => row.state === 'active')?.version;
        return { projectId, ...(name && { name }), ...(active !== undefined && { active }), retired: rows.filter((row) => row.state === 'retired').map((row) => row.version), credentials: count.get(projectId) ?? 0 };
      });
      const onRing = vault.sealedWithAll().filter((c) => c.sealedWith.startsWith('ring:')).length;
      return { projects, onRing, unreadable };
    },
  };

  return self;
}

export const projectKeys = projectKeysOf(credentials);
