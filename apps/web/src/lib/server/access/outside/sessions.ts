// placeholder until C36-A merges: C36-A owns the requester session (cookie `landflow_requester`).
import type { OutsideRequester } from './identity';

export const requesterFromRequest = async (_req: Request): Promise<OutsideRequester | null> => null;
export const endSessionsFor = (_requesterId: string): void => undefined;
