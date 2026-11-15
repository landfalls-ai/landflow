/**
 * The second brain's workflow templates. `builtin.ts` owns the template helpers and stays their only owner: it passes them
 * in (`brainTemplates(helpers)`), so this file adds templates without exporting or duplicating the builders.
 *
 * - `brain-tomorrow-sync`: the nightly tomorrow sync (docs/work-and-briefings.md#the-nightly-sync).
 */
import type { StickyNote, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import type { TemplateCategory, TemplateDetail } from '../../shared/templates';

type Link = [type: WorkflowConnection['type'], source: string, target: string, sourceIndex?: number, targetIndex?: number];

/** The helpers of builtin.ts, declared by their shape. */
export interface TemplateHelpers {
  template: (def: { id: string; name: string; description: string; categories: TemplateCategory[]; setup: string[]; nodes: WorkflowNode[]; links: Link[]; notes?: StickyNote[] }) => TemplateDetail;
  node: (id: string, name: string, type: string, position: [number, number], parameters?: Record<string, unknown>) => WorkflowNode;
  main: (source: string, target: string, sourceIndex?: number, targetIndex?: number) => Link;
  daily: (hour: number, minute?: number) => Record<string, unknown>;
  SLOT: Record<string, unknown>;
}

export function brainTemplates({ template, node, main, daily }: TemplateHelpers): TemplateDetail[] {
  return [
    template({
      id: 'brain-tomorrow-sync',
      name: 'Tomorrow sync: a morning briefing for everyone',
      description: 'Every night, prepare for each person a short briefing of their own work, what colleagues did that overlaps it, and what finished that they wait on. Each briefing is kept for that person only and shows up in their coding tool and chat at the start of the day.',
      categories: ['ai', 'productivity'],
      setup: [
        'An owner or admin publishes it (a schedule handles briefings only from the published version, saved and published by an owner or admin): it runs every night at 02:00 in the instance time zone (Settings), for everyone with work in the second brain in the last three days. After a member changes it, the nightly run fails ("A member, or nobody, saved the version …") until an owner or admin saves a change of their own and publishes again.',
        'The briefing is written by the second brain’s model (LANDFLOW_BRAIN_MODEL); with the model off, it is a plain summary of the same lists.',
        'Nothing is sent unless a person chooses Slack or email in their preferences. Delivery uses the server’s settings only, no credential: for Slack, an admin sets LANDFLOW_BRIEFING_SLACK_TOKEN (a Slack bot token) on the server; for email, the host needs SMTP (LANDFLOW_SMTP_*).',
      ],
      nodes: [
        node('nightly', 'Every night', 'schedule', [0, 0], daily(2)),
        node('people', 'List People', 'brainListPeople', [260, 0], { withinDays: 3, day: '' }),
        node('gather', 'Gather Work', 'brainGatherWork', [520, 0]),
        node('write', 'Write Briefing', 'brainWriteBriefing', [780, 0], { useModel: true }),
        node('save', 'Save Briefing', 'brainSaveBriefing', [1040, 0]),
        node('deliver', 'Deliver Briefing', 'brainDeliverBriefing', [1300, 0]),
      ],
      links: [main('nightly', 'people'), main('people', 'gather'), main('gather', 'write'), main('write', 'save'), main('save', 'deliver')],
      notes: [
        {
          id: 'note_1',
          content: '## Privacy\nEach person’s briefing is kept in a row only they can read. This workflow’s run data shows ids and counts, never what anyone did. **Nothing is sent** unless a person chose Slack or email for their briefing.',
          position: [0, 160],
          width: 640,
          height: 150,
        },
      ],
    }),
  ];
}
