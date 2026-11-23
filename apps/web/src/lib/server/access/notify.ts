/**
 * The emails of access requests (docs/access-requests.md#emails). They never block anything: without SMTP the Access page is the
 * only notice, a failed send is logged. A message holds names, the entry, the duration and a link to /access; never a credential,
 * a token or anything the requester typed beyond the reason they gave.
 */
import { mailConfigured, sendMail } from '../auth/mail';
import { logger } from '../telemetry/logger';
import { pageLink, requesterOf } from './principal';

/**
 * Each person gets the mail at their own address with the link to their page: a Landflow user to /access, an outside requester (the
 * verified address, C36 D-16) to /request-access, which asks them to sign in again when their session ended. No token is ever in a mail
 * about a request, and none names an approver to an outside requester.
 */
async function send(personIds: string[], subject: string, lines: string[]): Promise<void> {
  if (!mailConfigured()) return;
  for (const id of new Set(personIds)) {
    const person = requesterOf(id);
    const to = person?.email;
    if (!person || !to) continue;
    const text = `${lines.join('\n')}\n\n${pageLink(person)}\n`;
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

const what = (s: Subject) => `${s.entryName} (${s.targetLabel}) ${s.duration === 'unlimited' ? 'with no end' : `for ${s.duration}`}`;

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
