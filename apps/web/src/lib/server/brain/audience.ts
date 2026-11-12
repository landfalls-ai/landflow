/**
 * Suggestions with an audience (docs/second-brain.md#suggestions-with-an-audience): a suggestion may be addressed to named
 * people (`Proposal.audience`). They see it in their inbox even when it is about something outside their projects, but only
 * what the suggestion itself says; applying its changes still takes edit access to the target.
 *
 * Slack mirror: when a flow asks for it (Suggest Improvement's Mirror to Slack), each audience member with a Slack id
 * (or an email Slack knows) gets a direct message with the title, why, evidence and the buttons. A click calls the same
 * server functions as the inbox (proposals.ts), so one record holds both, and after any decision every mirrored message
 * is updated to say what was decided and by whom. The message refs live on the suggestion (`Proposal.slack`), so a
 * refresh of the same fingerprint doesn't post again (only a member added since gets a message).
 */
import type { JsonObject } from '@landflow/protocol';
import type { AudienceMember, Proposal, ProposalSlackMirror } from '../../shared/brain';
import { MAX_AUDIENCE } from '../../shared/brain';
import { findUserByEmail, getUser, userNames, type UserRecord } from '../auth/users';
import { canResource, isInstanceAdmin, type Actor } from '../projects/access';
import { escape, postResponseUrl, slackCall, slackCredentialFor, type SlackCredential } from '../slack';
import { logger } from '../telemetry/logger';
import { singleton } from '../singleton';
import { actOnProposal, applyProposal, dismissProposal, getProposal, ProposalError, saveProposal, snoozeProposal } from './proposals';

const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
const SLACK_ID = /^[UW][A-Z0-9_]{2,}$/;

/** Slack button ids start with this; `value` is `{ t: 'pr', p: <suggestion id>, a?: <action id> }`. */
export const PROPOSAL_ACTION_PREFIX = 'landflow_pr_';

// ---------------------------------------------------------------------------
// The audience
// ---------------------------------------------------------------------------

/**
 * People from a list of members, or from emails and Slack member ids in a comma-separated string or a list. Emails are
 * resolved to Landflow users where they exist (their id and name are filled in). Throws ProposalError for an entry that
 * is neither, or more than MAX_AUDIENCE people.
 */
export function cleanAudience(value: unknown): AudienceMember[] {
  let list = value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch {
        throw new ProposalError('Send To is not valid JSON');
      }
    } else list = text.split(/[,;\n]/);
  }
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ProposalError('The audience must be a list of people');
  const out: AudienceMember[] = [];
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  for (const raw of list) {
    const entry = typeof raw === 'string' ? raw.trim() : '';
    const given = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof raw === 'string' && !entry) continue;
    let email = text(given.email).toLowerCase() || (EMAIL.test(entry) ? entry.toLowerCase() : '');
    let slackUserId = text(given.slackUserId) || (SLACK_ID.test(entry) ? entry : '');
    let userId = text(given.userId);
    let name = text(given.name);
    if (typeof raw === 'string' && !email && !slackUserId) throw new ProposalError(`“${entry}” is neither an email nor a Slack member id`);
    if (email && !EMAIL.test(email)) throw new ProposalError(`“${email}” is not an email`);
    if (slackUserId && !SLACK_ID.test(slackUserId)) throw new ProposalError(`“${slackUserId}” is not a Slack member id`);
    const user = (userId ? getUser(userId) : undefined) ?? (email ? findUserByEmail(email) : undefined);
    if (user) {
      userId = user.id;
      email ||= user.email.toLowerCase();
      name ||= user.name;
    }
    if (!userId && !email && !slackUserId) continue;
    const key = userId || email || slackUserId;
    if (out.some((m) => (m.userId || m.email || m.slackUserId) === key)) continue;
    out.push({ ...(userId && { userId }), ...(email && { email }), ...(slackUserId && { slackUserId }), ...(name && { name: name.slice(0, 80) }) });
  }
  if (out.length > MAX_AUDIENCE) throw new ProposalError(`A suggestion can be addressed to at most ${MAX_AUDIENCE} people`);
  return out;
}

/** Whether this person is in the suggestion's audience (by user id or email). */
export function inAudience(person: { id: string; email?: string } | undefined, proposal: Pick<Proposal, 'audience'>): boolean {
  if (!person || !proposal.audience?.length) return false;
  const email = person.email?.toLowerCase();
  return proposal.audience.some((m) => m.userId === person.id || (email && m.email === email));
}

