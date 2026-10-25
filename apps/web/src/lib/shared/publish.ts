/**
 * Draft and publish (lib/server/publish.ts): every save is a draft version; production triggers run the published
 * one. Shapes shared by the API and the editor.
 */

/** The version a workflow's production triggers run. */
export interface WorkflowPublication {
  workflowId: string;
  versionId: string;
  /** The version's number (1, 2, 3… per workflow). */
  versionNumber?: number;
  publishedAt: string;
  /** Who published it: a user id (`migration` for workflows that were active before draft/publish), and that user's name. */
  publishedBy?: string;
  publishedByName?: string;
  note?: string;
}

/** One publish or unpublish, newest first in GET /api/workflows/:id/publication. */
export interface PublishLogEntry {
  id: string;
  workflowId: string;
  action: 'publish' | 'unpublish';
  versionId?: string;
  versionNumber?: number;
  at: string;
  /** A user id, and that user's name. */
  by?: string;
  byName?: string;
  note?: string;
}

/** Where an app webhook trigger (a plugin trigger that registers its own webhook) of the published version stands. */
export interface AppWebhookStatus {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** The URL the external service calls. */
  webhookUrl: string;
  registered: boolean;
  registeredAt?: string;
  /** The last create or delete failed: why. The host retries. */
  error?: string;
}

/** GET /api/workflows/:id/publication */
export interface PublicationStatus {
  published?: WorkflowPublication;
  /** The newest saved version: what Publish publishes. */
  draft?: { versionId: string; versionNumber: number };
  /** The saved draft differs from the published version. */
  unpublishedChanges: boolean;
  log: PublishLogEntry[];
  appWebhooks: AppWebhookStatus[];
}

/** POST /api/workflows/:id/publish and /unpublish */
export interface PublishResult extends PublicationStatus {
  /** Triggers that could not be registered or removed (the publish itself went through; the host retries). */
  triggerErrors: Array<{ nodeName: string; message: string }>;
}
