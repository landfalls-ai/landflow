/**
 * Environments (LANDFLOW_ENVIRONMENT): the view the shell and Settings → Environments show, saving the settings,
 * and pulling this environment's branch with its publish-on-pull choice. Promotion is ./promote.ts, protection
 * ./protection.ts, per-environment variable values ./variables.ts.
 */
import { z } from 'zod';
import { hasSecretReference } from '@landflow/engine';
import type { EnvironmentSettings, EnvironmentView, PullPublishMode } from '../../shared/secrets';
import { credentials as vault } from '../credentials/vault';
import { dataTables } from '../datatables';
import { pullFromRepository, sourceControlView } from '../sync/git';
import { branchOf, currentEnvironment, defaultPublishMode, ENVIRONMENT_NAME, EnvironmentError, environmentNames, protection, readEnvironmentSettings, writeEnvironmentSettings } from './settings';

export * from './settings';
export { environmentValues } from './variables';
export { assertWorkflowsWritable, ProtectedEnvironmentError, protectedMessage, protectedWriteRefusal } from './protection';
export { promoteEnvironment, PROMOTED_COMMIT, PROMOTED_FROM, StalePromotionError, type PromoteInput } from './promote';

export const PUBLISH_MODES = ['file', 'all', 'none'] as const satisfies readonly PullPublishMode[];

export function environmentView(): EnvironmentView {
  const name = currentEnvironment();
  const settings = readEnvironmentSettings();
  const guard = protection();
  const source = sourceControlView();
  return {
    ...(name && { name }),
    protected: guard.protected,
    protectedSource: guard.source,
    ...(name && source.config && { branch: source.config.branch }),
    environments: environmentNames().map((environment) => ({ name: environment, branch: branchOf(environment), current: environment === name })),
    publishOnPull: defaultPublishMode(),
    credentialMap: (settings.credentialMap ?? []).map((m) => ({ ...m, ...(vault.get(m.credentialId) && { credentialName: vault.get(m.credentialId)!.name }) })),
    rowTables: (settings.rowTables ?? []).map((id) => ({ id, ...(tableName(id) && { name: tableName(id) }) })),
    secretMappings: settings.secretMappings ?? [],
    sourceControl: source.configured,
  };
}

function findTable(idOrName: string) {
  try {
    return dataTables().findTable(idOrName);
  } catch {
    return undefined;
  }
}
const tableName = (id: string) => findTable(id)?.name;

const branchName = z.string().trim().min(1).max(200).regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'Not a branch name');

export const environmentSettingsSchema = z.strictObject({
  protected: z.boolean().optional(),
  branches: z.record(z.string().regex(ENVIRONMENT_NAME), branchName).optional(),
  environments: z.array(z.string().regex(ENVIRONMENT_NAME, 'Environment names start with a letter: letters, digits, - and _')).max(20).optional(),
  publishOnPull: z.enum(PUBLISH_MODES).optional(),
  credentialMap: z
    .array(z.strictObject({ type: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(200), credentialId: z.string().min(1).max(100) }))
    .max(500)
    .optional(),
  rowTables: z.array(z.string().min(1).max(100)).max(500).optional(),
  secretMappings: z
    .array(
      z.strictObject({
        type: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200),
        field: z.string().trim().min(1).max(200),
        value: z.string().trim().min(1).max(2000).refine(hasSecretReference, 'Map a secret field to an expression that reads $secrets, like {{ $secrets.vault.api.key }}'),
        environment: z.string().regex(ENVIRONMENT_NAME).optional(),
      }),
    )
    .max(500)
    .optional(),
});

/** Change the settings (the fields given); the result is the new view. */
export function saveEnvironmentSettings(input: z.output<typeof environmentSettingsSchema>): EnvironmentView {
  for (const mapping of input.credentialMap ?? []) {
    const credential = vault.get(mapping.credentialId);
    if (!credential) throw new EnvironmentError(`Credential ${mapping.credentialId} (for “${mapping.name}”) not found`, 404);
    if (credential.type !== mapping.type) throw new EnvironmentError(`“${credential.name}” is a ${credential.type} credential, not ${mapping.type}`);
  }
  // Tables by id or name; stored by id.
  const rowTables = input.rowTables?.map((key) => {
    const table = findTable(key);
    if (!table) throw new EnvironmentError(`Data table “${key}” not found`, 404);
    return table.id;
  });
  const fields = new Set<string>();
  for (const mapping of input.secretMappings ?? []) {
    const key = `${mapping.type}\u0000${mapping.name}\u0000${mapping.field}\u0000${mapping.environment ?? ''}`;
    if (fields.has(key)) throw new EnvironmentError(`“${mapping.name}” field “${mapping.field}” is mapped twice${mapping.environment ? ` for ${mapping.environment}` : ''}`);
    fields.add(key);
  }
  const keys = new Set<string>();
  for (const mapping of input.credentialMap ?? []) {
    const key = `${mapping.type}\u0000${mapping.name}`;
    if (keys.has(key)) throw new EnvironmentError(`“${mapping.name}” (${mapping.type}) is mapped twice`);
    keys.add(key);
  }
  const next: EnvironmentSettings = { ...readEnvironmentSettings() };
  for (const [key, value] of Object.entries(input) as Array<[keyof EnvironmentSettings, unknown]>) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (next.environments && !next.environments.length) delete next.environments;
  if (rowTables) next.rowTables = [...new Set(rowTables)];
  writeEnvironmentSettings(next);
  return environmentView();
}

/** Pull this environment's branch (Settings → Source control) with the publish-on-pull setting unless `publish` says otherwise. */
export function pullEnvironment(input: { dryRun?: boolean; prune?: boolean; force?: boolean; publish?: PullPublishMode; by?: string } = {}) {
  return pullFromRepository({ ...input, publish: input.publish ?? defaultPublishMode() });
}
