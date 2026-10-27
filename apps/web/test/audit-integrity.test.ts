/**
 * The audit log's integrity features beyond the hash chain: Ed25519-signed chain heads (lib/server/audit/signing.ts: signing,
 * offline verification, tampering, key rotation, a broken chain is never signed), their anchoring to a webhook (signed bodies,
 * retries) and, with LANDFLOW_INTEGRATION=audit-anchor, to a real MinIO bucket (anchoring.ts); the routes (admins only, secrets
 * never returned); and SIEM destinations limited to chosen projects (destinations.ts scope, applied as events are queued).
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditHeadView, SignedAuditHead } from '@/lib/shared/audit';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-audit-integrity-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const audit = await import('@/lib/server/audit');
const { queryEvents } = await import('@/lib/server/audit/store');
const chain = await import('@/lib/server/audit/chain');
const signing = await import('@/lib/server/audit/signing');
const anchoring = await import('@/lib/server/audit/anchoring');
const { auditDestinations } = await import('@/lib/server/audit/destinations');
const projects = await import('@/lib/server/projects');
const headRoute = await import('@/app/api/audit/head/route');
const anchoringRoute = await import('@/app/api/settings/audit/anchoring/route');
const runRoute = await import('@/app/api/settings/audit/anchoring/run/route');
const rotateRoute = await import('@/app/api/settings/audit/anchoring/rotate-key/route');
const destinationsRoute = await import('@/app/api/settings/audit/destinations/route');
const destinationRoute = await import('@/app/api/settings/audit/destinations/[id]/route');

const db = () => database();
const raw = (sql: string, ...params: Array<string | number | null>) => db().sqlite.prepare(sql).run(...params);
const record = (n: number, prefix: string) => Array.from({ length: n }, (_v, i) => audit.recordAudit({ action: 'settings.update', summary: `${prefix} ${i}`, target: { type: 'settings', id: prefix } })!);
const req = (url: string, init: RequestInit = {}) => new Request(`http://audit.test${url}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
const body = (value: unknown) => ({ method: 'PUT', body: JSON.stringify(value) });

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}
let receiver: Server;
const received: Received[] = [];
let receiverStatus = 200;
let receiverUrl = '';

let member: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  member = await createUser({ email: 'pat@integrity.test', name: 'Pat', role: 'member', password: 'member-password-1' });
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.statusCode = receiverStatus;
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/anchor`;
});

afterAll(async () => {
  enableTestAuth();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('signed chain heads', () => {
  it('signs the verified head, offline verification needs only the public key, and an unchanged chain is not signed twice', async () => {
    record(4, 'signing');
    const { record: first, created } = await signing.signHead({ instance: 'http://landflow.test' });
    expect(created).toBe(true);
    const report = await chain.verifyChain(db());
    expect(JSON.parse(first.head.payload)).toMatchObject({ format: 'landflow.audit.head/1', seq: report.head!.seq, hash: report.head!.hash, keyId: first.head.keyId, instance: 'http://landflow.test' });
    const verdict = signing.verifySignedHead(first.head, first.head.publicKey);
    expect(verdict.ok).toBe(true);
    const again = await signing.signHead();
    expect(again.created).toBe(false);
    expect(again.record.head.signature).toBe(first.head.signature);

    record(1, 'signing-more');
    const next = await signing.signHead();
    expect(next.created).toBe(true);
    expect(next.record.seq).toBeGreaterThan(first.seq);
    expect(signing.signingKeys()).toHaveLength(1);
  });

  it('rejects a changed payload or signature, another key, and says why', async () => {
    const { head } = signing.latestHead()!;
    const key = head.publicKey;
    const forged: SignedAuditHead = { ...head, payload: head.payload.replace(/"seq":(\d+)/, (_m, n) => `"seq":${Number(n) - 1}`) };
    expect(signing.verifySignedHead(forged, key)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match') });
    expect(signing.verifySignedHead({ ...head, signature: Buffer.from('x'.repeat(64)).toString('base64') }, key)).toMatchObject({ ok: false });
    expect(signing.verifySignedHead({ ...head, format: 'other' } as unknown as SignedAuditHead, key)).toMatchObject({ ok: false, reason: expect.stringContaining('Not a Landflow') });
    // An attacker who signs with a key of their own can't pass as the one you pinned.
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const pair = generateKeyPairSync('ed25519');
    const otherPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const payload = JSON.stringify({ ...JSON.parse(head.payload), seq: 1 });
    const impostor: SignedAuditHead = { ...head, payload, keyId: signing.keyIdOf(otherPem), publicKey: otherPem, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') };
    expect(signing.verifySignedHead(impostor).ok).toBe(true); // self-consistent...
    expect(signing.verifySignedHead(impostor, key)).toMatchObject({ ok: false, reason: expect.stringContaining('not the key you trust') }); // ...but not the pinned key
  });

  it('never signs a broken chain, and keeps the old key valid after a rotation', async () => {
    const victim = record(1, 'sign-break')[0];
    raw('UPDATE audit_events SET summary = ? WHERE id = ?', 'changed', victim.id);
    const before = signing.latestHead()!.seq;
    await expect(signing.signHead()).rejects.toThrow(/hash chain is broken/);
    expect(signing.latestHead()!.seq).toBe(before);
    raw('UPDATE audit_events SET summary = ? WHERE id = ?', victim.summary, victim.id);

    const old = signing.latestHead()!;
    const rotated = signing.rotateSigningKey();
    expect(rotated.keyId).not.toBe(old.head.keyId);
    const { record: fresh } = await signing.signHead();
    expect(fresh.head.keyId).toBe(rotated.keyId);
    expect(signing.signingKeys().map((k) => k.keyId)).toEqual([old.head.keyId, rotated.keyId]);
    // Heads signed before the rotation still verify against their own key.
    expect(signing.verifySignedHead(old.head, signing.signingKeys()[0].publicKey).ok).toBe(true);
  });
});

describe('anchoring', () => {
  it('posts signed heads to a webhook (HMAC-signed body), keeps the failure and retries', async () => {
    enableTestAuth();
    const saved = await anchoringRoute.PUT(req('/api/settings/audit/anchoring', body({ enabled: true, intervalMinutes: 5, webhook: { url: receiverUrl, secret: 'hook-secret' } })));
    expect(saved.status).toBe(200);
    // Secrets never come back; the view says which are set.
    const view = (await (await anchoringRoute.GET(req('/api/settings/audit/anchoring'))).json()) as { settings: { webhook: { url: string; secret?: string } }; secretsSet: string[] };
    expect(view.settings.webhook).toEqual({ url: receiverUrl });
    expect(view.secretsSet).toEqual(['webhook.secret']);
    // A PUT that leaves the secret empty keeps it.
    await anchoringRoute.PUT(req('/api/settings/audit/anchoring', body({ webhook: { url: receiverUrl } })));
    expect(((await (await anchoringRoute.GET(req('/api/settings/audit/anchoring'))).json()) as { secretsSet: string[] }).secretsSet).toEqual(['webhook.secret']);

    record(2, 'anchor');
    receiverStatus = 500;
    const failing = await runRoute.POST(req('/api/settings/audit/anchoring/run', { method: 'POST' }));
    expect(failing.status).toBe(200);
    const failed = (await failing.json()) as { anchored: boolean; anchorError: string };
    expect(failed.anchored).toBe(false);
    expect(failed.anchorError).toMatch(/webhook answered 500/);
    expect(queryEvents({ action: ['audit.sign_head'] }, { limit: 1 }).events[0]).toMatchObject({ outcome: 'failure' });

    receiverStatus = 200;
    received.length = 0;
    const result = await anchoring.anchorPending();
    expect(result.failed).toBe(0);
    expect(result.anchored).toBeGreaterThanOrEqual(1);
    const last = received.at(-1)!;
    expect(last.headers['x-landflow-event']).toBe('audit.head');
    const expected = createHmac('sha256', 'hook-secret').update(`${last.headers['x-landflow-timestamp']}.${last.body}`).digest('hex');
    expect(last.headers['x-landflow-signature']).toBe(`sha256=${expected}`);
    const delivered = JSON.parse(last.body) as { event: string; head: SignedAuditHead };
    expect(signing.verifySignedHead(delivered.head, signing.signingKeys().at(-1)!.publicKey).ok).toBe(true);
    expect(signing.latestHead()!.anchoredAt).toBeTruthy();
    expect(signing.unanchoredHeads()).toHaveLength(0);
  });

  it('the schedule signs when the interval passed and only then', async () => {
    const before = signing.latestHead()!;
    await anchoring.scheduleTick(Date.parse(before.signedAt) + 60_000);
    expect(signing.latestHead()!.seq).toBe(before.seq);
    record(1, 'tick');
    await anchoring.scheduleTick(Date.parse(before.signedAt) + 6 * 60_000);
    expect(signing.latestHead()!.seq).toBeGreaterThan(before.seq);
    // Switched off: nothing is signed.
    anchoring.updateAnchoring({ enabled: false });
    record(1, 'tick-off');
    const after = signing.latestHead()!.seq;
    await anchoring.scheduleTick(Date.now() + 24 * 3_600_000);
    expect(signing.latestHead()!.seq).toBe(after);
    anchoring.updateAnchoring({ enabled: true });
  });

  it.skipIf(process.env.LANDFLOW_INTEGRATION !== 'audit-anchor')('puts heads in a real MinIO bucket', async () => {
    const { S3Client, GetObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const endpoint = process.env.LANDFLOW_TEST_MINIO ?? 'http://127.0.0.1:59000';
    const prefix = `audit-test-${Date.now()}/`;
    anchoring.updateAnchoring({ webhook: null, s3: { bucket: 'landflow', endpoint, region: 'us-east-1', prefix, accessKeyId: 'landflow', secretAccessKey: 'landflow-dev-only', forcePathStyle: true } });
    record(2, 's3-anchor');
    const { record: head } = await anchoring.signAndAnchor();
    expect(head.anchorError).toBeUndefined();
    expect(head.anchoredAt).toBeTruthy();
    const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'landflow', secretAccessKey: 'landflow-dev-only' } });
    const listed = await client.send(new ListObjectsV2Command({ Bucket: 'landflow', Prefix: prefix }));
    expect(listed.Contents?.length).toBeGreaterThanOrEqual(1);
    const object = listed.Contents!.at(-1)!;
    const text = await (await client.send(new GetObjectCommand({ Bucket: 'landflow', Key: object.Key! }))).Body!.transformToString();
    const envelope = JSON.parse(text) as SignedAuditHead;
    expect(signing.verifySignedHead(envelope, signing.signingKeys().at(-1)!.publicKey).ok).toBe(true);
    expect(object.Key).toBe(anchoring.anchorKey(prefix, head.seq, JSON.parse(head.head.payload).hash));
    anchoring.updateAnchoring({ s3: null });
  });

  it('refuses S3 targets without explicit keys (the default AWS credentials are never used)', async () => {
    anchoring.updateAnchoring({ webhook: null, s3: { bucket: 'nowhere', endpoint: 'http://127.0.0.1:1' } });
    record(1, 'no-keys');
    const result = await anchoring.signAndAnchor();
    expect(result.anchor.failed).toBe(1);
    expect(signing.latestHead()!.anchorError).toMatch(/access key id and secret/);
    anchoring.updateAnchoring({ s3: null });
  });
});

describe('the routes', () => {
  it('GET /api/audit/head answers the head and keys to admins only; rotating a key is audited', async () => {
    enableTestAuth();
    const view = (await (await headRoute.GET(req('/api/audit/head'))).json()) as AuditHeadView;
    expect(view.head?.algorithm).toBe('Ed25519');
    expect(view.keys.length).toBeGreaterThanOrEqual(2);
    expect(view.keys.at(-1)!.keyId).toBe(view.head!.keyId);
    expect(JSON.stringify(view)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(view)).not.toContain('private_key');
    const rotated = await rotateRoute.POST(req('/api/settings/audit/anchoring/rotate-key', { method: 'POST' }));
    expect(rotated.status).toBe(201);
    enableTestAuth(member);
    try {
      expect((await headRoute.GET(req('/api/audit/head'))).status).toBe(403);
    } finally {
      enableTestAuth();
    }
  });
});

describe('SIEM destinations per project', () => {
  it('queues an event only for destinations whose scope takes its project (instance events when chosen)', async () => {
    enableTestAuth();
    const a = projects.createTeamProject({ name: 'TMP SIEM A' });
    const b = projects.createTeamProject({ name: 'TMP SIEM B' });
    const create = async (name: string, scope?: { projectIds: string[]; instance: boolean }) => {
      const response = await destinationsRoute.POST(req('/api/settings/audit/destinations', { method: 'POST', body: JSON.stringify({ name, kind: 'syslog', config: { host: '127.0.0.1', port: 5140, protocol: 'udp' }, ...(scope && { scope }) }) }));
      expect(response.status).toBe(201);
      return ((await response.json()) as { destination: { id: string; scope?: unknown } }).destination;
    };
    const everything = await create('all events');
    const onlyA = await create('A and instance', { projectIds: [a.id], instance: true });
    const onlyB = await create('B only', { projectIds: [b.id], instance: false });
    expect(everything.scope).toBeUndefined();
    expect(onlyA.scope).toEqual({ projectIds: [a.id], instance: true });

    const queuedFor = (eventId: string) =>
      db()
        .all<{ destination_id: string }>('SELECT destination_id FROM audit_outbox WHERE event_id = ?', eventId)
        .map((row) => row.destination_id)
        .sort();
    const inA = audit.recordAudit({ action: 'settings.update', summary: 'in A', project: a.id })!;
    const inB = audit.recordAudit({ action: 'settings.update', summary: 'in B', project: b.id })!;
    const instance = audit.recordAudit({ action: 'settings.update', summary: 'instance wide', project: null })!;
    expect(queuedFor(inA.id)).toEqual([everything.id, onlyA.id].sort());
    expect(queuedFor(inB.id)).toEqual([everything.id, onlyB.id].sort());
    expect(queuedFor(instance.id)).toEqual([everything.id, onlyA.id].sort());

    // Changing the scope applies to new events; null sends everything again; a scope that takes nothing, or an unknown project, is refused.
    const patch = (id: string, value: unknown) => destinationRoute.PATCH(req(`/api/settings/audit/destinations/${id}`, { method: 'PATCH', body: JSON.stringify(value) }), { params: Promise.resolve({ id }) });
    expect((await patch(onlyB.id, { scope: { projectIds: [], instance: true } })).status).toBe(200);
    const instance2 = audit.recordAudit({ action: 'settings.update', summary: 'instance again', project: null })!;
    expect(queuedFor(instance2.id)).toEqual([everything.id, onlyA.id, onlyB.id].sort());
    expect(queuedFor(inB.id)).toEqual([everything.id, onlyB.id].sort());
    expect((await patch(onlyB.id, { scope: { projectIds: [], instance: false } })).status).toBe(400);
    expect((await patch(onlyB.id, { scope: { projectIds: ['prj_missing'], instance: false } })).status).toBe(400);
    expect((await patch(onlyA.id, { scope: null })).status).toBe(200);
    expect(auditDestinations.get(onlyA.id)!.scope).toBeUndefined();
    const inB2 = audit.recordAudit({ action: 'settings.update', summary: 'in B again', project: b.id })!;
    expect(queuedFor(inB2.id)).toEqual([everything.id, onlyA.id].sort());
    // Disabled destinations get nothing either way.
    await patch(everything.id, { enabled: false });
    const inA2 = audit.recordAudit({ action: 'settings.update', summary: 'in A again', project: a.id })!;
    expect(queuedFor(inA2.id)).toEqual([onlyA.id]);
  });
});