/** What a suggestion changes when applied: the target workflow or agent, a new workflow, or a kept note. Advice changes nothing. */
export const changesSomething = (p: Pick<Proposal, 'ops' | 'draft' | 'agentChange' | 'notebook'>) => Boolean(p.ops.length || p.draft || p.agentChange || p.notebook);

/** Whether Slack's Apply makes sense: something to change, or the missing tool's go-ahead. */
const applyable = (p: Proposal) => changesSomething(p) || p.detector === 'missing-tool';

const canRead = (actor: Actor, p: Pick<Proposal, 'target'>, action: 'read' | 'update') => {
  const { type, id } = p.target;
  if (type === 'workflow' && id) return canResource(actor, 'workflow', id, action);
  if (type === 'agent' && id) return canResource(actor, 'agent', id, action);
  if (type === 'team' && id) return canResource(actor, 'agentTeam', id, action);
  return isInstanceAdmin(actor);
};

/** Who may see a suggestion: whoever can open its target, and the people it is addressed to. */
export const canSee = (actor: UserRecord, p: Proposal) => canRead(actor, p, 'read') || inAudience(actor, p);

/**
 * Who may decide it. Dismissing, snoozing and a flow's own buttons: the target's editors and the audience. Apply: a draft
 * is any builder's; changes to the target need edit access; advice (nothing to change) is the audience's too.
 */
export function canDecide(actor: Actor & { email?: string }, p: Proposal, kind: 'apply' | 'other'): boolean {
  if (canRead(actor, p, 'update')) return true;
  if (!inAudience(actor, p)) return false;
  return kind === 'other' || !changesSomething(p);
}

// ---------------------------------------------------------------------------
// The Slack mirror
// ---------------------------------------------------------------------------

const tasks = singleton('proposal-mirror-tasks', () => new Set<Promise<unknown>>());
const posting = singleton('proposal-mirror-posting', () => new Set<string>());

function inBackground(work: () => Promise<unknown>) {
  const task = work().catch((caught) => logger.warn('suggestion Slack mirror failed', { error: (caught as Error).message }));
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
}

/** Wait for the mirror's background posts and updates (tests). */
export async function settleMirrors(): Promise<void> {
  while (tasks.size) await Promise.all([...tasks]);
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The message's body: title, why, evidence and effect. */
function bodyBlocks(p: Proposal): JsonObject[] {
  const target = [p.target.name, p.target.nodeName].filter(Boolean).join(' · ');
  const blocks: JsonObject[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(cut(p.title, 200))}*${target ? `\n_${escape(target)}_` : ''}` } },
    { type: 'section', text: { type: 'mrkdwn', text: escape(cut(p.why, 2_800)) } },
  ];
  if (p.evidence.length) {
    const lines = p.evidence.slice(0, 8).map((e) => `• ${escape(e.label)}${e.value !== undefined ? `: ${escape(String(e.value))}` : ''}`);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: cut(lines.join('\n'), 2_900) }] });
  }
  if (p.effect) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Expected: ${escape(cut(p.effect, 600))}` } });
  return blocks;
}

const button = (id: string, label: string, value: JsonObject, extra: JsonObject = {}): JsonObject => ({
  type: 'button',
  action_id: `${PROPOSAL_ACTION_PREFIX}${id}`,
  text: { type: 'plain_text', text: cut(label, 30) },
  value: JSON.stringify(value),
  ...extra,
});

/** The suggestion's buttons: its own actions, Apply (when there is something to apply), Dismiss and Snooze 7 days. */
export function mirrorButtons(p: Proposal): JsonObject[] {
  const at = { t: 'pr', p: p.id };
  const out: JsonObject[] = (p.actions ?? []).map((a) =>
    button(`act:${a.id}`, a.label, { ...at, a: a.id }, {
      ...(a.style === 'primary' && { style: 'primary' }),
      ...(a.confirm && { confirm: { title: { type: 'plain_text', text: 'Are you sure?' }, text: { type: 'plain_text', text: cut(a.confirm, 290) }, confirm: { type: 'plain_text', text: a.label }, deny: { type: 'plain_text', text: 'Cancel' } } }),
    }),
  );
  if (applyable(p)) out.push(button('apply', p.draft ? 'Create workflow' : 'Apply', at, p.actions?.length ? {} : { style: 'primary' }));
  out.push(button('dismiss', 'Dismiss', at), button('snooze', 'Snooze 7 days', at));
  return out;
}

