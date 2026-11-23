/**
 * A stateful S3: buckets of objects (text), listed by prefix with continuation pages, read with an ETag, written and deleted, so a
 * test of a connector asserts on what the bucket holds, not on request shapes. Path-style addressing only (`/<bucket>/<key>`),
 * which is what the credential's "Force Path Style" does.
 *
 * Endpoints: GET /<bucket>?list-type=2&prefix=&max-keys=&continuation-token= (ListObjectsV2, XML), GET /<bucket>/<key> (the body,
 * `ETag`, `Content-Length`; 404 `NoSuchKey`), PUT and DELETE /<bucket>/<key>, GET / (ListBuckets). Authorization: a SigV4 header
 * for the access key id of the credential (the signature is not verified, the presence of the header and the key id are: a client
 * that fell back to the default credential chain, or sent nothing, is a 403 the test sees). A bucket the fake does not hold is 404 `NoSuchBucket`.
 * Text objects only (kept as UTF-8). Use `putObject` / `deleteObject` to change a bucket mid-test.
 */
import { createHash } from 'node:crypto';
import { defineFake, type Fake, type FakeReply, type FakeRequest } from './harness';

export const S3_ACCESS_KEY = 'AKIAFAKETESTKEY00000';
export const S3_SECRET_KEY = 'fake-secret-access-key-for-tests-only';

export interface S3Object {
  body: string;
  etag: string;
}
export interface S3State {
  /** Bucket → key → object. */
  buckets: Record<string, Record<string, S3Object>>;
}
export interface S3Seed {
  accessKeyId: string;
  /** Bucket → key → text. Default: one bucket `docs` with a few files under `guides/` and one under `other/`. */
  buckets: Record<string, Record<string, string>>;
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const xml = (name: string, inner: string) => `<?xml version="1.0" encoding="UTF-8"?><${name} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inner}</${name}>`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const error = (status: number, code: string, message: string): FakeReply => ({ status, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>fake</RequestId></Error>` });

function route(state: S3State, request: FakeRequest): FakeReply {
  const [bucketName, ...rest] = decodeURIComponent(request.path).replace(/^\/+/, '').split('/');
  if (!bucketName) {
    const buckets = Object.keys(state.buckets).map((name) => `<Bucket><Name>${escape(name)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`).join('');
    return { headers: { 'content-type': 'application/xml' }, body: xml('ListAllMyBucketsResult', `<Owner><ID>fake</ID></Owner><Buckets>${buckets}</Buckets>`) };
  }
  const bucket = state.buckets[bucketName];
  if (!bucket) return error(404, 'NoSuchBucket', 'The specified bucket does not exist');
  const key = rest.join('/');
  if (!key) {
    if (request.method !== 'GET') return error(405, 'MethodNotAllowed', 'Only listing is supported');
    const prefix = request.query.get('prefix') ?? '';
    const max = Math.min(1000, Number(request.query.get('max-keys') ?? 1000) || 1000);
    const after = request.query.get('continuation-token') ?? '';
    const keys = Object.keys(bucket).filter((k) => k.startsWith(prefix) && k > after).sort();
    const page = keys.slice(0, max);
    const truncated = keys.length > max;
    const contents = page.map((k) => `<Contents><Key>${escape(k)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;${bucket[k].etag}&quot;</ETag><Size>${Buffer.byteLength(bucket[k].body)}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
    return {
      headers: { 'content-type': 'application/xml' },
      body: xml('ListBucketResult', `<Name>${escape(bucketName)}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${escape(page[page.length - 1])}</NextContinuationToken>` : ''}${contents}`),
    };
  }
  if (request.method === 'PUT') {
    const body = request.raw.toString('utf8');
    bucket[key] = { body, etag: md5(body) };
    return { status: 200, headers: { etag: `"${bucket[key].etag}"` }, body: '' };
  }
  if (request.method === 'DELETE') {
    delete bucket[key];
    return { status: 204, body: '' };
  }
  const object = bucket[key];
  if (!object) return error(404, 'NoSuchKey', 'The specified key does not exist.');
  return { headers: { etag: `"${object.etag}"`, 'content-length': String(Buffer.byteLength(object.body)), 'content-type': 'application/octet-stream' }, body: request.method === 'HEAD' ? '' : object.body };
}

export function fakeS3(seed: Partial<S3Seed> = {}): Fake<S3State> {
  const accessKeyId = seed.accessKeyId ?? S3_ACCESS_KEY;
  const buckets = seed.buckets ?? {
    docs: { 'guides/install.md': '# Install\n\nRun the installer.\n', 'guides/upgrade.md': '# Upgrade\n\nBack up first.\n', 'guides/faq.md': '# FAQ\n\nAsk away.\n', 'other/secret.md': '# Other\n\nNot under the prefix.\n' },
  };
  return defineFake<S3State>({
    name: 's3',
    token: accessKeyId,
    // SigV4 sends `Authorization: AWS4-HMAC-SHA256 Credential=<key id>/<date>/<region>/s3/aws4_request, SignedHeaders=…, Signature=…`.
    auth: (request, id) => String(request.headers.authorization ?? '').startsWith(`AWS4-HMAC-SHA256 Credential=${id}/`) && /Signature=[0-9a-f]{16,}/.test(String(request.headers.authorization)),
    refusal: () => error(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.'),
    scriptBody: (script) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${script.status === 503 ? 'SlowDown' : 'InternalError'}</Code><Message>scripted</Message></Error>`,
    initial: () => ({ buckets: Object.fromEntries(Object.entries(buckets).map(([name, files]) => [name, Object.fromEntries(Object.entries(files).map(([k, body]) => [k, { body, etag: md5(body) }]))])) }),
    routes: route,
  });
}

const signed = (fake: Fake<S3State>) => ({ authorization: `AWS4-HMAC-SHA256 Credential=${fake.token}/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=0123456789abcdef0123456789abcdef` });

/** Put (or replace) a text object, through the fake's own API. */
export async function putObject(fake: Fake<S3State>, bucket: string, key: string, body: string): Promise<void> {
  const response = await fetch(`${fake.url}/${bucket}/${key}`, { method: 'PUT', headers: signed(fake), body });
  if (!response.ok) throw new Error(`putObject: ${response.status}`);
}

/** Delete an object, through the fake's own API. */
export async function deleteObject(fake: Fake<S3State>, bucket: string, key: string): Promise<void> {
  const response = await fetch(`${fake.url}/${bucket}/${key}`, { method: 'DELETE', headers: signed(fake) });
  if (!response.ok) throw new Error(`deleteObject: ${response.status}`);
}
