/**
 * The access catalog (docs/access-requests.md#the-catalog): one entry per grantable thing. Instance admins create and delete
 * entries; an entry's owners and the admins edit it (only an admin changes what it reaches: the system, the target and the
 * credential); everyone signed in sees the enabled ones they may ask for, without the credential. Every change is audited in
 * the library, with what it was and what it became. A stale edit (`version`) answers 409; an entry with a live grant or an open
 * request is disabled, not deleted.
 *
 * Plain server module (no Next.js import).
 */
import { nanoid } from 'nanoid';
import { ACCESS_LIMITS, durationText, type AccessEntryView, type ApprovalStep } from '../../shared/access';
import { getUser, listUsers } from '../auth/users';
import { recordAudit, auditedTransaction } from '../audit';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { canResource, credentialUsableBy, type Actor } from '../projects/access';
import { AccessError } from './errors';
import { auditActorOf, canCreateEntry, canDeleteEntry, canEditEntry, canEditReach, canSeeEntry, stepApproverIds, type EntryData } from './rules';
import { accessSettings, deleteEntry as deleteEntryRow, entryRow, entryRows, parseJson, saveEntry, type EntryRow } from './store';
import { isSystem, SYSTEMS, targetOf, validateTarget } from './systems';

export const LIVE_GRANTS = ['pending', 'active', 'removing', 'revoke_failed'] as const;

