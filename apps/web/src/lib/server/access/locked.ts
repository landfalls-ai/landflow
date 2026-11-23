/** The ids of the request flow and the chat flow the access setup installed (docs/access-requests.md#setting-up). Reads only the settings, so project access can ask. */
import { accessSettings } from './store';

export function lockedAccessFlows(): string[] {
  const settings = accessSettings();
  return [settings.workflowId, settings.chatWorkflowId].filter((id): id is string => Boolean(id));
}
