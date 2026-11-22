/**
 * C27: trust for marketplace node plugins (docs/marketplace.md#node-plugins). A node plugin runs third-party code on this machine, so
 * a person's yes is recorded against the hash of the files they were shown (`contentHash()` of the downloaded plugin, marketplace
 * + plugin name as the subject, so it outlives an uninstall). An install whose downloaded files hash to an approved value needs no
 * new confirm; any other hash does, and says what the last approval was.
 */
import { getUser } from '../auth/users';
import { currentApproval, isApproved } from './store';

export const pluginSubject = (marketplace: string, plugin: string): string => `${marketplace}/${plugin}`;

export interface PluginTrust {
  /** This hash was approved before: no confirm. */
  approved: boolean;
  /** The last approved hash, when it is another one: the plugin changed since. */
  previous?: { hash: string; at: string; by?: string };
}

export function pluginTrust(subjectId: string, hash: string): PluginTrust {
  if (isApproved('marketplace-plugin', subjectId, hash)) return { approved: true };
  const last = currentApproval('marketplace-plugin', subjectId);
  return {
    approved: false,
    ...(last && { previous: { hash: last.hash, at: last.decidedAt ?? last.firstSeenAt, ...(last.decidedBy && { by: getUser(last.decidedBy)?.name ?? last.decidedBy }) } }),
  };
}