/** "Alex" for a Landflow user id, <@U…> for a Slack member. */
function whoIs(by: string | undefined): string {
  if (!by) return 'someone';
  if (by.startsWith('slack:')) return `<@${by.slice(6)}>`;
  return escape(userNames().get(by) ?? by);
}

/** The message as first posted (open), or after a decision (buttons gone, except for a snooze, which can still be decided). */
export function mirrorBlocks(p: Proposal): JsonObject[] {
  const blocks = bodyBlocks(p);
  const d = p.decision;
  const decided = p.status === 'applied' || p.status === 'dismissed' || p.status === 'snoozed' || p.status === 'expired';
  if (decided && d) {
    const icon = p.status === 'dismissed' ? '🚫' : p.status === 'snoozed' ? '😴' : '✅';
    const detail = [d.reason && `reason: ${d.reason}`, d.note].filter(Boolean).join(', ');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${icon} ${escape(d.label)} by ${whoIs(d.by)}${detail ? ` (${escape(detail)})` : ''}` }] });
  }
  if (!decided || p.status === 'snoozed') blocks.push({ type: 'actions', block_id: 'landflow_suggestion', elements: mirrorButtons(p) });
  return blocks;
}

/** Slack GET methods (the Web API reads take query parameters, not JSON). */
async function slackGet<T>(credential: SlackCredential, method: string, query: Record<string, string>): Promise<T | undefined> {
  try {
    const response = await fetch(`${credential.baseUrl}/${method}?${new URLSearchParams(query)}`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => undefined)) as (T & { ok?: boolean }) | undefined;
    return data?.ok === true ? data : undefined;
  } catch {
    return undefined;
  }
}

/** The Slack member id behind an email, if Slack knows it. */
async function slackIdOf(credential: SlackCredential, email: string): Promise<string | undefined> {
  const found = await slackGet<{ user?: { id?: string } }>(credential, 'users.lookupByEmail', { email });
  return found?.user?.id;
}

/** The email Slack has for a member. */
async function slackEmailOf(credential: SlackCredential, member: string): Promise<string | undefined> {
  const found = await slackGet<{ user?: { profile?: { email?: string } } }>(credential, 'users.info', { user: member });
  return found?.user?.profile?.email?.toLowerCase();
}

/** Post the suggestion to every audience member who has not got it yet. Safe to call again: it only adds. */
async function mirrorPost(id: string): Promise<void> {
  if (posting.has(id)) return;
  posting.add(id);
  try {
    let proposal = getProposal(id);
    if (!proposal?.slack || !proposal.audience?.length || (proposal.status !== 'open' && proposal.status !== 'snoozed')) return;
    const credential = await slackCredentialFor(proposal.slack.credential);
    const posted: ProposalSlackMirror['messages'] = [];
    const resolved = new Map<number, string>();
    for (const [index, member] of proposal.audience.entries()) {
      const slackUserId = member.slackUserId ?? (member.email ? await slackIdOf(credential, member.email) : undefined);
      if (!slackUserId) {
        logger.info('suggestion Slack mirror: no Slack member for an audience entry', { 'landflow.proposal.id': id });
        continue;
      }
      resolved.set(index, slackUserId);
      if (proposal.slack.messages.some((m) => m.slackUserId === slackUserId)) continue;
      // A member id as the channel opens the direct message; the reply names the real channel, which chat.update needs.
      const reply = await slackCall<{ ts?: string; channel?: string }>(credential, 'chat.postMessage', {
        channel: slackUserId,
        text: `${proposal.title}\n${cut(proposal.why, 500)}`,
        blocks: mirrorBlocks(proposal),
        unfurl_links: false,
      }).catch((caught: Error) => {
        logger.warn('suggestion Slack mirror: could not post', { 'landflow.proposal.id': id, error: caught.message });
        return undefined;
      });
      if (reply?.ts) posted.push({ slackUserId, channel: reply.channel ?? slackUserId, ts: reply.ts });
    }
    // Read it again: someone may have decided it, or refreshed it, while the messages were going out.
    const latest = getProposal(id) ?? proposal;
    proposal = latest;
    const audience = (proposal.audience ?? []).map((m, index) => (resolved.has(index) && !m.slackUserId ? { ...m, slackUserId: resolved.get(index) } : m));
    saveProposal({ ...proposal, audience, slack: { ...(proposal.slack ?? { credential: latest.slack!.credential }), messages: [...(proposal.slack?.messages ?? []), ...posted] } });
    // Decided before the post finished: the new messages must say so.
    if (posted.length && proposal.status !== 'open') await mirrorUpdate(id);
  } finally {
    posting.delete(id);
  }
}

/** After a suggestion was added or refreshed: post it to the members who haven't got it. */
export function mirrorNew(proposal: Proposal): void {
  if (proposal.slack && proposal.audience?.length) inBackground(() => mirrorPost(proposal.id));
}

async function mirrorUpdate(id: string): Promise<void> {
  const proposal = getProposal(id);
  if (!proposal?.slack?.messages.length) return;
  const credential = await slackCredentialFor(proposal.slack.credential);
  const blocks = mirrorBlocks(proposal);
  const verdict = proposal.decision ? `${proposal.decision.label} by ${proposal.decision.by?.startsWith('slack:') ? proposal.decision.by.slice(6) : (userNames().get(proposal.decision.by ?? '') ?? 'someone')}` : proposal.status;
  for (const message of proposal.slack.messages) {
    await slackCall(credential, 'chat.update', { channel: message.channel, ts: message.ts, text: `${proposal.title}: ${verdict}`, blocks }).catch((caught: Error) =>
      logger.warn('suggestion Slack mirror: could not update a message', { 'landflow.proposal.id': id, error: caught.message }),
    );
  }
}

/** After any decision (inbox, API or Slack): every mirrored message shows it and who made it. */
export function mirrorDecision(proposal: Proposal): void {
  if (proposal.slack?.messages.length) inBackground(() => mirrorUpdate(proposal.id));
}

// ---------------------------------------------------------------------------
// A click in Slack
// ---------------------------------------------------------------------------

const say = (url: string | undefined, text: string) => (url ? postResponseUrl(url, { response_type: 'ephemeral', text }).catch(() => undefined) : Promise.resolve());

/**
 * A suggestion button pressed in Slack (called by the interactions route). The click must be signed by the app that posted
 * it and come from a member of the audience. The server function is the inbox's own, so the record is the same one; the
 * actor is the Landflow user behind the member (by user id or email) or else `slack:<member id>`.
 */
export async function handleProposalClick(click: { actionId: string; value: string | undefined; slackUser: string | undefined; responseUrl?: string; verifiedBy: Set<string> }): Promise<void> {
  let value: { t?: string; p?: string; a?: string } = {};
  try {
    value = JSON.parse(click.value ?? '');
  } catch {
    return;
  }
  const proposal = value.t === 'pr' && value.p ? getProposal(value.p) : undefined;
  if (!proposal?.slack || !click.slackUser) return;
  if (!click.verifiedBy.has(proposal.slack.credential.id)) throw new Error('The click was signed by another Slack app than the one that posted the suggestion');
  const slackUser = click.slackUser;
  let member = proposal.audience?.find((m) => m.slackUserId === slackUser);
  if (!member) {
    // Addressed by email, and Slack was asked to find the member then: the same lookup the other way.
    const email = await slackEmailOf(await slackCredentialFor(proposal.slack.credential), slackUser);
    member = email ? proposal.audience?.find((m) => m.email === email) : undefined;
  }
  if (!member) {
    await say(click.responseUrl, 'This suggestion was not addressed to you.');
    return;
  }
  const user = (member.userId ? getUser(member.userId) : undefined) ?? (member.email ? findUserByEmail(member.email) : undefined);
  const actorId = user?.id ?? `slack:${slackUser}`;
  const kind = click.actionId.slice(PROPOSAL_ACTION_PREFIX.length);
  try {
    if (kind === 'dismiss') dismissProposal(proposal.id, 'not-relevant', { actorId });
    else if (kind === 'snooze') snoozeProposal(proposal.id, 7, undefined, { actorId });
    else if (kind.startsWith('act:')) actOnProposal(proposal.id, value.a ?? kind.slice(4), { actorId });
    else if (kind === 'apply') {
      // Applying changes things: the member needs edit access to the target (advice has nothing to change).
      if (changesSomething(proposal) && !(user && canDecide(user, proposal, 'apply'))) {
        await say(click.responseUrl, 'Applying this changes something you don’t have edit access to in Landflow (or Slack couldn’t match you to a Landflow user by email). Open it in Landflow to apply it.');
        return;
      }
      applyProposal(proposal.id, { actorId });
    } else return;
  } catch (caught) {
    if (caught instanceof ProposalError) {
      await say(click.responseUrl, caught.message);
      // Already decided elsewhere: the message catches up.
      if (caught.status === 409) mirrorDecision(getProposal(proposal.id) ?? proposal);
      return;
    }
    throw caught;
  }
}

/** Forget in-flight bookkeeping (tests). */
export function resetMirror() {
  posting.clear();
}

