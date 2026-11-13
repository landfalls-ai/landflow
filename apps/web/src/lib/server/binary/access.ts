/**
 * How nodes reach the binary store (docs/protocol.md §11). The host's own nodes get a direct client; remote
 * plugins get `binaryAccess`: the host's `/api/binary` URL and a signed token scoped to the execution (it writes
 * there and reads that plus the scopes of the call's input files). Inline files a node returns are stored before
 * the next node sees them. Files are deleted with their execution, and an hourly sweep removes scopes whose
 * execution is gone (a crash, an upload whose run never started).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BINARY_ID, binaryRefsOf, binaryScopeOf, completeBinaryRef, DEFAULT_MIME_TYPE, type BinaryAccess, type BinaryRef, type NodeItem } from '@landflow/protocol';
import { NodeOperationError, type BinaryDataClient } from '@landflow/sdk';
import type { ResolvedNodeType } from '@landflow/engine';
import { database } from '../db';
import { resetSingleton, singleton, singletonKeys } from '../singleton';
import { onExecutionDeleted, store } from '../store';
import { logger } from '../telemetry';
import { FilesystemBinaryStore, readAll, type BinarySource, type BinaryStore } from './store';

const MiB = 1024 * 1024;
const HOUR_MS = 3_600_000;
/** How long a plugin's token works: the longest Execute call, with room to spare. */
export const TOKEN_TTL_MS = HOUR_MS;

