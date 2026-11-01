/**
 * Landflow's OCI registry, pull only (lib/server/kagent/oci.ts): the images of the Claude Code plugins pinned for agents on
 * kagent, and the runtime images put there for Harnesses, which kagent's nodes pull by digest. Public, like a registry's
 * anonymous pulls: only images in Landflow's store answer, by digest; plugins hold files of public GitHub repositories and
 * runtime images only public toolchains.
 */
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { handler } from '@/lib/server/http';
import { manifestType, ociBlobFile, ociManifest } from '@/lib/server/kagent/oci';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path?: string[] }> };

const VERSION = { 'docker-distribution-api-version': 'registry/2.0' };
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

const failure = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ errors: [{ code, message }] }), { status, headers: { ...VERSION, 'content-type': 'application/json' } });

async function serve({ params }: Ctx, head: boolean) {
  const path = (await params).path ?? [];
  // GET /v2/: the version check clients start with.
  if (!path.length) return new Response(head ? null : '{}', { headers: { ...VERSION, 'content-type': 'application/json' } });
  const [kind, reference] = path.slice(-2);
  const repository = path.slice(0, -2).join('/');
  if (!REPOSITORY.test(repository) || (kind !== 'manifests' && kind !== 'blobs')) return failure(404, 'NAME_UNKNOWN', 'This registry serves only the images Landflow keeps for kagent');
  if (kind === 'manifests') {
    const body = await ociManifest(reference);
    if (!body) return failure(404, 'MANIFEST_UNKNOWN', `No image ${reference} (images are pulled by digest)`);
    return new Response(head ? null : new Uint8Array(body), {
      headers: { ...VERSION, 'content-type': manifestType(body), 'content-length': String(body.length), 'docker-content-digest': reference },
    });
  }
  // A runtime image's layers run to hundreds of megabytes: streamed from the file, not read into memory.
  const file = ociBlobFile(reference);
  if (!file) return failure(404, 'BLOB_UNKNOWN', `No blob ${reference} (images are pulled by digest)`);
  const size = statSync(file).size;
  return new Response(head ? null : (Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>), {
    headers: { ...VERSION, 'content-type': 'application/octet-stream', 'content-length': String(size), 'docker-content-digest': reference },
  });
}

export const GET = handler((_request: Request, context: Ctx) => serve(context, false));
export const HEAD = handler((_request: Request, context: Ctx) => serve(context, true));
