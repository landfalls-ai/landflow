/** C22: the connector of a source row, by kind. */
import type { CrawlSettings, DriveSettings, FolderSettings, S3Settings } from '../../../shared/knowledge-sources';
import type { SourceRow } from '../store';
import { folderConnector } from './folder';
import type { Connector } from './types';

export function buildConnector(row: SourceRow): Connector {
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  if (row.kind === 'folder') return folderConnector(settings as unknown as FolderSettings);
  if (row.kind === 's3') return unfinished('s3', settings as unknown as S3Settings);
  if (row.kind === 'crawl') return unfinished('crawl', settings as unknown as CrawlSettings);
  return unfinished('googleDrive', settings as unknown as DriveSettings);
}

function unfinished(kind: string, _settings: unknown): Connector {
  throw new Error(`The ${kind} connector is not available`);
}
