/** What the host and a runner say to each other (plan D12). Bodies are base64; header lists keep order and repeats. */
export interface CallRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
  timeoutMs: number;
}

export type RunnerAnswer =
  | { status: number; headers: Array<[string, string]>; body?: string }
  | { error: { code: 'refused' | 'timeout' | 'network'; message: string } };

/** What a poll hands out: one call to make. */
export interface Claimed {
  id: string;
  request: CallRequest;
}

/** A call as `performCall` takes it: the request with its id (for the log line). */
export interface CallInput extends CallRequest {
  id: string;
}
