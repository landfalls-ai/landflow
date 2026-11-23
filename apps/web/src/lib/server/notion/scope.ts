/**
 * The scoped writer (docs/features/notion-brain.md#how-landflow-talks-to-notion): wraps a client so that any write outside the
 * page the person named is refused before a request is sent. Reads are not limited here (the puller limits itself to walks
 * under the root). A refusal throws a `NotionError` of kind `outsideRoot` and logs `[notion-brain] refused write <id>`: the id only.
 */
import { logger } from '../telemetry';
import { NotionError } from './errors';
import { sameId, type NotionClient } from './port';

export interface WriteScope {
  /** The page the person named: everything Landflow writes is under it. */
  rootId: string;
  /** Whether a page or row id was made by Landflow under the root. */
  ownIds: (id: string) => boolean;
  /** Data sources of the databases Landflow made. */
  ownDataSources: Set<string>;
}

export function scopedWriter(client: NotionClient, scope: WriteScope): NotionClient {
  const ownSource = (id: string) => [...scope.ownDataSources].some((own) => sameId(own, id));
  const refuse = (id: string): never => {
    logger.warn(`[notion-brain] refused write ${id}`);
    throw new NotionError(`Refused a write outside the brain's page (${id})`, { kind: 'outsideRoot', status: 0, retryable: false });
  };
  const allowPage = (id: string) => {
    if (!sameId(id, scope.rootId) && !scope.ownIds(id)) refuse(id);
  };
  return {
    me: () => client.me(),
    page: (id) => client.page(id),
    pageMarkdown: (id) => client.pageMarkdown(id),
    database: (id) => client.database(id),
    dataSource: (id) => client.dataSource(id),
    queryDataSource: (id, query) => client.queryDataSource(id, query),
    children: (blockId, cursor) => client.children(blockId, cursor),
    paginate: (call) => client.paginate(call),
    async createPage(input) {
      if ('page_id' in input.parent) allowPage(input.parent.page_id);
      else if (!ownSource(input.parent.data_source_id)) refuse(input.parent.data_source_id);
      return client.createPage(input);
    },
    async updatePage(id, input) {
      if (!scope.ownIds(id)) refuse(id);
      return client.updatePage(id, input);
    },
    async updateMarkdown(id, update) {
      if (!scope.ownIds(id)) refuse(id);
      return client.updateMarkdown(id, update);
    },
    async createDatabase(input) {
      allowPage(input.parent.page_id);
      return client.createDatabase(input);
    },
    async updateDataSource(id, input) {
      if (!ownSource(id)) refuse(id);
      return client.updateDataSource(id, input);
    },
  };
}
