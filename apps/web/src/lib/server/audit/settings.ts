/**
 * Audit settings (Settings → Audit log): how long events are kept and whether runs record the credentials they use.
 * One JSON document under the `audit` key of the `settings` table, read on every call (it is one small row), so every
 * process (a host, a worker) sees a change at once.
 */
import { z } from 'zod';
import { DEFAULT_AUDIT_SETTINGS, type AuditSettings } from '../../shared/audit';
import { database } from '../db';
import { parse } from '../db/rows';

export const AUDIT_SETTINGS_KEY = 'audit';

export const auditSettingsSchema = z.strictObject({
  retentionDays: z.number().int().min(0).max(36_500),
  credentialUse: z.boolean(),
});

export const auditSettingsPatchSchema = auditSettingsSchema.partial();

export function getAuditSettings(): AuditSettings {
  try {
    const saved = parse<Partial<AuditSettings>>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', AUDIT_SETTINGS_KEY)?.value) ?? {};
    const parsed = auditSettingsSchema.safeParse({ ...DEFAULT_AUDIT_SETTINGS, ...saved });
    return parsed.success ? parsed.data : { ...DEFAULT_AUDIT_SETTINGS };
  } catch {
    return { ...DEFAULT_AUDIT_SETTINGS };
  }
}

export function updateAuditSettings(patch: Partial<AuditSettings>): AuditSettings {
  const next = auditSettingsSchema.parse({ ...getAuditSettings(), ...patch });
  database().upsert('settings', { key: AUDIT_SETTINGS_KEY, value: JSON.stringify(next) });
  return next;
}