export function parseEntry(row: EntryRow): EntryData {
  const system = isSystem(row.system) ? row.system : 'manual';
  return {
    id: row.id,
    name: row.name,
    ...(row.description && { description: row.description }),
    system,
    target: parseJson(row.target, targetOf(system, {})),
    ...(row.credential_id && { credentialId: row.credential_id }),
    durations: parseJson<Array<number | null>>(row.durations, []),
    steps: parseJson<ApprovalStep[]>(row.steps, []),
    owners: parseJson<string[]>(row.owners, []),
    eligible: parseJson<string[]>(row.eligible, []),
    enabled: Number(row.enabled) === 1,
    version: Number(row.version),
    ...(row.created_by && { createdBy: row.created_by }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** An entry for the library (the snapshot a request keeps, a grant's removal): no access check. */
export function entryData(id: string): EntryData | undefined {
  const row = entryRow(id);
  return row ? parseEntry(row) : undefined;
}

const nameOf = (id: string) => getUser(id)?.name || getUser(id)?.email || id;

export function entryView(actor: Actor, entry: EntryData): AccessEntryView {
  const canEdit = canEditEntry(actor, entry);
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.description && { description: entry.description }),
    system: entry.system,
    target: entry.target,
    durations: entry.durations,
    steps: entry.steps,
    approverNames: stepApproverIds(entry).map(nameOf),
    owners: entry.owners,
    eligibleUserIds: canEdit ? entry.eligible : [],
    enabled: entry.enabled,
    ...(canEdit && entry.credentialId && { credentialId: entry.credentialId }),
    canEdit,
    version: entry.version,
  };
}

/** The entries `actor` may see, by name. */
export function listEntries(actor: Actor): AccessEntryView[] {
  return entryRows().map(parseEntry).filter((entry) => canSeeEntry(actor, entry)).map((entry) => entryView(actor, entry));
}

/** One entry; a 404 when it does not exist or `actor` may not see it. */
export function getEntry(actor: Actor, id: string): AccessEntryView {
  const entry = entryData(id);
  if (!entry || !canSeeEntry(actor, entry)) throw new AccessError('Access entry not found', 404);
  return entryView(actor, entry);
}

export interface EntryInput {
  name: string;
  description?: string;
  system: string;
  target?: Record<string, unknown>;
  credentialId?: string | null;
  durations: Array<number | null>;
  approverIds: string[];
  owners: string[];
  eligibleUserIds?: string[];
  enabled?: boolean;
}

// ---- validation -------------------------------------------------------------------------------------------

function checkName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new AccessError('Give the entry a name', 400, { field: 'name' });
  if (name.length > 120) throw new AccessError('The name is too long (120 characters at most)', 400, { field: 'name' });
  return name;
}

function checkDescription(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (text.length > 500) throw new AccessError('The description is too long (500 characters at most)', 400, { field: 'description' });
  return text || undefined;
}

function checkDurations(value: unknown): Array<number | null> {
  if (!Array.isArray(value) || value.length === 0) throw new AccessError('List at least one duration', 400, { field: 'durations' });
  if (value.length > ACCESS_LIMITS.durationsPerEntry) throw new AccessError(`List at most ${ACCESS_LIMITS.durationsPerEntry} durations`, 400, { field: 'durations' });
  const seen = new Set<number | null>();
  for (const minutes of value) {
    const ok = minutes === null || (typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= ACCESS_LIMITS.maxMinutes);
    if (!ok) throw new AccessError(`A duration is whole minutes from 1 to ${ACCESS_LIMITS.maxMinutes} (90 days), or unlimited`, 400, { field: 'durations' });
    if (seen.has(minutes as number | null)) throw new AccessError(`${durationText(minutes as number | null)} is listed twice`, 400, { field: 'durations' });
    seen.add(minutes as number | null);
  }
  return value as Array<number | null>;
}

function checkPeople(value: unknown, field: string, label: string, options: { min: number; max: number }): string[] {
  if (!Array.isArray(value)) throw new AccessError(`${label} must be a list of people`, 400, { field });
  const ids = [...new Set(value.map((id) => String(id)))];
  if (ids.length < options.min) throw new AccessError(`Name at least ${options.min} ${options.min === 1 ? 'person' : 'people'} in ${label.toLowerCase()}`, 400, { field });
  if (ids.length > options.max) throw new AccessError(`${label} lists too many people (${options.max} at most)`, 400, { field });
  for (const id of ids) {
    const user = getUser(id);
    if (!user || user.disabledAt) throw new AccessError(`${label} names someone who is not an active person here`, 400, { field });
  }
  return ids;
}

/** The credential an entry uses: its type fits the system, the editor may use it, and the access project can. */
function checkCredential(actor: Actor, system: EntryData['system'], credentialId: string | null | undefined): string | undefined {
  const spec = SYSTEMS[system];
  if (!spec.credentialTypes.length) return undefined;
  if (!credentialId) throw new AccessError(`Pick the credential Landflow uses to reach ${spec.label}`, 400, { field: 'credentialId' });
  const credential = credentials.get(credentialId);
  if (!credential || !canResource(actor, 'credential', credentialId, 'use')) throw new AccessError('Credential not found', 400, { field: 'credentialId' });
  if (!spec.credentialTypes.includes(credential.type)) throw new AccessError(`${spec.label} needs a ${spec.credentialTypes.join(' or ')} credential, not ${credential.type}`, 400, { field: 'credentialId' });
  const project = accessSettings().projectId;
  if (project && !credentialUsableBy(credentialId, project)) throw new AccessError('That credential is not shared with the project the access requests flow runs in: share it with that project first', 400, { field: 'credentialId' });
  return credentialId;
}

const stepOf = (approverIds: string[]): ApprovalStep[] => [{ name: 'Approval', approvers: { userIds: approverIds }, approvalsRequired: 1 }];

const summary = (entry: EntryData) => ({ name: entry.name, system: entry.system, target: entry.target.label, durations: entry.durations.map(durationText).join(', '), approvers: stepApproverIds(entry).length, owners: entry.owners.length, enabled: entry.enabled });

function row(entry: EntryData): EntryRow {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? null,
    system: entry.system,
    target: JSON.stringify(entry.target),
    credential_id: entry.credentialId ?? null,
    durations: JSON.stringify(entry.durations),
    steps: JSON.stringify(entry.steps),
    owners: JSON.stringify(entry.owners),
    eligible: JSON.stringify(entry.eligible),
    enabled: entry.enabled ? 1 : 0,
    version: entry.version,
    created_by: entry.createdBy ?? null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

// ---- changes ----------------------------------------------------------------------------------------------

export function createEntry(actor: Actor, input: EntryInput): AccessEntryView {
  if (!canCreateEntry(actor)) throw new AccessError('Only an admin adds an entry to the catalog', 403);
  if (!isSystem(input.system)) throw new AccessError('Pick a system the catalog knows', 400, { field: 'system' });
  if (SYSTEMS[input.system].notOffered) throw new AccessError(SYSTEMS[input.system].notOffered!, 400, { field: 'system' });
  const now = new Date().toISOString();
  const system = input.system;
  const description = checkDescription(input.description);
  const credentialId = checkCredential(actor, system, input.credentialId);
  const entry: EntryData = {
    id: `ae_${nanoid(10)}`,
    name: checkName(input.name),
    ...(description && { description }),
    system,
    target: targetOf(system, validateTarget(system, input.target)),
    ...(credentialId && { credentialId }),
    durations: checkDurations(input.durations),
    steps: stepOf(checkPeople(input.approverIds, 'approverIds', 'Approvers', { min: 1, max: 20 })),
    owners: checkPeople(input.owners, 'owners', 'Owners', { min: 1, max: 20 }),
    eligible: checkPeople(input.eligibleUserIds ?? [], 'eligibleUserIds', 'Who may ask', { min: 0, max: 500 }),
    enabled: input.enabled ?? true,
    version: 1,
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  };
  auditedTransaction(() => {
    saveEntry(row(entry));
    recordAudit({ action: 'access.entry.create', actor: auditActorOf(actor), target: { type: 'access_entry', id: entry.id, name: entry.name }, project: null, summary: `Added the access entry ${entry.name}`, details: { from: null, to: JSON.stringify(summary(entry)) } });
  });
  return entryView(actor, entry);
}

export type EntryPatch = Partial<EntryInput>;

/**
 * Change an entry. `version` is the one the editor read: a newer one answers 409. Owners change the name, description, durations,
 * approvers, owners, who may ask and whether it is on; the system, target and credential only an admin changes. The last owner stays.
 */
export function updateEntry(actor: Actor, id: string, patch: EntryPatch, version: number): AccessEntryView {
  const current = entryData(id);
  if (!current || !canSeeEntry(actor, current)) throw new AccessError('Access entry not found', 404);
  if (!canEditEntry(actor, current)) throw new AccessError('Only the entry’s owners and admins change it', 403);
  const next: EntryData = { ...current };
  const reach = patch.system !== undefined || patch.target !== undefined || patch.credentialId !== undefined;
  if (reach) {
    const system = patch.system !== undefined ? patch.system : current.system;
    if (!isSystem(system)) throw new AccessError('Pick a system the catalog knows', 400, { field: 'system' });
    if (system !== current.system && SYSTEMS[system].notOffered) throw new AccessError(SYSTEMS[system].notOffered!, 400, { field: 'system' });
    const target = targetOf(system, validateTarget(system, patch.target ?? (system === current.system ? current.target.config : undefined)));
    const credentialId = patch.credentialId !== undefined ? patch.credentialId : current.credentialId;
    const changed = system !== current.system || JSON.stringify(target) !== JSON.stringify(current.target) || (credentialId ?? undefined) !== current.credentialId;
    if (changed && !canEditReach(actor)) throw new AccessError('Only an admin changes what an entry reaches: its system, target and credential', 403);
    if (changed) {
      next.system = system;
      next.target = target;
      const checked = checkCredential(actor, system, credentialId);
      if (checked) next.credentialId = checked;
      else delete next.credentialId;
    }
  }
  if (patch.name !== undefined) next.name = checkName(patch.name);
  if (patch.description !== undefined) {
    const description = checkDescription(patch.description);
    if (description) next.description = description;
    else delete next.description;
  }
  if (patch.durations !== undefined) {
    next.durations = checkDurations(patch.durations);
    // An owner may shorten or remove durations; offering unlimited or something longer than the entry ever did is an admin's to give.
    const longest = (list: Array<number | null>) => Math.max(...list.map((m) => (m === null ? Infinity : m)));
    if (!canEditReach(actor) && longest(next.durations) > longest(current.durations)) throw new AccessError('Only an admin offers a longer time or no end: an owner can shorten or remove durations', 403, { field: 'durations' });
  }
  if (patch.approverIds !== undefined) next.steps = stepOf(checkPeople(patch.approverIds, 'approverIds', 'Approvers', { min: 1, max: 20 }));
  if (patch.owners !== undefined) next.owners = checkPeople(patch.owners, 'owners', 'Owners', { min: 1, max: 20 });
  if (patch.eligibleUserIds !== undefined) next.eligible = checkPeople(patch.eligibleUserIds, 'eligibleUserIds', 'Who may ask', { min: 0, max: 500 });
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  next.version = current.version + 1;
  next.updatedAt = new Date().toISOString();
  auditedTransaction(() => {
    const stored = entryRow(id);
    if (!stored || Number(stored.version) !== version) throw new AccessError('Someone else changed this entry: reload it and make your change again', 409, { version: stored ? Number(stored.version) : undefined });
    saveEntry(row(next));
    recordAudit({ action: 'access.entry.update', actor: auditActorOf(actor), target: { type: 'access_entry', id, name: next.name }, project: null, summary: `Changed the access entry ${next.name}`, details: { from: JSON.stringify(summary(current)), to: JSON.stringify(summary(next)) } });
  });
  return entryView(actor, next);
}

/** Delete an entry (admins). One with a live grant or an open request is disabled instead. */
export function deleteEntry(actor: Actor, id: string): void {
  const entry = entryData(id);
  if (!entry || !canSeeEntry(actor, entry)) throw new AccessError('Access entry not found', 404);
  if (!canDeleteEntry(actor)) throw new AccessError('Only an admin deletes an entry; an owner can switch it off', 403);
  const grants = database().get<{ n: number }>(`SELECT COUNT(*) AS n FROM access_grants WHERE entry_id = ? AND status IN (${LIVE_GRANTS.map(() => '?').join(', ')})`, id, ...LIVE_GRANTS)?.n ?? 0;
  const open = database().get<{ n: number }>(`SELECT COUNT(*) AS n FROM access_requests WHERE entry_id = ? AND status = 'pending'`, id)?.n ?? 0;
  if (Number(grants) > 0 || Number(open) > 0) throw new AccessError(`This entry still has ${Number(grants) > 0 ? 'access in place' : 'a request waiting'}: disable it instead, and delete it when that is over`, 409);
  auditedTransaction(() => {
    deleteEntryRow(id);
    recordAudit({ action: 'access.entry.delete', actor: auditActorOf(actor), target: { type: 'access_entry', id, name: entry.name }, project: null, summary: `Deleted the access entry ${entry.name}`, details: { from: JSON.stringify(summary(entry)), to: null } });
  });
}

/** Every active person, for the catalog editor's pickers (name and id only). */
export function activePeople(): Array<{ id: string; name: string }> {
  return listUsers().filter((user) => !user.disabledAt).map((user) => ({ id: user.id, name: user.name || user.email }));
}
