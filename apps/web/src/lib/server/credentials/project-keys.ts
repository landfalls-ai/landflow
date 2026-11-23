/**
 * C31: what the host does with project keys, above the vault: creating a project's key is the store's (./project-key-store,
 * on first use), re-sealing after a move, rotating one project's key, destroying a deleted project's keys, root rotation's
 * re-wrap, and the owner's `migrate` (every credential onto its project's key, one at a time, so a run that stops
 * is simply run again) and `revert` (everything back onto the ring, the way back before a downgrade to a host without
 * version 3 values). Audit follows the constitution: creating a key and the root re-wrap are fail-open (as root
 * rotation is); project-key rotation, destruction, migrate and revert are fail-closed (`auditedChange`). Only counts,
 * ids and versions are ever audited or logged, never key bytes.
 */
import { auditedChange, recordAudit } from '../audit';
import { logger } from '../telemetry/logger';
import { credentials, type CredentialVault } from './vault';
import { ProjectKeyError, type ProjectKeyStore } from './project-key-store';

export interface ResealResult {
  resealed: number;
  current: number;
  /** Credential ids that could not be opened or written: they stay as they were, readable. */
  failed: string[];
  /** Credentials with no project to seal with (migrate only). */
  skipped: number;
}

export interface ProjectKeysStatus {
  projects: Array<{ projectId: string; name?: string; active?: number; retired: number[]; credentials: number }>;
  /** Credentials still sealed with a ring key. */
  onRing: number;
  /** `<projectId>:<version>` of keys this process can't unwrap (the ring lacks the key that wrapped them). */
  unreadable: string[];
}

function resealEach(credentials: CredentialVault, ids: string[], target: 'project' | 'ring'): ResealResult {
  const result: ResealResult = { resealed: 0, current: 0, failed: [], skipped: 0 };
  for (const id of ids) {
    try {
      const done = credentials.resealOne(id, target);
      if (done === 'resealed') result.resealed += 1;
      else if (done === 'current') result.current += 1;
      else result.skipped += 1;
    } catch (error) {
      logger.warn('a credential could not be re-sealed', { 'landflow.credential.id': id, 'landflow.project_key.target': target, error: error instanceof Error ? error.name : 'error' });
      result.failed.push(id);
    }
  }
  return result;
}

