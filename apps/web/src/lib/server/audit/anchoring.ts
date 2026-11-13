/**
 * Anchoring signed chain heads outside the database (./signing): after each signature the head is copied to an S3 bucket
 * (MinIO included; one object per head, `<prefix><seq>-<hash>.json`) and/or POSTed to a webhook, so an attacker who rewrites the audit
 * log can't also rewrite the copies. The leader signs on a schedule (Settings → Audit log → Integrity has the interval, the targets and Sign now) and retries heads that didn't reach their targets. Settings live in `audit-anchoring.json`
 * (or its `config_files` row, ../config-store.ts), secrets sealed with the credentials key and never returned.
 *
 * S3 needs explicit keys (never the default AWS credential chain). The webhook gets `{ event: "audit.head", head }` as JSON with
 * `X-Landflow-Event`, `X-Landflow-Timestamp` and, with a secret, `X-Landflow-Signature: sha256=HMAC(secret, "<ts>.<body>")`.
 */
import { createHmac } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { DEFAULT_AUDIT_ANCHORING, type AuditAnchoringSettings, type AuditAnchoringView, type AuditHeadRecord } from '../../shared/audit';
import { ConfigFile } from '../config-store';
import { credentials } from '../credentials/vault';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { latestHead, markAnchored, signHead, signingKeys, unanchoredHeads } from './signing';
import { publicUrl, publicUrlConfigured } from '../config';
import { HttpError } from '../errors';

const SECRETS = [
  ['s3', 'secretAccessKey'],
  ['webhook', 'secret'],
] as const;

export const anchoringSchema = z.strictObject({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(10_080),
  s3: z
    .strictObject({
      bucket: z.string().trim().min(1).max(255),
      endpoint: z.string().trim().max(500).optional(),
      region: z.string().trim().max(60).optional(),
      prefix: z.string().trim().max(300).optional(),
      accessKeyId: z.string().trim().max(200).optional(),
      secretAccessKey: z.string().max(500).optional(),
      forcePathStyle: z.boolean().optional(),
    })
    .nullable(),
  webhook: z.strictObject({ url: z.string().trim().min(1).max(2_000), secret: z.string().max(500).optional() }).nullable(),
});
export const anchoringPatchSchema = anchoringSchema.partial();

const file = singleton('audit-anchoring-file', () => new ConfigFile<Partial<AuditAnchoringSettings>>('audit-anchoring.json'));

export class AnchoringError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

/** The settings with secrets sealed (as stored). */
function stored(): AuditAnchoringSettings {
  return { ...DEFAULT_AUDIT_ANCHORING, ...file.read() };
}

function opened(settings: AuditAnchoringSettings): AuditAnchoringSettings {
  const open = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return credentials.openSecret(value);
    } catch {
      return undefined;
    }
  };
  return {
    ...settings,
    ...(settings.s3 && { s3: { ...settings.s3, secretAccessKey: open(settings.s3.secretAccessKey) } }),
    ...(settings.webhook && { webhook: { ...settings.webhook, secret: open(settings.webhook.secret) } }),
  };
}

/** What Settings shows: no secrets, `secretsSet` says which are set. */
export function anchoringView(): AuditAnchoringView {
  const settings = stored();
  const latest = latestHead();
  const keys = signingKeys();
  return {
    settings: {
      ...settings,
      ...(settings.s3 && { s3: { ...settings.s3, secretAccessKey: undefined } }),
      ...(settings.webhook && { webhook: { ...settings.webhook, secret: undefined } }),
    },
    secretsSet: SECRETS.filter(([group, field]) => Boolean((settings[group] as Record<string, unknown> | undefined)?.[field])).map(([group, field]) => `${group}.${field}`),
    ...(latest && { latest: { seq: latest.seq, signedAt: latest.signedAt, ...(latest.anchoredAt && { anchoredAt: latest.anchoredAt }), ...(latest.anchorError && { anchorError: latest.anchorError }) } }),
    ...(keys.at(-1) && { keyId: keys.at(-1)!.keyId }),
  };
}

function checkUrl(value: string, what: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new AnchoringError(`The ${what} must be an http:// or https:// URL`);
  }
}

/** Save settings; empty secrets keep their saved value. */
export function updateAnchoring(patch: Partial<z.infer<typeof anchoringSchema>>): AuditAnchoringView {
  const current = stored();
  const next: AuditAnchoringSettings = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.intervalMinutes !== undefined) next.intervalMinutes = patch.intervalMinutes;
  if (patch.s3 !== undefined) {
    if (patch.s3 === null) delete next.s3;
    else {
      const { secretAccessKey, ...rest } = patch.s3;
      if (rest.endpoint) rest.endpoint = checkUrl(rest.endpoint, 'S3 endpoint');
      const secret = secretAccessKey ? credentials.sealSecret(secretAccessKey) : current.s3?.secretAccessKey;
      next.s3 = { ...rest, ...(secret && { secretAccessKey: secret }) };
    }
  }
  if (patch.webhook !== undefined) {
    if (patch.webhook === null) delete next.webhook;
    else {
      const secret = patch.webhook.secret ? credentials.sealSecret(patch.webhook.secret) : current.webhook?.secret;
      next.webhook = { url: checkUrl(patch.webhook.url, 'webhook URL'), ...(secret && { secret }) };
    }
  }
  file.write(next);
  return anchoringView();
}

