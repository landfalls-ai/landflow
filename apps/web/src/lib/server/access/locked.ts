/** The ids of the request flow and the chat flow the access setup installed (docs/access-requests.md#setting-up). Reads only the settings, so project access can ask. */
import { accessSettings } from './store';

export function lockedAccessFlows(): string[] {
  const settings = accessSettings();
  return [settings.workflowId, settings.chatWorkflowId].filter((id): id is string => Boolean(id));
}

/** What Spotlight says when asked to change an installed access flow (docs/assistant.md). */
export const LOCKED_FLOW_MESSAGE = 'This is the installed access flow, and it decides who gets access. Spotlight only reads it: make a copy to change it.';
