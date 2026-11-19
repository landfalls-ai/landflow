/**
 * A fixture brain for the Notion push and copy tests (NB04): a project with 3 initiatives, 4 customers, 5 people and 2
 * systems, 20 facts (4 of them span projects and belong to none), a summary with links, 2 practices (one approved, one
 * draft), 3 project notes plus run, team and other-project notes, and work in three visibilities. Load the server modules
 * only after the test set its environment: everything here imports them lazily.
 */
export const PRIVATE_TITLE = 'SECRET private roadmap review';
export const TEAM_TITLE = 'SECRET team-only retro';
export const ORG_TITLE = 'Renewal call with Kestrel';
export const WORK_ACTOR = 'actor.person@acme.test';

export async function seedBrain(options: { name?: string } = {}) {
  const { createUser } = await import('@/lib/server/auth/users');
  const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
  const { withAuth } = await import('@/lib/server/auth/context');
  const { createTeamProject, setHomeProject } = await import('@/lib/server/projects/store');
  const entities = await import('@/lib/server/brain/entities');
  const facts = await import('@/lib/server/brain/facts');
  const wiki = await import('@/lib/server/brain/wiki');
  const { scopeForActor } = await import('@/lib/server/brain/scope');
  const practices = await import('@/lib/server/practices/store');
  const approve = await import('@/lib/server/practices/approve');
  const { noteStore } = await import('@/lib/server/notebook/store');
  const { agentStore } = await import('@/lib/server/agents/store');
  const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
  const { store } = await import('@/lib/server/store');
  const { saveKind } = await import('@/lib/server/usage/kinds');
  const { recordUsage } = await import('@/lib/server/usage/ledger');

  const suffix = Math.random().toString(36).slice(2, 6);
  const owner = await createUser({ email: `owner-${suffix}@nb04.test`, name: 'Owner', role: 'owner', password: 'owner-password-1' });
  const member = await createUser({ email: `member-${suffix}@nb04.test`, name: 'Member', role: 'member', password: 'member-password-1' });
  const project = createTeamProject({ name: options.name ?? `Northwind ${suffix}`, createdBy: owner.id });
  const other = createTeamProject({ name: `Elsewhere ${suffix}`, createdBy: owner.id });
  const projectId = project.id;

  const flow = store.saveWorkflow({ id: `wf_${suffix}`, name: 'Ingest work', active: false, nodes: [], connections: [], createdBy: owner.id } as never, { actor: owner.id });
  setHomeProject('workflow', flow.id, projectId);

  const make = (type: string, id: string, name: string, extra: Record<string, unknown> = {}) => entities.upsertEntity({ type, id, name, projectId, ...extra }).entity;
  const initiatives = ['q4-renewals', 'sso-rollout', 'pricing'].map((id) => make('initiative', id, id.replace(/-/g, ' '), { description: id === 'pricing' ? 'Price <book> for 2027 > now' : `About ${id}`, owner: 'Platform team' }));
  const customers = ['kestrel-bank', 'harbor-air', 'lumen-health', 'orbit-foods'].map((id) => make('customer', id, id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), { description: `Customer ${id}`, attrs: { tier: 'gold', region: 'EMEA' } }));
  const people = ['ana', 'ben', 'chen', 'dana', 'eli'].map((id) => make('person', id, id[0].toUpperCase() + id.slice(1), { attrs: { department: 'Sales', email: `${id}@acme.test` } }));
  const systems = ['billing-api', 'ledger-api'].map((id) => make('system', id, id.replace('-', ' ')));
  const all = [...initiatives, ...customers, ...people, ...systems];
  entities.upsertEntity({ type: 'customer', id: 'foreign', name: 'Foreign Co', projectId: other.id });

  // 16 facts of the project (4 kinds on each customer) and 4 that span projects.
  for (const customer of customers) for (const kind of ['purpose', 'health', 'cost', 'dependency'] as const) facts.upsertFact({ subjectType: 'entity', subjectId: `customer/${customer.id}`, subjectName: customer.name, kind, statement: `${customer.name} ${kind} fact with <angle> text`, evidence: [], confidence: 0.8, projectId });
  for (const kind of ['purpose', 'health', 'cost', 'failure'] as const) facts.upsertFact({ subjectType: 'workflow', subjectId: `wf_span_${kind}`, kind, statement: `Spans projects (${kind})`, evidence: [], confidence: 0.5 });

  // Two practices: one approved, one draft.
  const person = { source: 'person' as const, actor: { id: TEST_OWNER.id, role: 'owner' as const } };
  const draft = (handle: string, title: string) => ({ handle, title, level: 'project' as const, projectId, strength: 'required' as const, topics: ['helm'], repos: [], paths: ['deploy/**'], summary: `${title} summary`, body: `Rules for ${title}.\n\n- one chart per service` });
  const approvedDraft = withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () => practices.draftPractice(draft('team/charts', 'Charts live under deploy/helm'), person));
  approve.approvePractice({ id: TEST_OWNER.id, role: 'owner' }, approvedDraft.practice.id, { version: 1, reviewedSources: true, conflicts: {} });
  const waiting = withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () => practices.draftPractice({ ...draft('team/reviews', 'Reviews need two people'), topics: ['review'], paths: ['src/**'] }, person));

  // Notes: three of the project's, and ones that must stay out.
  const lead = agentStore.create({ name: 'Lead' });
  const team = agentTeamStore.create({ name: `Team ${suffix}`, members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
  setHomeProject('agentTeam', team.id, projectId);
  const note = (text: string, scope: 'project' | 'run' | 'team', pid: string | undefined = projectId) => noteStore.insert({ teamId: team.id, ...(pid && { projectId: pid }), kind: 'fact', text, author: 'm_lead', scope });
  const projectNotes = [note('Kestrel pays by wire only', 'project'), note('Billing closes on the 5th', 'project'), note('Ledger is read-only on Fridays', 'project')];
  const runNotes = [note('run note one', 'run'), note('run note two', 'run')];
  note('team only note', 'team');
  note('another project note', 'project', other.id);

  // Work in three visibilities, all naming Kestrel Bank.
  saveKind({ kind: 'work.call_held', fields: ['source', 'sourceId', 'url', 'actor', 'title', 'summary', 'team', 'initiative', 'customer', 'occurredAt'].map((name) => ({ name, type: 'string' as const, required: false })) });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const work = (title: string, visibility: 'private' | 'team' | 'org' | undefined, ownerId?: string) =>
    recordUsage({ kind: 'work.call_held' as never, workflowId: flow.id, at, ...(ownerId && { ownerId, visibility }), attrs: { source: 'fathom', sourceId: `s-${Math.random()}`, title, summary: `${title} summary`, actor: WORK_ACTOR, team: 'Sales', customer: 'Kestrel Bank', occurredAt: at } } as never);
  work(ORG_TITLE, 'org', member.id);
  work(PRIVATE_TITLE, 'private', member.id);
  work(TEAM_TITLE, 'team', member.id);
  work('Ownerless platform note', undefined);

  // A summary with a link and a bare link.
  const kestrel = customers[0];
  await wiki.writeSummary(kestrel, scopeForActor({ id: owner.id, role: 'owner' } as never), { id: owner.id }, {
    model: { provider: 'fake', model: 'wiki', async generate() { return { text: JSON.stringify({ summary: 'Kestrel renews under [[initiative/q4-renewals|Q4 renewals]] and talks to [[person/ana]].' }), toolCalls: [], stopReason: 'end' }; } },
  });

  return { owner, member, project, other, projectId, all, initiatives, customers, people, systems, practices: { approved: approvedDraft.practice.id, waiting: waiting.practice.id }, projectNotes, runNotes, team, counts: { pages: 14, facts: 16, practices: 2, notes: 3 } };
}
