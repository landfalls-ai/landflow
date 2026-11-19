/**
 * Conflicts of the Notion pull (docs/features/notion-brain.md#conflicts): a person changed the part of a page Landflow writes
 * (the region between the markers, or a study fact's statement), or both sides changed a person-owned field since the last sync.
 *
 * - The region: one suggestion per page per day for the project's editors and admins ("<who> changed the summary of <name> in
 *   Notion", the added lines as evidence, "Keep as a fact" through the problem's `keepAsFact` action), a `landflow_part_edited`
 *   problem in Landflow's words and ids only, and an audit row. The caller puts the region back (NB04's push, or `enqueue`).
 * - Both sides: the later edit wins (Notion's minute-rounded `last_edited_time` against the local `updated_at`, compared by the
 *   minute, ties to Notion: Notion is the home). The other value goes to the audit row `notion-brain.overwrite`, and a Notion win
 *   shows on the page view for 7 days (`changedInNotion`, brain/wiki.ts).
 */
import { MAX_AUDIENCE, type AudienceMember } from '../../../shared/brain';
import { projectRoleCan } from '../../../shared/projects';
import { recordAudit } from '../../audit';
import { listUsers } from '../../auth/users';
import { database } from '../../db';
import { isInstanceAdmin, projectRole } from '../../projects/access';
import { logger } from '../../telemetry/logger';
import { getEntity } from '../entities';
import { upsertProposal } from '../proposals';
import { addProblem, type LinkRow } from './links';
import type { ItemRow, RegionConflict } from './sync';

const EVIDENCE_LABEL = 'Changed in Notion';
const CLIP = 500;
const day = () => new Date().toISOString().slice(0, 10);
const looksLikeId = (text: string | undefined) => !text || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text);

/** The lines `after` has that `before` did not, for a person to read (clipped to 500 characters). */
export function addedLines(before: string, after: string): string {
  const had = new Set(before.split('\n').map((line) => line.trim()));
  const added = after
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !had.has(line));
  const text = added.join('\n');
  return text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text || 'Lines were removed.';
}

/** The project's editors and admins: who a Notion suggestion is addressed to. */
export function editorsOf(projectId: string): AudienceMember[] {
  return listUsers()
    .filter((u) => !u.disabledAt && (isInstanceAdmin(u) || projectRoleCan.create(projectRole(u, projectId))))
    .slice(0, MAX_AUDIENCE)
    .map((u) => ({ userId: u.id, email: u.email.toLowerCase(), name: u.name }));
}

/** The fingerprint of a region suggestion: one per page per day. */
export const regionFingerprint = (linkId: string, ref: string, on = day()) => `notion-brain:region:${linkId}:${ref}:${on}`;
/** The fingerprint of a study fact's statement suggestion: one per fact per day. */
export const factFingerprint = (linkId: string, factId: string, on = day()) => `notion-brain:fact:${linkId}:${factId}:${on}`;

interface Filing {
  link: LinkRow;
  fingerprint: string;
  /** The entity the suggestion is about (`type/id`). */
  ref: string;
  title: string;
  why: string;
  added: string;
  notionUrl?: string;
}

function file(filing: Filing): void {
  const [type, id] = filing.ref.split('/');
  const name = (type && id && getEntity(type, id)?.name) || filing.ref;
  try {
    upsertProposal({
      source: 'analyst',
      label: 'Notion brain',
      fingerprint: filing.fingerprint,
      projectId: filing.link.project_id,
      target: { type: 'entity', id: filing.ref, name },
      title: filing.title,
      why: filing.why,
      evidence: [{ label: EVIDENCE_LABEL, value: filing.added }, ...(filing.notionUrl ? [{ label: 'Notion', value: 'the row', href: filing.notionUrl }] : [])],
      ops: [],
      audience: editorsOf(filing.link.project_id),
      risk: 'low',
      confidence: 0.6,
      score: 4,
    });
  } catch (error) {
    logger.warn('[notion-brain] a Notion change could not file its suggestion', { error });
  }
}

/**
 * A person changed the region of a page (the pull saw it differ from what Landflow wrote, or the push's `update_content` found
 * nothing to match). Registered with `setRegionConflict`.
 */