/** The operations on one vault's project keys (tests run two vaults, as two processes would); `projectKeys` is the host's. */
export function projectKeysOf(credentials: CredentialVault) {
  const store = (): ProjectKeyStore => credentials.projectKeys;
  const self = {
    /** The project's active key (the first call creates version 1). */
    activeFor: (projectId: string) => store().activeFor(projectId),
    keyFor: (projectId: string, version: number) => store().keyFor(projectId, version),

    /** The credentials sealed with this project's keys. */
    credentialsOf(projectId: string): string[] {
      return [...credentials.projectKeyUse()].filter(([, [project]]) => project === projectId).map(([id]) => id);
    },

    /** After a move: seal each moved credential with its new project's key (D11). A failure leaves it on the old key, readable, and counted. */
    resealCredentials(ids: string[]): ResealResult {
      return resealEach(credentials, ids, 'project');
    },

    /**
     * Root rotation (FR-4): every key whose wrap names another ring key is wrapped again with the primary; no credential row
     * is touched. Fail-open audit.
     */
    rewrapAll(): { rewrapped: number; current: number; failed: string[] } {
      const result = store().rewrapAll();
      if (result.rewrapped || result.failed.length) {
        recordAudit({
          action: 'encryption.project_key.rewrapped',
          target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
          summary: `Re-wrapped ${result.rewrapped} project key${result.rewrapped === 1 ? '' : 's'} with ${credentials.primaryKid}`,
          details: { primary: credentials.primaryKid, rewrapped: result.rewrapped, current: result.current, failed: result.failed.length },
        });
      }
      return result;
    },

    /** Rotate one project's key (FR-7): a new active version, that project's credentials re-sealed one at a time, the old version destroyed once nothing names it. Fail-closed audit. */
    rotate(projectId: string): { version: number; resealed: number; failed: string[]; destroyed: number[] } {
      return auditedChange(
        (result) => ({
          action: 'encryption.project_key.rotated',
          target: { type: 'project', id: projectId },
          project: projectId,
          summary: `Rotated the encryption key of project ${projectId}`,
          details: { projectId, ...(result && { version: result.version, resealed: result.resealed, failed: result.failed.length, destroyed: result.destroyed.length }) },
        }),
        () => {
          const named = self.credentialsOf(projectId);
          const { version } = store().addVersion(projectId);
          const done = resealEach(credentials, named, 'project');
          // Only what was sealed with this project's key moved: the ones that failed keep their old version, which therefore stays.
          const use = credentials.projectKeyUse();
          const stillNamed = new Set([...use.values()].filter(([project]) => project === projectId).map(([, v]) => v));
          const destroyed = store()
            .rows(projectId)
            .filter((row) => row.version !== version && !stillNamed.has(row.version))
            .map((row) => row.version);
          if (destroyed.length) store().destroy(projectId, destroyed);
          return { version, resealed: done.resealed, failed: done.failed, destroyed };
        },
      );
    },

    /**
     * A project went: its keys are deleted when no credential value names them (FR-6), else retired (and deleted by a later
     * `migrate` or re-seal once nothing names them). Fail-closed audit: when the event can't be stored the keys are retired, not deleted.
     */
    destroyIfUnused(projectId: string): 'destroyed' | 'retired' | 'none' {
      const rows = store().rows(projectId);
      if (!rows.length) return 'none';
      const named = new Set([...credentials.projectKeyUse().values()].filter(([project]) => project === projectId).map(([, version]) => version));
      const unused = rows.filter((row) => !named.has(row.version)).map((row) => row.version);
      store().retireAll(projectId);
      if (!unused.length) return 'retired';
      try {
        auditedChange(
          () => ({
            action: 'encryption.project_key.destroyed',
            target: { type: 'project', id: projectId },
            project: projectId,
            summary: `Destroyed the encryption key of project ${projectId}`,
            details: { projectId, versions: unused.join(',') },
          }),
          () => store().destroy(projectId, unused),
        );
      } catch (error) {
        logger.warn('a project key was kept: its destruction could not be audited', { 'landflow.project_key.project': projectId, error: error instanceof Error ? error.name : 'error' });
        return 'retired';
      }
      return unused.length === rows.length ? 'destroyed' : 'retired';
    },

    /**
     * Every credential onto its project's active key, one at a time and idempotent; then retired keys nothing names, and keys of projects
     * `exists` says are gone, are deleted. Fail-closed audit.
     */
    migrate(exists?: (projectId: string) => boolean): ResealResult & { destroyed: string[]; done: boolean } {
      return auditedChange(
        (result) => ({
          action: 'encryption.project_key.migrated',
          target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
          summary: 'Moved credentials onto project keys',
          details: { ...(result && { resealed: result.resealed, current: result.current, failed: result.failed.length, skipped: result.skipped, destroyed: result.destroyed.length }) },
        }),
        () => {
          const done = resealEach(credentials, credentials.sealedWithAll().map((c) => c.id), 'project');
          const destroyed = sweep(exists);
          return { ...done, destroyed, done: done.failed.length === 0 };
        },
      );
    },

    /** Every credential back onto the ring's primary key as version 2 (before a downgrade to a host without project keys). Keys are kept. Fail-closed audit. */
    revert(): ResealResult & { onProjectKeys: number; done: boolean } {
      return auditedChange(
        (result) => ({
          action: 'encryption.project_key.reverted',
          target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
          summary: 'Moved credentials back onto the key ring',
          details: { ...(result && { resealed: result.resealed, current: result.current, failed: result.failed.length, onProjectKeys: result.onProjectKeys }) },
        }),
        () => {
          const done = resealEach(credentials, credentials.sealedWithAll().map((c) => c.id), 'ring');
          const onProjectKeys = credentials.projectKeyUse().size;
          return { ...done, onProjectKeys, done: done.failed.length === 0 && onProjectKeys === 0 };
        },
      );
    },

    /** Where everything stands: per project its versions and credentials, and what is still on the ring. `nameOf` adds project names. */
    status(nameOf?: (projectId: string) => string | undefined): ProjectKeysStatus {
      const use = credentials.projectKeyUse();
      const count = new Map<string, number>();
      for (const [project] of use.values()) count.set(project, (count.get(project) ?? 0) + 1);
      const byProject = new Map<string, ReturnType<ProjectKeyStore['rows']>>();
      for (const row of store().rows()) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
      const unreadable: string[] = [];
      const projects = [...new Set([...byProject.keys(), ...count.keys()])].sort().map((projectId) => {
        const rows = byProject.get(projectId) ?? [];
        for (const row of rows) {
          try {
            store().keyFor(projectId, row.version);
          } catch (error) {
            if (error instanceof ProjectKeyError) unreadable.push(`${projectId}:${row.version}`);
          }
        }
        const name = nameOf?.(projectId);
        const active = rows.find((row) => row.state === 'active')?.version;
        return { projectId, ...(name && { name }), ...(active !== undefined && { active }), retired: rows.filter((row) => row.state === 'retired').map((row) => row.version), credentials: count.get(projectId) ?? 0 };
      });
      const onRing = credentials.sealedWithAll().filter((c) => c.sealedWith.startsWith('ring:')).length;
      return { projects, onRing, unreadable };
    },
  };

  /** Delete retired versions nothing names, and every version of a project that no longer exists and that nothing names. Returns `<projectId>:<version>` of each. */
  function sweep(exists?: (projectId: string) => boolean): string[] {
    const named = new Set([...credentials.projectKeyUse().values()].map(([project, version]) => `${project}:${version}`));
    const gone: string[] = [];
    for (const row of store().rows()) {
      const id = `${row.project_id}:${row.version}`;
      if (named.has(id)) continue;
      if (row.state === 'retired' || (exists && !exists(row.project_id))) {
        store().destroy(row.project_id, [row.version]);
        gone.push(id);
      }
    }
    return gone;
  }

  return self;
}

export const projectKeys = projectKeysOf(credentials);
