/**
 * Networks and network runners (C29, docs/network-runners.md): the shapes the routes answer with and the settings
 * screen shows, and the numbers both sides agree on. A network is a place the host can't reach by itself (an office
 * network, a VPC); a runner is a process inside it that dials the host and runs the HTTP Request node's calls there.
 */

/** The prefix of a runner's token (`lf_run_…`): a bearer secret, shown once, kept as its SHA-256. */
export const RUNNER_TOKEN_PREFIX = 'lf_run_';

/** The HTTP Request node's Run In value for "run in the host": the default is empty, and "host" means the same. */
export const RUN_IN_HOST = 'host';

/** A runner is online when it was seen within this long (a long poll is 25 s, so a healthy one is seen far more often). */
export const RUNNER_ONLINE_MS = 30_000;

export type RunnerStatus = 'online' | 'offline' | 'revoked';

export interface RunnerView {
  id: string;
  name: string;
  /** The last four characters of the token, to tell tokens apart; the token itself is never shown again. Instance admins only. */
  hint?: string;
  status: RunnerStatus;
  /** Instance admins only (as are the version, address and dates below). */
  allowedIps?: string[];
  version?: string;
  /** Where its last poll came from. */
  address?: string;
  lastSeenAt?: string;
  createdAt?: string;
  revokedAt?: string;
}

export interface NetworkView {
  id: string;
  name: string;
  description?: string;
  /** Set: only workflows of this project may run in it; unset: any workflow. */
  projectId?: string;
  projectName?: string;
  runners: RunnerView[];
  /** The workflows with an HTTP Request node that runs in this network (only the ones the viewer may see). */
  workflows?: Array<{ id: string; name: string }>;
  createdAt?: string;
}

/** GET /api/settings/networks. */
export interface NetworksResponse {
  networks: NetworkView[];
}

/** POST /api/settings/networks/:id/runners: the only time the token is returned. */
export interface RegisteredRunner {
  runner: RunnerView;
  token: string;
}

/** The line the register dialog shows: how to start the runner image with the token (the allow-list is the runner's own). */
export function runnerDockerCommand(hostUrl: string, token: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'runner';
  return `docker run -d --name landflow-runner-${slug} -e LANDFLOW_URL=${hostUrl} -e LANDFLOW_RUNNER_TOKEN=${token} -e LANDFLOW_RUNNER_ALLOW="<hosts and CIDRs it may reach>" landflow-network-runner`;
}
