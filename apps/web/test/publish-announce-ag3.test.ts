/**
 * Wave ag3 carryover (the live pass, analyst agent): Publish on Spotlight's created-agent row published the agent, yet the
 * canvas band beside it kept "Not published" until a reload, because that path never announced the save (the agent page's
 * Publish and the change card's did). A publish that goes through now announces AGENT_SAVED for the agent; a held one does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ publish: async (): Promise<unknown> => ({}) }));
vi.mock('@/lib/client/api', async (real) => ({
  ...(await real<typeof import('@/lib/client/api')>()),
  api: async (path: string) => (path.endsWith('/publish') ? wire.publish() : path.endsWith('/eval-gate') ? { cases: [] } : {}),
}));

const { publishAgentFor } = await import('@/components/editor/new-agent');
const { useAssistant } = await import('@/components/editor/assistant');
const { AGENT_SAVED } = await import('@/lib/client/agent-change');
const { ApiError } = await import('@/lib/client/api');

afterEach(() => vi.unstubAllGlobals());

const heardOn = () => {
  const tab = new EventTarget();
  vi.stubGlobal('window', tab);
  const heard: string[] = [];
  tab.addEventListener(AGENT_SAVED, (e) => heard.push((e as CustomEvent<{ agentId: string }>).detail.agentId));
  return heard;
};

describe("Spotlight's Publish tells the band", () => {
  it('a publish that goes through announces the save once', async () => {
    useAssistant.getState().setAgent('n1', { agentId: 'ag_1', state: 'tested' } as never);
    const heard = heardOn();
    expect(await publishAgentFor('n1')).toBe(true);
    expect(heard).toEqual(['ag_1']);
  });

  it('a held publish announces nothing', async () => {
    useAssistant.getState().setAgent('n2', { agentId: 'ag_2', state: 'tested' } as never);
    wire.publish = async () => {
      throw new ApiError('held', 409, { error: 'held', gate: { passed: false, score: 2.8, threshold: 3 } });
    };
    const heard = heardOn();
    expect(await publishAgentFor('n2')).toBe(false);
    expect(heard).toEqual([]);
  });
});
