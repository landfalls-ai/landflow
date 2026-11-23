/**
 * The emails of access requests (docs/access-requests.md#emails). They never block anything: without SMTP the Access page is the
 * only notice, a failed send is logged. A message holds names, the entry, the duration and a link to /access; never a credential,
 * a token or anything the requester typed beyond the reason they gave.
 */
import { getUser } from '../auth/users';
import { mailConfigured, sendMail } from '../auth/mail';
import { publicUrl } from '../config';
import { logger } from '../telemetry/logger';

const link = () => `${publicUrl()}/access`;

async function send(userIds: string[], subject: string, lines: string[]): Promise<void> {
  if (!mailConfigured()) return;
  const text = `${lines.join('\n')}\n\n${link()}\n`;
  for (const id of new Set(userIds)) {
    const to = getUser(id)?.email;
    if (!to) continue;
    try {
      await sendMail({ to, subject, text });
    } catch (error) {
      logger.warn('an access email could not be sent', { error: (error as Error).message });
    }
  }
}

export interface Subject {
  requesterId: string;
  requesterName: string;
  entryName: string;
  targetLabel: string;
  duration: string;
}

const what = (s: Subject) => `${s.entryName} (${s.targetLabel}) for ${s.duration}`;

export const mailRequester = {
  granted: (s: Subject, until: string | null) => send([s.requesterId], `Access granted: ${s.entryName}`, [`You have ${what(s)}.`, until ? `It ends ${until}.` : 'It has no end date.']),
  waiting: (s: Subject) => send([s.requesterId], `Access approved: ${s.entryName}`, [`Your request for ${what(s)} was approved. Someone has to grant it by hand; you will be told when it is done.`]),
  denied: (s: Subject, comment?: string) => send([s.requesterId], `Access denied: ${s.entryName}`, [`Your request for ${what(s)} was denied.`, ...(comment ? [`Reason: ${comment}`] : [])]),
  expired: (s: Subject) => send([s.requesterId], `Access request expired: ${s.entryName}`, [`Nobody answered your request for ${what(s)} in time, so nothing was granted. You can ask again.`]),
  failed: (s: Subject, reason: string) => send([s.requesterId], `Access could not be granted: ${s.entryName}`, [`Your request for ${what(s)} could not be completed: ${reason}`, 'Nothing was granted. An admin can retry it.']),
  removed: (s: Subject, reason: string) => send([s.requesterId], `Access ended: ${s.entryName}`, [`Your access to ${s.entryName} (${s.targetLabel}) has ended (${reason}).`]),
};

export const mailApprovers = {
  grantByHand: (ids: string[], s: Subject, instructions: string) => send(ids, `Please grant by hand: ${s.entryName}`, [`${s.requesterName} was approved for ${what(s)}.`, `How: ${instructions}`, 'Mark it done on the Access page when you have.']),
  removeByHand: (ids: string[], s: Subject, instructions: string) => send(ids, `Please remove by hand: ${s.entryName}`, [`${s.requesterName}'s access to ${s.entryName} (${s.targetLabel}) has ended.`, `How: ${instructions}`, 'Mark it done on the Access page when you have.']),
};
