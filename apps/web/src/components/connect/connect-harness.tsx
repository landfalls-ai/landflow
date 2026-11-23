'use client';
/**
 * /connect: the one place a person connects their own harness (docs/connect-your-harness.md). Three steps on one
 * column: pick the harness, make a key (the brain's scopes, plus workflow ones the role allows; shown once), copy the
 * setup with the key in it and test it (`tools/list` with that key). The key is made with `POST /api/api-keys`.
 */
import { useEffect, useState } from 'react';
import { Check, CircleAlert, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { ApiKeyScope, ApiKeyView } from '@/lib/shared/auth';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldLabel, Select } from '@/components/ui/inputs';
import { HARNESSES, STATUS_SCOPE, TOOLS_LIST_REQUEST, WORKFLOW_SCOPES, harnessKeyBody, hookKeyBody, hookKeySnippet, hookSnippetFor, sendsStatus, snippetFor, toolNames, type HarnessId, type Snippet } from './harness-snippets';
import { YourSessions } from './your-sessions';
import { useAgentData } from '@/components/agents/use-agent-data';
import { mergeHarnessSession, type HarnessSessionView } from '@/lib/shared/harness';
import { useLiveEvents } from '@/lib/client/live';

const EXPIRY = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

function StepTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-t1">
      <span className="grid size-5 place-items-center rounded-full border border-acbd bg-acdim text-[11px] font-bold text-ac">{n}</span>
      {children}
    </h2>
  );
}

function SnippetBox({ snippet }: { snippet: Snippet }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-t2">{snippet.label}</span>
        <CopyButton text={snippet.text} label={`Copy ${snippet.label}`} className="ml-auto max-md:size-11" />
      </div>
      <p className="mb-1.5 text-[12px] text-t3">{snippet.where}</p>
      <pre tabIndex={0} className="overflow-x-auto rounded-[10px] border border-hair bg-wl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-t1">
        {snippet.text}
      </pre>
    </div>
  );
}

