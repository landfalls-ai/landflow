/**
 * C22: the settings of a source, checked when it is saved: the shapes per kind, the limits, and for a site the outbound policy
 * (in the production profile a start address on a private network is refused at save time, as `safeFetch` would at sync time).
 */
import { SOURCE_LIMITS, SOURCE_CREDENTIAL_TYPE, type CrawlSettings, type DriveSettings, type FolderSettings, type S3Settings, type SourceKind } from '../../shared/knowledge-sources';
import { folderFiles } from '../agents/knowledge';
import { HttpError } from '../errors';
import { credentials } from '../credentials/vault';
import { assertOutboundTarget } from '../nodes/credentials';
import { credentialUsableBy } from '../projects/access';
import { homeProjectId } from '../projects/store';

export class SourceSettingsError extends HttpError {
  static readonly errorName: string = 'SourceSettingsError';
  constructor(message: string) {
    super(message, 400, { expose: true });
  }
}
const bad = (message: string): never => {
  throw new SourceSettingsError(message);
};

const text = (value: unknown, label: string, max: number, required = true): string => {
  if (value === undefined || value === null || value === '') return required ? bad(`${label} is required`) : '';
  if (typeof value !== 'string') return bad(`${label} must be text`);
  const trimmed = value.trim();
  if (!trimmed && required) bad(`${label} is required`);
  if (trimmed.length > max) bad(`${label} is too long (at most ${max} characters)`);
  return trimmed;
};

const whole = (value: unknown, label: string, min: number, max: number, fallback: number): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return bad(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};

/** A crawl's start address must be reachable under the outbound policy: literal addresses and what the name resolves to. */
export async function assertCrawlTarget(url: URL): Promise<void> {
  try {
    await assertOutboundTarget(url);
  } catch (caught) {
    if (caught instanceof HttpError) throw new SourceSettingsError(caught.message);
    throw caught;
  }
}

/** The checked settings of a source, its place (the unique part) and a default name. Throws SourceSettingsError. */
export async function validateSettings(kind: SourceKind, raw: Record<string, unknown>): Promise<{ settings: FolderSettings | S3Settings | CrawlSettings | DriveSettings; location: string; name: string }> {
  if (kind === 'folder') {
    const folder = text(raw.folder, 'The folder', 200).replace(/\/+$/, '');
    try {
      await folderFiles(folder, 1);
    } catch (caught) {
      return bad((caught as Error).message);
    }
    return { settings: { folder }, location: folder, name: folder };
  }
  if (kind === 's3') {
    const bucket = text(raw.bucket, 'The bucket', 63);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) bad('The bucket name is not valid (3 to 63 lowercase letters, digits, dots and dashes)');
    const prefix = text(raw.prefix, 'The prefix', 1024, false).replace(/^\/+/, '');
    return { settings: { bucket, prefix }, location: `${bucket}/${prefix}`, name: `${bucket}${prefix ? `/${prefix}` : ''}` };
  }
  if (kind === 'crawl') {
    const startUrl = text(raw.startUrl, 'The start address', 2000);
    let url: URL;
    try {
      url = new URL(startUrl);
    } catch {
      return bad('The start address is not a web address');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('The start address must begin with http:// or https://');
    if (url.username || url.password) bad('The start address must not hold a user name or password');
    url.hash = '';
    await assertCrawlTarget(url);
    const maxDepth = whole(raw.maxDepth, 'The depth', 0, SOURCE_LIMITS.crawlDepth, 2);
    const maxPages = whole(raw.maxPages, 'The page limit', 1, SOURCE_LIMITS.crawlPages, 100);
    return { settings: { startUrl: url.href, maxDepth, maxPages }, location: url.href, name: url.host };
  }
  const folderId = text(raw.folderId, 'The Drive folder', 200);
  if (!/^[\w-]{4,200}$/.test(folderId)) bad('The Drive folder is not valid: paste the folder’s id (the end of its address)');
  return { settings: { folderId, includeSubfolders: raw.includeSubfolders === true || raw.includeSubfolders === 'true' }, location: folderId, name: `Drive ${folderId.slice(0, 8)}` };
}

/** The type of credential a kind needs, or undefined when it needs none. */
export const credentialTypeOf = (kind: SourceKind): string | undefined => SOURCE_CREDENTIAL_TYPE[kind];

/**
 * Why a source's credential can't be used right now, or undefined: it is gone, it is not the type the kind needs, or the agent's
 * home project may no longer use it. Asked at every sync (the credential or the agent's project can change after the source was added).
 */
export function credentialProblem(kind: SourceKind, credentialId: string | null, agentId: string): string | undefined {
  const type = credentialTypeOf(kind);
  if (!type) return undefined;
  if (!credentialId) return 'The source has no credential';
  const found = credentials.list().find((c) => c.id === credentialId);
  if (!found) return 'The credential was deleted';
  if (found.type !== type) return `The credential is now a ${found.type}, not a ${type}`;
  if (!credentialUsableBy(credentialId, homeProjectId('agent', agentId))) return `This agent’s project can’t use the credential “${found.name}”`;
  return undefined;
}
