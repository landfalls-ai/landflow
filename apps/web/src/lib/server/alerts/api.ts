/** Request schemas and helpers shared by the alert routes (/api/settings/alerts/**, /api/workflows/[id]/alert). */
import { z } from 'zod';
import { DEFAULT_THROTTLE_MINUTES, RULE_KIND_EVENTS, type AlertsView, type WorkflowAlertView } from '../../shared/alerts';
import { mailConfigured } from '../auth/mail';
import { CredentialError } from '../credentials/vault';
import { error } from '../http';
import { AlertError, alertStore } from './store';

const kind = z.enum(['email', 'slack', 'webhook', 'telegram', 'teams', 'discord']);
const event = z.enum(['failed', 'timedOut', 'retriesExhausted', 'waiting']);
const ruleKind = z.enum(['runs', 'failureRate', 'plugin', 'cost', 'evaluation']);

const config = z
  .object({
    to: z.string().max(2_000),
    webhookUrl: z.string().max(2_000),
    url: z.string().max(2_000),
    secret: z.string().max(500),
    credentialId: z.string().max(200),
    chatId: z.string().max(200),
  })
  .partial();

export const channelCreateSchema = z.object({ name: z.string().min(1).max(120), kind, config });
export const channelPatchSchema = z.object({ name: z.string().min(1).max(120), config }).partial();

const scope = z.object({ mode: z.enum(['all', 'ids', 'tags']), ids: z.array(z.string().min(1)).max(500).optional(), tags: z.array(z.string().min(1)).max(100).optional() });

const ruleFields = {
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  workflows: scope,
  // Rules of the other kinds alert on their own events: left out, they are filled in.
  events: z.array(event).min(1),
  kind: ruleKind.optional(),
  failureRate: z.object({ minRuns: z.number().int().min(1).max(100_000), percent: z.number().min(0).max(100), windowMinutes: z.number().int().min(1).max(1_440) }).optional(),
  plugins: z.object({ ids: z.array(z.string().min(1)).max(500).optional(), graceSeconds: z.number().int().min(0).max(86_400), notifyRecovery: z.boolean() }).optional(),
  cost: z.object({ thresholdPercent: z.number().min(1).max(100) }).optional(),
  evaluation: z.object({ metric: z.string().max(200).optional(), below: z.number().min(0).max(1_000).optional(), dropPercent: z.number().min(0).max(100).optional() }).optional(),
  waitingMinutes: z.number().int().min(1).max(43_200).optional(),
  includeManual: z.boolean().optional(),
  channelIds: z.array(z.string().min(1)).max(50),
  throttleMinutes: z.number().int().min(0).max(1_440),
};

export const ruleCreateSchema = z
  .object({ ...ruleFields, events: ruleFields.events.optional(), enabled: ruleFields.enabled.default(true), throttleMinutes: ruleFields.throttleMinutes.default(DEFAULT_THROTTLE_MINUTES) })
  .transform((rule) => ({ ...rule, events: rule.events ?? (rule.kind && rule.kind !== 'runs' ? RULE_KIND_EVENTS[rule.kind] : ['failed' as const]) }));
export const rulePatchSchema = z.object(ruleFields).partial();

/** The workflow editor's "Notify on failure": which channels, how often. */
export const workflowAlertSchema = z.object({
  channelIds: z.array(z.string().min(1)).min(1).max(50),
  events: z.array(event).min(1).optional(),
  throttleMinutes: z.number().int().min(0).max(1_440).optional(),
});

export function alertsView(): AlertsView {
  return { channels: alertStore.channels(), rules: alertStore.rules(), email: { configured: mailConfigured() } };
}

export function workflowAlertView(workflowId: string): WorkflowAlertView {
  const rule = alertStore.shortcutRule(workflowId);
  return { ...(rule && { rule }), channels: alertStore.channels().map(({ id, name, kind }) => ({ id, name, kind })) };
}

/** Run `fn`, turning AlertErrors (and a vault error, e.g. a secret that can't be decrypted) into JSON errors. */
export async function withAlertErrors(fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (caught) {
    if (caught instanceof AlertError || caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
}