/** What the page needs, so a test can render it without a host. */
export function ConnectSteps({ harness, onHarness, scopes, onScopes, days, onDays, onMake, making, token, mcpUrl, test, onTest, testing, sessions, hookToken, onMakeHookKey, makingHook, agents = [], agentId, onAgent }: {
  harness: HarnessId;
  onHarness: (id: HarnessId) => void;
  scopes: ApiKeyScope[];
  onScopes: (scopes: ApiKeyScope[]) => void;
  days: number;
  onDays: (days: number) => void;
  onMake: () => void;
  making: boolean;
  token?: string;
  mcpUrl: string;
  test?: { ok: boolean; message: string };
  onTest: () => void;
  testing: boolean;
  /** The person's own open Claude Code sessions (live status step). */
  sessions?: HarnessSessionView[];
  /** The live-status key (its own, `harness:write` only), shown once. */
  hookToken?: string;
  onMakeHookKey?: () => void;
  makingHook?: boolean;
  /** Agents the person can pick to bind the sessions of this setup to (the server checks they may run it). */
  agents?: Array<{ id: string; name: string }>;
  agentId?: string;
  onAgent?: (id: string | undefined) => void;
}) {
  const toggle = (scope: ApiKeyScope) => onScopes(scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope]);
  const input = { url: mcpUrl, ...(token && { token }) };
  const snippets = snippetFor(harness, input);
  const status = sendsStatus(harness);
  return (
    <div className="space-y-6">
      <section aria-label="Pick your harness">
        <StepTitle n={1}>Pick your harness</StepTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {HARNESSES.map((h) => (
            <button
              key={h.id}
              type="button"
              aria-pressed={harness === h.id}
              onClick={() => onHarness(h.id)}
              className={cn('flex min-h-11 flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors duration-[120ms]', harness === h.id ? 'border-acbd bg-acdim' : 'border-hair bg-sf hover:bg-sf2')}
            >
              <span className="text-[13px] font-semibold text-t1">{h.label}</span>
              <span className="text-[11px] text-t3">{h.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Make a key">
        <StepTitle n={2}>Make a key</StepTitle>
        <Card className="space-y-3 px-5 py-4">
          <div>
            <FieldLabel>What it may do</FieldLabel>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-acbd bg-acdim px-2.5 py-2">
                <input type="checkbox" checked disabled className="mt-0.5" aria-label="Brain" />
                <span className="min-w-0">
                  <span className="block text-[13px] text-t1">Brain</span>
                  <span className="block text-[11px] text-t3">Read your briefing, ask, and record your work</span>
                </span>
              </label>
              {WORKFLOW_SCOPES.map(({ scope, label }) => (
                <label key={scope} className={cn('flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2', scopes.includes(scope) ? 'border-acbd bg-acdim' : 'border-hair hover:bg-sf2')}>
                  <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} className="mt-0.5" aria-label={label} />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-t1">{label}</span>
                    <span className="block font-mono text-[11px] text-t3">{scope}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="max-w-[200px]">
            <FieldLabel>Expires</FieldLabel>
            <Select value={days} onChange={(e) => onDays(Number(e.target.value))} aria-label="Expires">
              {EXPIRY.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={onMake} loading={making} className="max-md:min-h-11">
              {token ? 'Make another key' : 'Make a key'}
            </Button>
            <span className="text-[12px] text-t3">{token ? 'The key is in the setup below. It is shown once; Landflow keeps only its hash.' : 'You can also paste a key you already have in place of the placeholder.'}</span>
          </div>
        </Card>
      </section>

      <section aria-label="Copy the setup">
        <StepTitle n={3}>Copy the setup</StepTitle>
        <Card className="space-y-4 px-5 py-4">
          {snippets.map((s) => (
            <SnippetBox key={s.label} snippet={s} />
          ))}
          <div className="flex flex-wrap items-center gap-3 border-t border-hair pt-3">
            <Button onClick={onTest} loading={testing} disabled={!token} className="max-md:min-h-11">
              <PlugZap className="size-3.5" /> Test connection
            </Button>
            {!token && <span className="text-[12px] text-t3">Make a key first: the test sends it.</span>}
            {test && (
              <span role="status" className={cn('flex min-w-0 max-w-full items-start gap-1.5 text-[13px] [overflow-wrap:anywhere]', test.ok ? 'text-gn' : 'text-rd')}>
                {test.ok ? <Check className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
                {test.message}
              </span>
            )}
          </div>
        </Card>
      </section>

      {status && (
        <section aria-label="Live status">
          <StepTitle n={4}>Live status (optional)</StepTitle>
          <Card className="space-y-4 px-5 py-4">
            <p className="text-[12px] text-t2">
              Claude Code can tell Landflow when it is thinking, working or waiting for you. A small Node filter in each hook sends only the event’s name, the session id, a tool’s name, a duration and an error’s words, never what you typed, what a tool read or returned, a file path or your working directory.
            </p>
            <div className="space-y-2 rounded-[10px] border border-hair p-3">
              <p className="text-[12px] text-t2">
                The hooks use a key of their own that may only send live status ({STATUS_SCOPE.scope}), not the key above. It goes in an environment variable, not in a settings file. Every program Claude Code starts, its Bash tool included, can read that variable, so the key is limited to sending status and expires in 30 days.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={onMakeHookKey} loading={makingHook} className="max-md:min-h-11">
                  {hookToken ? 'Make another hook key' : 'Make a hook key'}
                </Button>
                <span className="text-[12px] text-t3">
                  {hookToken ? 'Shown once; Landflow keeps only its hash. ' : 'You can also paste a key you already have in place of the placeholder. '}
                  A key you made earlier keeps working until you revoke it in <Link href="/settings#api-keys" className="text-ac underline">Settings → API keys</Link>.
                </span>
              </div>
              <SnippetBox snippet={hookKeySnippet(hookToken)} />
            </div>
            {agents.length > 0 && onAgent && (
              <div className="max-w-[320px]">
                <FieldLabel>Running a Landflow agent here? (optional)</FieldLabel>
                <Select value={agentId ?? ''} onChange={(e) => onAgent(e.target.value || undefined)} aria-label="Landflow agent">
                  <option value="">None: these are my own sessions</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-[12px] text-t3">The list shows every agent you can see; Landflow checks that you may run the one you pick. If you may not, the sessions stay your own and nothing shows on the agent. With an agent picked, the sessions this setup reports show on its card and its error details (up to 300 characters) are sent too. Use it in the settings of the project where you run that agent.</p>
              </div>
            )}
            <SnippetBox snippet={hookSnippetFor({ url: mcpUrl, ...(agentId && { agentId }) })} />
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold text-t2">Your sessions</h3>
              <YourSessions sessions={sessions} />
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

export function ConnectHarness() {
  const [harness, setHarness] = useState<HarnessId>('claude-code');
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [days, setDays] = useState(90);
  const [token, setToken] = useState<string>();
  const [making, setMaking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string }>();
  const [origin, setOrigin] = useState('http://localhost:3000');
  useEffect(() => setOrigin(window.location.origin), []);
  const [sessions, setSessions] = useState<HarnessSessionView[]>();
  const [hookToken, setHookToken] = useState<string>();
  const [makingHook, setMakingHook] = useState(false);
  const [agentId, setAgentId] = useState<string>();
  const agents = useAgentData((s) => s.agents);
  useEffect(() => {
    void useAgentData.getState().loadAgents();
  }, []);
  const makeHookKey = async () => {
    setMakingHook(true);
    try {
      const result = await api<{ key: ApiKeyView; token: string }>('/api/api-keys', { method: 'POST', json: hookKeyBody() });
      setHookToken(result.token);
      toast.success(`Made the key “${result.key.label}”`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMakingHook(false);
    }
  };
  // The person's own open sessions: read once when the harness sends status, then kept current by `harness` events.
  useEffect(() => {
    if (!sendsStatus(harness)) return;
    api<{ sessions: HarnessSessionView[] }>('/api/harness/sessions?open=1&kind=own&limit=50', { background: true })
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  }, [harness]);
  useLiveEvents((event) => {
    if (event.channel === 'harness' && !event.session.agentId) setSessions((list) => mergeHarnessSession(list ?? [], event.session));
  });

  const make = async () => {
    setMaking(true);
    try {
      const result = await api<{ key: ApiKeyView; token: string }>('/api/api-keys', { method: 'POST', json: harnessKeyBody(harness, scopes, days) });
      setToken(result.token);
      setTest(undefined);
      toast.success(`Made the key “${result.key.label}”`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMaking(false);
    }
  };

  const runTest = async () => {
    if (!token) return;
    setTesting(true);
    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify(TOOLS_LIST_REQUEST),
      });
      const text = await response.text();
      const names = response.ok ? toolNames(text) : undefined;
      if (names) setTest({ ok: true, message: `Connected: ${names.length} tools (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})` });
      else {
        let reason = `The server answered ${response.status}`;
        try {
          const message = (JSON.parse(text) as { error?: { message?: string } | string }).error;
          reason = typeof message === 'string' ? message : (message?.message ?? reason);
        } catch {
          /* keep the status */
        }
        setTest({ ok: false, message: reason });
      }
    } catch {
      setTest({ ok: false, message: 'Could not reach Landflow' });
    } finally {
      setTesting(false);
    }
  };

  return <ConnectSteps harness={harness} onHarness={setHarness} scopes={scopes} onScopes={setScopes} days={days} onDays={setDays} onMake={() => void make()} making={making} token={token} mcpUrl={`${origin}/api/mcp`} test={test} onTest={() => void runTest()} testing={testing} sessions={sessions} hookToken={hookToken} onMakeHookKey={() => void makeHookKey()} makingHook={makingHook} agents={(agents ?? []).map((a) => ({ id: a.id, name: a.name }))} agentId={agentId} onAgent={setAgentId} />;
}

