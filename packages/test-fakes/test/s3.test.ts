/** The S3 fake: listing by prefix with continuation pages, ETags that change with the body, a SigV4 header is required, a missing key or bucket is S3's XML error. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteObject, fakeS3, putObject } from '../src/s3';

const s3 = fakeS3();
beforeAll(() => s3.start());
afterAll(() => s3.stop());
beforeEach(() => s3.reset());

const sig = (id = s3.token) => ({ authorization: `AWS4-HMAC-SHA256 Credential=${id}/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=0123456789abcdef0123456789abcdef` });
const get = (path: string, headers: Record<string, string> = sig()) => fetch(`${s3.url}${path}`, { headers });

describe('listing and reading', () => {
  it('lists only the keys under the prefix and pages with a continuation token', async () => {
    const first = await (await get('/docs?list-type=2&prefix=guides/&max-keys=2')).text();
    expect(first).toContain('<Key>guides/faq.md</Key>');
    expect(first).not.toContain('other/secret.md');
    expect(first).toContain('<IsTruncated>true</IsTruncated>');
    const token = /<NextContinuationToken>(.*?)</.exec(first)![1];
    const second = await (await get(`/docs?list-type=2&prefix=guides/&max-keys=2&continuation-token=${token}`)).text();
    expect(second).toContain('<Key>guides/upgrade.md</Key>');
    expect(second).toContain('<IsTruncated>false</IsTruncated>');
  });

  it('answers a body with its ETag; a put changes the ETag, a delete removes the key', async () => {
    const before = await get('/docs/guides/faq.md');
    const etag = before.headers.get('etag');
    expect(await before.text()).toContain('# FAQ');
    await putObject(s3, 'docs', 'guides/faq.md', '# FAQ\n\nChanged.');
    expect((await get('/docs/guides/faq.md')).headers.get('etag')).not.toBe(etag);
    await deleteObject(s3, 'docs', 'guides/faq.md');
    const gone = await get('/docs/guides/faq.md');
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('NoSuchKey');
    expect(Object.keys(s3.state().buckets.docs)).not.toContain('guides/faq.md');
  });
});

describe('authorization and absent things', () => {
  it('refuses a request without a SigV4 header for the access key (403)', async () => {
    expect((await get('/docs?list-type=2', {})).status).toBe(403);
    expect((await get('/docs?list-type=2', sig('AKIAOTHER'))).status).toBe(403);
    expect(s3.requests().filter((r) => r.refused)).toHaveLength(2);
  });
  it('a bucket that does not exist is NoSuchBucket (404)', async () => {
    const response = await get('/missing?list-type=2');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('NoSuchBucket');
  });
  it('lists the buckets', async () => {
    expect(await (await get('/')).text()).toContain('<Name>docs</Name>');
  });
});