/** The object key of a head in the bucket. */
export const anchorKey = (prefix: string | undefined, seq: number, hash: string) => `${prefix ?? 'audit-heads/'}${String(seq).padStart(12, '0')}-${hash.slice(0, 12)}.json`;

async function putS3(s3: NonNullable<AuditAnchoringSettings['s3']>, head: AuditHeadRecord) {
  if (!s3.accessKeyId || !s3.secretAccessKey) throw new Error('S3 anchoring needs an access key id and secret (the default AWS credentials are never used)');
  const client = new S3Client({
    region: s3.region || 'us-east-1',
    ...(s3.endpoint && { endpoint: s3.endpoint }),
    forcePathStyle: s3.forcePathStyle !== false,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  });
  try {
    const payload = JSON.parse(head.head.payload) as { hash: string };
    await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: anchorKey(s3.prefix, head.seq, payload.hash), Body: JSON.stringify(head.head, null, 2), ContentType: 'application/json' }));
  } finally {
    client.destroy();
  }
}

async function postWebhook(webhook: NonNullable<AuditAnchoringSettings['webhook']>, head: AuditHeadRecord) {
  const body = JSON.stringify({ event: 'audit.head', head: head.head });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(webhook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-landflow-event': 'audit.head',
      'x-landflow-timestamp': timestamp,
      ...(webhook.secret && { 'x-landflow-signature': `sha256=${createHmac('sha256', webhook.secret).update(`${timestamp}.${body}`).digest('hex')}` }),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The webhook answered ${response.status}`);
}

/** Copy the signed heads that aren't anchored yet to every configured target. Returns how many reached all of them. */
export async function anchorPending(): Promise<{ anchored: number; failed: number; targets: number }> {
  const settings = opened(stored());
  const targets = [settings.s3 && 'S3', settings.webhook && 'the webhook'].filter(Boolean) as string[];
  if (!targets.length) return { anchored: 0, failed: 0, targets: 0 };
  let anchored = 0;
  let failed = 0;
  for (const head of unanchoredHeads()) {
    const errors: string[] = [];
    if (settings.s3) await putS3(settings.s3, head).catch((error: Error) => errors.push(`S3: ${error.message}`));
    if (settings.webhook) await postWebhook(settings.webhook, head).catch((error: Error) => errors.push(`webhook: ${error.message}`));
    if (errors.length) {
      failed++;
      markAnchored(head.seq, errors.join('; '));
      logger.warn('audit head anchoring failed', { 'landflow.audit.head_seq': head.seq, error: errors.join('; ') });
    } else {
      anchored++;
      markAnchored(head.seq);
    }
  }
  return { anchored, failed, targets: targets.length };
}

const instanceName = () => (publicUrlConfigured() ? publicUrl() : undefined);

/** Sign the head now (a new signature only when the chain moved) and anchor what is waiting. */
export async function signAndAnchor(): Promise<{ record: AuditHeadRecord; created: boolean; anchor: Awaited<ReturnType<typeof anchorPending>> }> {
  const signed = await signHead({ instance: instanceName() });
  const anchor = await anchorPending();
  return { ...signed, record: latestHead() ?? signed.record, anchor };
}

// ---------------------------------------------------------------------------
// The schedule (the leader)
// ---------------------------------------------------------------------------

const TICK_MS = 60_000;

interface State {
  timer?: ReturnType<typeof setInterval>;
  running?: Promise<unknown>;
}

const state = () => singleton<State>('audit-head-schedule', () => ({}));

/** One pass of the schedule: sign when the interval has passed since the last signature, then retry what isn't anchored. */
export async function scheduleTick(now = Date.now()): Promise<void> {
  const settings = stored();
  if (!settings.enabled) return;
  try {
    const last = latestHead();
    if (!last || now - Date.parse(last.signedAt) >= settings.intervalMinutes * 60_000) await signHead({ instance: instanceName() }).catch((error: Error) => logger.warn('audit head not signed', { error: error.message }));
    await anchorPending();
  } catch (error) {
    logger.warn('audit head schedule failed', { error: (error as Error).message });
  }
}

export const auditHeads = {
  start() {
    const s = state();
    if (s.timer) return;
    s.timer = setInterval(() => {
      if (!s.running) s.running = scheduleTick().finally(() => (s.running = undefined));
    }, TICK_MS);
    s.timer.unref?.();
    s.running = scheduleTick().finally(() => (s.running = undefined));
  },
  async stop() {
    const s = state();
    if (s.timer) clearInterval(s.timer);
    s.timer = undefined;
    await s.running?.catch(() => undefined);
  },
};
