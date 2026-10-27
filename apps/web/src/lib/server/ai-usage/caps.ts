/**
 * Caps per model credential and per user (Settings → AI usage caps), kept in the `settings` table under `ai_caps`.
 * A cap set limits tokens or dollars per day or per month. A credential's caps apply to every call made with it, by any
 * workflow or agent; a user's caps apply to the runs that user started (the editor's Execute, the API, chat), with
 * `allUsers` for users without a set of their own. Enforced like the workflow and agent caps (./index.ts `callLimits`).
 */
import { z } from 'zod';
import type { AiCaps, UsageCapSet } from '../../shared/ai-usage';
import { database, type Database } from '../db';

export const CAPS_KEY = 'ai_caps';

const amount = z.number().min(0).max(1e12).optional();
const capSetSchema = z.object({ name: z.string().max(200).optional(), dayTokens: amount, dayCost: amount, monthTokens: amount, monthCost: amount });
export const aiCapsSchema = z.object({
  credentials: z.record(z.string().min(1).max(200), capSetSchema).default({}),
  users: z.record(z.string().min(1).max(200), capSetSchema).default({}),
  allUsers: capSetSchema.optional(),
});

const LIMITS = ['dayTokens', 'dayCost', 'monthTokens', 'monthCost'] as const;

/** Whether a set limits anything. */
export const capSetActive = (set: UsageCapSet | undefined): set is UsageCapSet => Boolean(set && LIMITS.some((key) => (set[key] ?? 0) > 0));

/** A set without zero limits (a zero means "no cap"); undefined when nothing is left. */
function tidy(set: UsageCapSet | undefined): UsageCapSet | undefined {
  if (!capSetActive(set)) return undefined;
  return { ...(set.name && { name: set.name }), ...Object.fromEntries(LIMITS.filter((key) => (set[key] ?? 0) > 0).map((key) => [key, set[key]])) };
}

function tidyAll(caps: z.infer<typeof aiCapsSchema>): AiCaps {
  const group = (record: Record<string, UsageCapSet>) => Object.fromEntries(Object.entries(record).flatMap(([id, set]) => tidy(set) ? [[id, tidy(set)!]] : []));
  const allUsers = tidy(caps.allUsers);
  return { credentials: group(caps.credentials), users: group(caps.users), ...(allUsers && { allUsers }) };
}

export function aiCaps(db: Database = database()): AiCaps {
  try {
    const raw = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', CAPS_KEY)?.value;
    const parsed = aiCapsSchema.safeParse(raw ? JSON.parse(raw) : {});
    return parsed.success ? tidyAll(parsed.data) : { credentials: {}, users: {} };
  } catch {
    return { credentials: {}, users: {} };
  }
}

export function saveAiCaps(input: unknown, db: Database = database()): AiCaps {
  const caps = tidyAll(aiCapsSchema.parse(input));
  db.upsert('settings', { key: CAPS_KEY, value: JSON.stringify(caps) });
  return caps;
}
