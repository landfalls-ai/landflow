/** C22: the connector of a source row, by kind (the credential's values are read here, only when a sync starts). */
import { SOURCE_CREDENTIAL_TYPE, type FolderSettings, type S3Settings } from '../../../shared/knowledge-sources';
import { credentials } from '../../credentials/vault';
import type { SourceRow } from '../store';
import { folderConnector } from './folder';
import { s3Connector } from './s3';
import type { Connector } from './types';

/** The decrypted values of the credential a source names; throws in words when it is gone. */
async function credentialData(row: SourceRow, type: string): Promise<Record<string, unknown>> {
  if (!row.credential_id) throw new Error('The source has no credential');
  return credentials.dataWithSecrets({ id: row.credential_id, name: 'the source’s credential' }, type);
}

export async function buildConnector(row: SourceRow): Promise<Connector> {
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  if (row.kind === 'folder') return folderConnector(settings as unknown as FolderSettings);
  if (row.kind === 's3') return s3Connector(settings as unknown as S3Settings, await credentialData(row, SOURCE_CREDENTIAL_TYPE.s3!));
  throw new Error(`The ${row.kind} connector is not available`);
}
