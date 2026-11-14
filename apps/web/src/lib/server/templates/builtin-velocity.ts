/**
 * The nightly SDLC velocity template (docs/second-brain.md#nightly-sdlc-velocity): the second brain's work events
 * become suggestions for flows that would raise velocity, each with a build prompt that "Build it" hands to Spotlight.
 * The helpers belong to builtin.ts, which passes them in (`velocityTemplates(helpers)`), so there is no import cycle.
 */
import type { WorkflowNode } from '@landflow/engine';
import type { TemplateDetail } from '../../shared/templates';

type Helpers = {
  template: (def: never) => TemplateDetail;
  node: (id: string, name: string, type: string, position: [number, number], parameters?: Record<string, unknown>, extra?: Partial<WorkflowNode>) => WorkflowNode;
  main: (source: string, target: string, sourceIndex?: number, targetIndex?: number) => unknown;
  daily: (hour: number, minute?: number) => Record<string, unknown>;
  SLOT: unknown;
};

export function velocityTemplates(h: Helpers): TemplateDetail[] {
  const { node, main, daily } = h;
  const template = h.template as (def: unknown) => TemplateDetail;
  return [
    template({
      id: 'brain-sdlc-velocity',
      name: 'Nightly SDLC velocity',
      description:
        'Every night at 3, read the last two weeks of the company’s pull request, review, CI and session events from the second brain, work out where software is slow (review wait, cycle time, rework, flaky CI, repeated toil), and suggest one flow for each. “Build it” on a suggestion opens a new workflow and has Spotlight build it. About the process, never about a person.',
      categories: ['it-ops', 'ai'],
      setup: [
        'Feed the second brain pull request, review and CI events first: the **Work from GitHub into the second brain** template does it, and people’s tools add work sessions. Only events shared with the organization are read, never private ones.',
        'Open Home’s Suggestions the next morning. Each velocity suggestion has the numbers and **Build it**.',
        'The ideas are written by the brain’s model (`LANDFLOW_BRAIN_MODEL`); with it off, one rule per signal type writes them.',
      ],
      nodes: [
        node('nightly', 'Every night at 3', 'schedule', [0, 0], daily(3)),
        node('signals', 'Velocity Signals', 'velocitySignals', [260, 0], { windowDays: 14 }),
        node('ideas', 'Propose Flows', 'proposeFlows', [520, 0], { useModel: true, limit: 5 }),
        node('suggest', 'Suggest Improvement', 'suggestImprovement', [780, 0], {
          title: '{{ $json.title }}',
          why: '{{ $json.why }}',
          effect: '{{ $json.effect }}',
          buildPrompt: '{{ $json.buildPrompt }}',
          label: 'SDLC velocity',
          fingerprint: '{{ $json.fingerprint }}',
          risk: 'low',
          confidence: '{{ $json.confidence }}',
        }),
      ],
      links: [main('nightly', 'signals'), main('signals', 'ideas'), main('ideas', 'suggest')],
    }),
  ];
}