export const regionConflict: RegionConflict = ({ link, item, before, after, editedBy }) => {
  const who = looksLikeId(editedBy) ? 'Someone' : editedBy!;
  if (item.kind === 'entity') {
    const [type, id] = item.local_key.split('/');
    const name = (type && id && getEntity(type, id)?.name) || item.local_key;
    file({
      link,
      fingerprint: regionFingerprint(link.id, item.local_key),
      ref: item.local_key,
      title: `${who} changed the summary of ${name} in Notion`,
      why: `The part of ${name}’s Notion page that Landflow writes was edited, so Landflow put its own text back. If what was written is true, keep it as a fact of the page.`,
      added: addedLines(before, after),
    });
  }
  addProblem({
    linkId: link.id,
    kind: 'landflow_part_edited',
    notionId: item.notion_id,
    localKey: item.local_key,
    detail: `A person edited the part of ${item.local_key} that Landflow writes. Landflow put its own text back.`,
  });
  recordAudit({
    action: 'notion-brain.region',
    actor: 'system',
    target: {
      type: item.kind === 'entity' ? 'entity' : 'practice',
      id: item.local_key,
    },
    summary: `A person changed the part of a Notion page that Landflow writes (${item.local_key})`,
    details: {
      linkId: link.id,
      notionId: item.notion_id,
      by: looksLikeId(editedBy) ? '' : editedBy,
    },
    project: link.project_id,
  });
};

/** A study fact's statement was changed in Notion: Landflow puts its own back and offers "Keep as a fact" (problem + suggestion). */
export function statementConflict(link: LinkRow, item: ItemRow, input: { ref: string; text: string; editedBy?: string; notionUrl?: string }): void {
  const who = looksLikeId(input.editedBy) ? 'Someone' : input.editedBy!;
  const [type, id] = input.ref.split('/');
  const name = (type && id && getEntity(type, id)?.name) || input.ref;
  const clipped = input.text.length > CLIP ? `${input.text.slice(0, CLIP - 1)}…` : input.text;
  file({
    link,
    fingerprint: factFingerprint(link.id, item.local_key),
    ref: input.ref,
    title: `${who} changed a fact about ${name} in Notion`,
    why: `A fact Landflow learned about ${name} was edited in Notion, so Landflow put its own text back. If what was written is true, keep it as a fact of your own.`,
    added: clipped,
    notionUrl: input.notionUrl,
  });
  addProblem({
    linkId: link.id,
    kind: 'landflow_part_edited',
    notionId: item.notion_id,
    localKey: item.local_key,
    detail: `A person changed the statement of fact ${item.local_key}. Landflow put its own text back.`,
  });
}

/** The text a "Keep as a fact" action keeps: the newest suggestion of that fingerprint family, its "Changed in Notion" evidence. */
export function suggestedText(link: LinkRow, localKey: string): { text: string; ref: string; url?: string } | undefined {
  const isFact = localKey.startsWith('entity:');
  const prefix = isFact ? `notion-brain:fact:${link.id}:${localKey}:` : `notion-brain:region:${link.id}:${localKey}:`;
  const rows = database().all<{ data: string }>('SELECT data FROM proposals WHERE fingerprint LIKE ? ORDER BY updated_at DESC', `${prefix}%`);
  for (const row of rows) {
    try {
      const proposal = JSON.parse(row.data) as {
        evidence?: Array<{
          label: string;
          value?: string | number;
          href?: string;
        }>;
        target?: { id?: string };
      };
      const text = proposal.evidence?.find((e) => e.label === EVIDENCE_LABEL)?.value;
      if (typeof text === 'string' && text.trim() && proposal.target?.id)
        return {
          text,
          ref: proposal.target.id,
          url: proposal.evidence?.find((e) => e.href)?.href,
        };
    } catch {
      // A row that does not parse is skipped.
    }
  }
  return undefined;
}

/** Both sides changed a person-owned field: the value that lost goes to the audit log (`notion-brain.overwrite`). */
export function recordOverwrite(
  link: LinkRow,
  input: {
    ref: string;
    name?: string;
    field: string;
    winner: 'notion' | 'landflow';
    by?: string;
    replaced: string;
  },
): void {
  recordAudit({
    action: 'notion-brain.overwrite',
    actor: 'system',
    target: {
      type: 'entity',
      id: input.ref,
      ...(input.name && { name: input.name }),
    },
    summary: `${input.winner === 'notion' ? 'A later edit in Notion replaced' : 'A later edit in Landflow kept'} the ${input.field} of ${input.ref}`,
    details: {
      linkId: link.id,
      field: input.field,
      winner: input.winner,
      by: input.by ?? 'A Notion user',
      replaced: input.replaced.slice(0, 1_000),
    },
    project: link.project_id,
  });
}

/** Whether Notion's edit is the later one. Notion's time is rounded down to the minute, so the two are compared by the minute and a tie goes to Notion. */
export const notionIsLater = (notionEditedAt: string, localUpdatedAt: string): boolean => Date.parse(notionEditedAt) >= Math.floor(Date.parse(localUpdatedAt) / 60_000) * 60_000;
