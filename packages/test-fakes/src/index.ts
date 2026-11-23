/** @landflow/test-fakes: the fake contract and the stateful fakes. Slack and GitHub are subpath exports (`./slack`, `./github`) too. */
export { defineFake } from './harness';
export type { Fake, FakeLogEntry, FakeReply, FakeRequest, FakeScript, FakeSpec } from './harness';
export { fakeSlack, SLACK_TOKEN } from './slack';
export type { SlackSeed, SlackState } from './slack';
export { fakeGitHub, GITHUB_TOKEN } from './github';
export type { GitHubSeed, GitHubState } from './github';
export { fakeUpstream } from './upstream';
export type { UpstreamState } from './upstream';
export { fakeSystemOne } from './systemone';
export type { SystemOneSeed, SystemOneState } from './systemone';
