/**
 * A small world for the access-request tests (C35): the core plugin and the fake GitHub and Google plugins, an owner, admins, an entry
 * owner, an approver and requesters, two credentials, the installed access flows, and three catalog entries. The caller sets the
 * LANDFLOW_* environment (a temporary data dir) BEFORE calling `makeWorld()`, which imports the host lazily.
 */
export async function makeWorld(options: { install?: boolean } = {}) {
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  const { createOwner, createUser } = await import('@/lib/server/auth/users');
  const { credentials } = await import('@/lib/server/credentials/vault');
  const { setHomeProject } = await import('@/lib/server/projects/store');
  const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
  const { setMailTransport } = await import('@/lib/server/auth/mail');
  const { fake, fakeGithubPlugin, fakeGooglePlugin } = await import('./fake-access-plugins');
  const { installAccessRequests } = await import('@/lib/server/access/setup');
  const { accessSettings } = await import('@/lib/server/access/store');
  const { createEntry } = await import('@/lib/server/access/catalog');
  const { requestRow } = await import('@/lib/server/access/store');

  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(fakeGithubPlugin);
  registry.registerBuiltin(fakeGooglePlugin);

  const owner = await createOwner({ email: 'owner@landflow.test', name: 'Olive Owner', password: 'password-123' });
  const admin = await createUser({ email: 'admin@landflow.test', name: 'Ada Admin', role: 'admin' });
  const second = await createUser({ email: 'second@landflow.test', name: 'Sam Second', role: 'admin' });
  const lead = await createUser({ email: 'lead@landflow.test', name: 'Lee Lead', role: 'member' });
  const ann = await createUser({ email: 'ann@landflow.test', name: 'Ann Approver', role: 'member' });
  const mia = await createUser({ email: 'mia@landflow.test', name: 'Mia Member', role: 'member' });
  const ola = await createUser({ email: 'ola@landflow.test', name: 'Ola Other', role: 'member' });

  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const captureMail = () => setMailTransport({ async send(message) { mails.push({ to: message.to, subject: message.subject, text: message.text }); } });

  const github = credentials.create({ name: 'GitHub', type: 'github.githubApi', data: { accessToken: 'ghp_world-test-token-123' } });
  const google = credentials.create({ name: 'Google', type: 'google.googleApi', data: { privateKey: 'google-world-test-key-456' } });

  fake.reset();
  fake.seedTeam('acme', 'platform');
  fake.seedGroup('eng@example.com');

  const team = createEntry(admin, { name: 'Platform team', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: github.id, durations: [60, 15, 1, null], approverIds: [ann.id], owners: [lead.id] });
  const group = createEntry(admin, { name: 'Engineering group', system: 'google-group', target: { groupKey: 'eng@example.com' }, credentialId: google.id, durations: [null], approverIds: [ann.id], owners: [lead.id] });
  const manual = createEntry(admin, { name: 'Figma editor', system: 'manual', target: { instructions: 'Add them in Figma, Settings, Members' }, durations: [1_440, 60], approverIds: [ann.id], owners: [lead.id] });

  /** Install the access flows (as the admin's click does) and put the credentials in the project they run in. */
  const install = async () => {
    const setup = await installAccessRequests(owner);
    const projectId = accessSettings().projectId!;
    setHomeProject('credential', github.id, projectId);
    setHomeProject('credential', google.id, projectId);
    return { setup, projectId };
  };
  const installed = options.install === false ? { setup: undefined, projectId: undefined } : await install();

  const as = (user: Parameters<typeof enableTestAuth>[0]) => enableTestAuth(user);
  return { owner, admin, second, lead, ann, mia, ola, github, google, team, group, manual, setup: installed.setup, projectId: installed.projectId, install, fake, mails, captureMail, as, requestRow };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;