/** LANDFLOW_BINARY_MAX_BYTES (uploads and stored files) and LANDFLOW_BINARY_MAX_INLINE_BYTES (inline files a node returns). */
export function binaryLimits() {
  return {
    maxBytes: Number(process.env.LANDFLOW_BINARY_MAX_BYTES) || 256 * MiB,
    maxInlineBytes: Number(process.env.LANDFLOW_BINARY_MAX_INLINE_BYTES) || 16 * MiB,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The configured store: `<data dir>/binary` (LANDFLOW_BINARY_DIR), or S3 with LANDFLOW_BINARY_STORE=s3. */
export function binaryStore(): Promise<BinaryStore> {
  return singleton(singletonKeys.binaryStore, async (): Promise<BinaryStore> => {
    if ((process.env.LANDFLOW_BINARY_STORE ?? 'filesystem').toLowerCase() === 's3') {
      const { S3BinaryStore, s3OptionsFromEnv } = await import('./s3');
      return new S3BinaryStore(s3OptionsFromEnv());
    }
    return new FilesystemBinaryStore(process.env.LANDFLOW_BINARY_DIR ?? join(store.dir, 'binary'));
  });
}

/** Use another store (tests). */
export function setBinaryStore(replacement: BinaryStore) {
  resetSingleton(singletonKeys.binaryStore);
  singleton(singletonKeys.binaryStore, () => Promise.resolve(replacement));
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Sub-executions writing into their parent's scope (`child → scope`): this process's copy of `binary_scope_links`
 * (migration 1200), which keeps the link for a child that resumes after a restart or on another worker.
 */
const sharedScopes = singleton('binary-shared-scopes', () => new Map<string, string>());

/** A write to `binary_scope_links`: if it fails, the link still holds in this process. */
function saveLink(write: () => void) {
  try {
    write();
  } catch (error) {
    logger.warn('could not save a sub-execution’s binary scope', { error: (error as Error).message });
  }
}

/** The scope a sub-execution shares with its parent: this process's copy, else the saved link. */
function linkedScope(executionId: string): string | undefined {
  const known = sharedScopes.get(executionId);
  if (known) return known;
  try {
    const scope = database().get<{ scope: string }>('SELECT scope FROM binary_scope_links WHERE execution_id = ?', executionId)?.scope;
    if (scope) sharedScopes.set(executionId, scope);
    return scope;
  } catch {
    // No database yet (Postgres loads at boot): its own scope.
    return undefined;
  }
}

/** Where an execution's new files go: its own id, or its parent's scope while the parent waits for it. */
export function scopeFor(executionId: string): string {
  return linkedScope(executionId) ?? executionId;
}

/**
 * A sub-execution its parent waits for writes into the parent's scope, so the files it returns live as long as the
 * parent run (n8n copies them instead). Saved, so a child that resumes after a restart (or on another worker in queue
 * mode) still writes there. `undefined` ends the sharing.
 */
export function shareBinaryScope(childExecutionId: string, parentExecutionId: string | undefined) {
  if (parentExecutionId) {
    const scope = scopeFor(parentExecutionId);
    sharedScopes.set(childExecutionId, scope);
    saveLink(() => database().upsert('binary_scope_links', { execution_id: childExecutionId, scope, created_at: new Date().toISOString() }));
  } else {
    sharedScopes.delete(childExecutionId);
    saveLink(() => database().delete('binary_scope_links', { execution_id: childExecutionId }));
  }
}

/** Whether a sub-execution writes into `scope` (its parent's), in this process or according to the saved links. */
function isSharedScope(scope: string): boolean {
  if ([...sharedScopes.values()].includes(scope)) return true;
  try {
    return Boolean(database().get('SELECT 1 AS one FROM binary_scope_links WHERE scope = ? LIMIT 1', scope));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** `w`: the scope written to; `r`: other scopes it may read; `x`: expiry (epoch seconds). */
export interface BinaryTokenClaims {
  w: string;
  r: string[];
  x: number;
}

/** LANDFLOW_BINARY_SECRET, else a random key per process (tokens only live for one plugin call). */
const secret = () => singleton(singletonKeys.binaryTokenSecret, () => (process.env.LANDFLOW_BINARY_SECRET ? Buffer.from(process.env.LANDFLOW_BINARY_SECRET) : randomBytes(32)));

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function signBinaryToken(claims: BinaryTokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `lfb1.${payload}.${sign(payload)}`;
}

/** The claims of a valid, unexpired token, else undefined. */
export function verifyBinaryToken(token: string | undefined, now = Date.now()): BinaryTokenClaims | undefined {
  const [version, payload, signature] = String(token ?? '').split('.');
  if (version !== 'lfb1' || !payload || !signature) return undefined;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BinaryTokenClaims;
    return typeof claims.w === 'string' && Array.isArray(claims.r) && claims.x * 1000 > now ? claims : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a token may read the file `id`. */
export function tokenCanRead(claims: BinaryTokenClaims, id: string): boolean {
  const scope = binaryScopeOf(id);
  return scope !== undefined && (scope === claims.w || claims.r.includes(scope));
}

/** Where plugins reach the host: LANDFLOW_INTERNAL_URL, else this process on 127.0.0.1. */
export function internalUrl(): string {
  return (process.env.LANDFLOW_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
}

/** `ExecuteRequest.binaryAccess` for a call of this execution with these inputs. */
export function binaryAccessFor(executionId: string, inputs: NodeItem[][], now = Date.now()): BinaryAccess {
  const w = scopeFor(executionId);
  const r = [...new Set(binaryRefsOf(inputs.flat()).map((ref) => binaryScopeOf(ref.id)))].filter((scope): scope is string => Boolean(scope) && scope !== w);
  return { url: `${internalUrl()}/api/binary`, token: signBinaryToken({ w, r, x: Math.floor((now + TOKEN_TTL_MS) / 1000) }) };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

async function openOrFail(ref: BinaryRef) {
  const file = ref.id ? await (await binaryStore()).open(ref.id) : undefined;
  if (!file) throw new NodeOperationError(`The file ${ref.fileName ?? ref.id ?? ''} is no longer stored`.replace('  ', ' '), { description: 'Its execution was deleted, or it was never saved.' });
  return file;
}

/** The direct client the host's in-process nodes get (they may read any file; they write into the execution's scope). */
export function hostBinaryClient(executionId: string): BinaryDataClient {
  return {
    read: async (ref) => readAll((await openOrFail(ref)).stream),
    stream: async (ref) => Readable.toWeb((await openOrFail(ref)).stream) as ReadableStream<Uint8Array>,
    write: async (data, meta) => (await binaryStore()).put(scopeFor(executionId), data as BinarySource, meta, { maxBytes: binaryLimits().maxBytes }),
  };
}

/** Store bytes for an execution (webhook and form uploads, nodes that don't go through the SDK helpers). */
export async function storeBinary(executionId: string, data: BinarySource, meta: { mimeType?: string; fileName?: string }): Promise<BinaryRef> {
  return (await binaryStore()).put(scopeFor(executionId), data, meta, { maxBytes: binaryLimits().maxBytes });
}

/**
 * Normalize the files of a node's output in place: inline `data` is stored and replaced by a stored ref, stored
 * refs get their derived fields, and anything malformed is dropped.
 */
export async function storeInlineBinary(outputs: NodeItem[][], executionId: string): Promise<void> {
  const { maxInlineBytes } = binaryLimits();
  for (const branch of outputs) {
    for (const item of branch ?? []) {
      if (!item || item.binary === undefined) continue;
      if (!item.binary || typeof item.binary !== 'object' || Array.isArray(item.binary)) {
        delete item.binary;
        continue;
      }
      for (const [name, ref] of Object.entries(item.binary)) {
        if (!ref || typeof ref !== 'object') delete item.binary[name];
        else if (ref.id) {
          if (!BINARY_ID.test(ref.id)) delete item.binary[name];
          else if (ref.data !== undefined || !ref.fileType || !ref.mimeType) {
            const { data: _data, ...stored } = ref;
            item.binary[name] = completeBinaryRef({ ...stored, mimeType: stored.mimeType || DEFAULT_MIME_TYPE, fileSize: Number(stored.fileSize) || 0 });
          }
        } else if (typeof ref.data === 'string') {
          if ((ref.data.length * 3) / 4 > maxInlineBytes + 3) throw new NodeOperationError(`The inline file “${name}” is larger than ${maxInlineBytes} bytes; upload it through the binary API instead`);
          const stored = await storeBinary(executionId, Buffer.from(ref.data, 'base64'), { mimeType: ref.mimeType, fileName: ref.fileName });
          item.binary[name] = { ...stored, ...(ref.fileExtension && { fileExtension: ref.fileExtension }) };
        } else delete item.binary[name];
      }
      if (!Object.keys(item.binary).length) delete item.binary;
    }
  }
}

/**
 * The registry wraps every resolved node type with this: in-process nodes get the host client, remote ones
 * `binaryAccess`, and inline files in the response are stored.
 */
export function withBinaryData(resolved: ResolvedNodeType): ResolvedNodeType {
  const inProcess = resolved.transport === 'in-process';
  return {
    ...resolved,
    execute: async (request, extras) => {
      const response = inProcess
        ? await resolved.execute(request, { ...extras, binary: hostBinaryClient(request.executionId) })
        : await resolved.execute({ ...request, binaryAccess: binaryAccessFor(request.executionId, request.inputs) }, extras);
      await storeInlineBinary(response.outputs ?? [], request.executionId);
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Delete an execution's files (its own scope; a parent's shared scope goes with the parent). */
export async function deleteExecutionBinary(executionId: string): Promise<number> {
  sharedScopes.delete(executionId);
  for (const [child, scope] of sharedScopes) if (scope === executionId) sharedScopes.delete(child);
  saveLink(() => {
    database().delete('binary_scope_links', { execution_id: executionId });
    database().delete('binary_scope_links', { scope: executionId });
  });
  try {
    return await (await binaryStore()).deleteScope(executionId);
  } catch (error) {
    logger.warn('could not delete binary data', { 'landflow.execution.id': executionId, error: (error as Error).message });
    return 0;
  }
}

/**
 * Delete scopes whose execution no longer exists, once their newest file is older than `graceMs` (an upload's run
 * may not have started yet; a running execution isn't saved until it finishes or waits).
 */
export async function sweepBinaryData(isKept: (scope: string) => boolean, graceMs = HOUR_MS, now = Date.now()): Promise<number> {
  const binary = await binaryStore();
  let removed = 0;
  for (const { scope, modifiedAt } of await binary.scopes()) {
    if (now - modifiedAt < graceMs || isKept(scope) || isSharedScope(scope)) continue;
    await binary.deleteScope(scope);
    removed++;
  }
  return removed;
}

/** Started once by bootstrap: delete files with their execution, and sweep orphaned scopes now and every hour. */
export function startBinaryMaintenance() {
  singleton('binary-maintenance', () => {
    onExecutionDeleted((executionId) => void deleteExecutionBinary(executionId));
    const sweep = async () => {
      // Queue mode: the leader main sweeps (the store is shared).
      const { leads } = await import('../cluster/state');
      if (!leads()) return;
      try {
        const { liveExecution } = await import('../runner');
        const { isDatasetScope } = await import('../evaluations/store');
        // Evaluation datasets (an uploaded CSV or JSON file) live in scopes of their own, kept while their workflow exists.
        const removed = await sweepBinaryData((scope) => Boolean(liveExecution(scope) || store.getExecution(scope) || isDatasetScope(scope, (workflowId) => Boolean(store.getWorkflow(workflowId)))));
        if (removed) logger.info('removed orphaned binary data', { 'landflow.binary.scopes': removed });
      } catch (error) {
        logger.warn('binary data sweep failed', { error: (error as Error).message });
      }
    };
    setTimeout(() => void sweep(), 60_000).unref?.();
    setInterval(() => void sweep(), HOUR_MS).unref?.();
    return true;
  });
}
