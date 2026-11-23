/**
 * C22: the S3 connector: the objects under a bucket prefix, listed with ListObjectsV2 (continuation pages), each with its ETag as
 * the version marker, and read with GetObject. The client is built from the credential's own keys (`s3ClientOf`: never the default
 * AWS chain) and its endpoint was checked against the outbound policy. Only the kinds the loaders read are items; "folder" placeholder
 * keys and other files are skipped. Errors keep the S3 error's name and message, never the keys.
 */
import type { S3Client } from '@aws-sdk/client-s3';
import { SOURCE_LIMITS, type S3Settings } from '../../../shared/knowledge-sources';
import { assertOutboundTarget, s3ClientOf } from '../../nodes/credentials';
import { fileKind } from '../../rag/files';
import { megabytes, readCapped, TooLargeError } from './bounded';
import { SourceError, type Connector, type SourceItem } from './types';

const nameOf = (key: string) => key.slice(key.lastIndexOf('/') + 1);

/** A short, secret-free reason for an S3 failure. */
function reasonOf(caught: unknown): string {
  const e = caught as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  return [e.name && e.name !== 'Error' ? e.name : undefined, e.message, status ? `(${status})` : undefined].filter(Boolean).join(': ').slice(0, 300) || 'S3 request failed';
}

export function s3Connector(settings: S3Settings, data: Record<string, unknown>): Connector {
  let client: S3Client | undefined;
  const open = async (): Promise<S3Client> => {
    if (client) return client;
    const endpoint = String(data.endpoint ?? '').trim();
    if (endpoint) await assertOutboundTarget(new URL(endpoint));
    return (client = await s3ClientOf(data));
  };
  return {
    async list(signal) {
      const s3 = await open();
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const items: SourceItem[] = [];
      let token: string | undefined;
      let seen = 0;
      let complete = true;
      try {
        do {
          const page = await s3.send(new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: settings.prefix || undefined, ContinuationToken: token }), { abortSignal: signal });
          for (const object of page.Contents ?? []) {
            if (!object.Key || object.Key.endsWith('/')) continue;
            if (++seen > SOURCE_LIMITS.listingEntries) {
              complete = false;
              break;
            }
            if (!fileKind({ bytes: new Uint8Array(0), fileName: nameOf(object.Key) })) continue;
            items.push({ key: object.Key, name: nameOf(object.Key), version: (object.ETag ?? `${object.LastModified?.getTime() ?? 0}:${object.Size ?? 0}`).replace(/"/g, ''), ...(object.Size !== undefined && { size: object.Size }) });
          }
          token = complete ? page.NextContinuationToken : undefined;
        } while (token);
      } catch (caught) {
        throw new SourceError(reasonOf(caught));
      }
      return { items, complete, ...(!complete && { note: `The bucket holds more than ${SOURCE_LIMITS.listingEntries} objects under the prefix` }) };
    },
    async fetch(item, signal) {
      const s3 = await open();
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      if ((item.size ?? 0) > SOURCE_LIMITS.fileBytes) throw new SourceError(`Too large (${Math.round((item.size ?? 0) / 1024 / 1024)} MB; the limit is ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB)`);
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: settings.bucket, Key: item.key }), { abortSignal: signal });
        if ((object.ContentLength ?? 0) > SOURCE_LIMITS.fileBytes) throw new SourceError(`Too large (${megabytes(object.ContentLength ?? 0)}; the limit is ${megabytes(SOURCE_LIMITS.fileBytes)})`);
        if (!object.Body) throw new SourceError('The object has no content');
        const bytes = await readCapped(object.Body, SOURCE_LIMITS.fileBytes);
        return { bytes, fileName: item.name, ...(object.ContentType && object.ContentType !== 'application/octet-stream' && { mimeType: object.ContentType }) };
      } catch (caught) {
        if (caught instanceof SourceError) throw caught instanceof TooLargeError ? new SourceError(`Too large (the limit is ${megabytes(SOURCE_LIMITS.fileBytes)})`) : caught;
        throw new SourceError(reasonOf(caught));
      }
    },
  };
}
