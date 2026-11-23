'use client';
/**
 * The public request page (docs/access-requests.md#the-request-page). `OutsidePage` decides the step from what the server says (`config`,
 * `session`) and the address (`#t=` from an email link, `?error=` from Google); `OutsideView` draws one step from plain props, so a
 * test renders every state without a server. Signed in, it is the Access page's Ask (form and chat), My requests and Grants
 * through `outsideApi`, and nothing else: no catalog, no approvers, no Landflow data.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AccessClientProvider, useLoaded } from '@/lib/client/access';
import { OUTSIDE_PATH, OUTSIDE_SESSION_ENDED, outsideApi, type OutsideConfig, type OutsideSession } from '@/lib/client/access-outside';
import { ApiError } from '@/lib/client/api';
import { BACKGROUND_HEADER } from '@/lib/shared/auth';
import { Card } from '../../shell/page-header';
import { Segmented } from '../../ui/segmented';
import { AccessChat } from '../access-chat';
import { AskForm } from '../ask-form';
import { GrantsView } from '../grants-grid';
import { RequestsView } from '../my-requests';
import { OutsideFrame } from './outside-frame';
import { SignInCard } from './sign-in-card';
import { VerifyCard } from './verify-card';

export type OutsideStep = 'loading' | 'off' | 'signed-out' | 'verify' | 'signed-in';
export type OutsideTab = 'ask' | 'mine' | 'grants';
const TABS: OutsideTab[] = ['ask', 'mine', 'grants'];

/** The token of an email link: `#t=<token>`. Never sent to a server; the page posts it only when Continue is pressed. */
export function tokenFromHash(hash: string): string | undefined {
  return /^#?t=([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
}

/** What `?error=<code>` (Google's callback) says, in plain words. */
export function errorSentence(code: string | null | undefined): string | undefined {
  switch (code) {
    case 'domain':
      return "That account isn't from an email domain that can ask here. Use your work email or your work Google account.";
    case 'not_verified':
      return "Google couldn't verify that email address. Use your work account, or ask for an email link.";
    case 'landflow_user':
      return 'You have a Landflow account. Sign in to Landflow and ask on the Access page.';
    case 'expired':
      return 'That sign-in expired. Try again.';
    default:
      return undefined;
  }
}

export interface OutsideViewProps {
  step: OutsideStep;
  config?: OutsideConfig;
  session?: OutsideSession;
  notice?: string;
  noticeLink?: string;
  /** The address the link was sent to (shows "Check your email"). */
  sent?: string;
  busy?: boolean;
  error?: string;
  tab?: OutsideTab;
  mode?: 'form' | 'chat';
  highlight?: string;
  /** A Landflow user is signed in in this browser. */
  landflowUser?: boolean;
  /** The masked address a sign-in link is for (`m•••@partner.test`). */
  linkEmail?: string;
  onSend?: (email: string) => void;
  onAnother?: () => void;
  onContinue?: () => void;
  onSignOut?: () => void;
  onTab?: (tab: OutsideTab) => void;
  onMode?: (mode: 'form' | 'chat') => void;
  onAsked?: () => void;
  onFiled?: (requestId?: string) => void;
  /** The chat's "See it under My requests". */
  onOpen?: (requestId: string) => void;
}

/** The Ask tab's body: the form or the chat. Entries and the saved GitHub name load from the page's own routes. */
function AskTab({ session, mode, onMode, onAsked, onFiled, onOpen }: { session: OutsideSession; mode: 'form' | 'chat'; onMode?: (m: 'form' | 'chat') => void; onAsked?: () => void; onFiled?: (id?: string) => void; onOpen?: (id: string) => void }) {
  const entries = useLoaded(outsideApi.entries);
  const account = useLoaded(outsideApi.accounts);
  return (
    <div className="flex flex-col gap-3">
      {session.chat && <Segmented label="How to ask" value={mode} onChange={(m) => onMode?.(m)} options={[{ value: 'form', label: 'Form' }, { value: 'chat', label: 'Chat' }]} className="max-md:[&_[role=tab]]:h-11" />}
      {mode === 'chat' && session.chat ? (
        <AccessChat available onFiled={(id) => onFiled?.(id)} onOpen={(id) => onOpen?.(id)} />
      ) : entries.error && !entries.data ? (
        <Card><p role="alert" className="text-[13px] text-rd">{entries.error}</p></Card>
      ) : !entries.data ? (
        <p className="text-[13px] text-t3">Loading…</p>
      ) : (
        <AskForm entries={entries.data.items} savedGithub={account.data?.github} email={session.requester.email} onAsked={() => onAsked?.()} onAccountSaved={() => void account.reload()} />
      )}
    </div>
  );
}

/** One step of the page, drawn from props. */
export function OutsideView(props: OutsideViewProps) {
  const { step, config, session } = props;
  const tab = props.tab ?? 'ask';
  return (
    <AccessClientProvider client={outsideApi}>
      <OutsideFrame email={step === 'signed-in' ? session?.requester.email : undefined} onSignOut={step === 'signed-in' ? props.onSignOut : undefined}>
        {props.landflowUser && (
          <p className="mb-4 rounded-xl border border-hair bg-sf2 px-3 py-2 text-[13px] text-t2" data-testid="outside-landflow-user">
            You have a Landflow account: <Link href="/access" className="font-semibold text-ac hover:underline">use Access</Link> to ask.
          </p>
        )}
        {step === 'loading' && <p className="text-[13px] text-t3">Loading…</p>}
        {step === 'off' && (
          <Card className="mx-auto max-w-[460px]">
            <h2 className="text-[17px] font-semibold text-t1">Asking here is switched off. Ask the person who sent you the link.</h2>
          </Card>
        )}
        {step === 'verify' && <VerifyCard busy={props.busy} error={props.error} email={props.linkEmail} onContinue={() => props.onContinue?.()} />}
        {step === 'signed-out' && (
          <SignInCard google={Boolean(config?.google)} mail={config?.email !== false} notice={props.notice} noticeLink={props.noticeLink} sent={props.sent} busy={props.busy} error={props.error} onSubmit={(email) => props.onSend?.(email)} onAnother={props.onAnother} />
        )}
        {step === 'signed-in' && session && (
          <div className="flex flex-col gap-4">
            <Segmented
              label="Request access"
              value={tab}
              onChange={(next) => props.onTab?.(next)}
              options={[{ value: 'ask', label: 'Ask' }, { value: 'mine', label: 'My requests' }, { value: 'grants', label: 'Grants' }]}
              className="max-md:[&_[role=tab]]:h-11"
            />
            {tab === 'ask' && <AskTab session={session} mode={props.mode ?? 'form'} onMode={props.onMode} onAsked={props.onAsked} onFiled={props.onFiled} onOpen={props.onOpen} />}
            {tab === 'mine' && <RequestsView highlight={props.highlight} />}
            {tab === 'grants' && <GrantsView admin={false} manages={false} />}
          </div>
        )}
      </OutsideFrame>
    </AccessClientProvider>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** The page: config, then the session (or the link's token), then the tabs. */
export function OutsidePage() {
  const [step, setStep] = useState<OutsideStep>('loading');
  const [config, setConfig] = useState<OutsideConfig>();
  const [session, setSession] = useState<OutsideSession>();
  const [notice, setNotice] = useState<string>();
  const [noticeLink, setNoticeLink] = useState<string>();
  const [sent, setSent] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [token, setToken] = useState<string>();
  const [tab, setTabState] = useState<OutsideTab>('ask');
  const [mode, setMode] = useState<'form' | 'chat'>('form');
  const [highlight, setHighlight] = useState<string>();
  const [landflowUser, setLandflowUser] = useState(false);

  const signedOut = useCallback((text?: string, link?: string) => {
    setSession(undefined);
    setNotice(text);
    setNoticeLink(link);
    setSent(undefined);
    setStep('signed-out');
  }, []);

  const [linkEmail, setLinkEmail] = useState<string>();

  const loadSession = useCallback(async () => {
    try {
      setSession(await outsideApi.session());
      setStep('signed-in');
    } catch (e) {
      // 401: nobody is signed in. Anything else is shown as the sign-in card's notice.
      if (e instanceof ApiError && e.status === 401) signedOut();
      else signedOut(message(e));
    }
  }, [signedOut]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('tab') as OutsideTab | null;
    if (wanted && TABS.includes(wanted)) setTabState(wanted);
    setHighlight(params.get('request') ?? undefined);
    const code = params.get('error');
    const fromHash = tokenFromHash(window.location.hash);
    // A Landflow user in this browser is pointed to Access (the page still works for an outsider: their cookie is another one).
    void fetch('/api/auth/me', { headers: { [BACKGROUND_HEADER]: '1' }, cache: 'no-store' }).then((r) => setLandflowUser(r.ok), () => undefined);
    void (async () => {
      let loaded: OutsideConfig;
      try {
        loaded = await outsideApi.config();
      } catch (e) {
        setConfig({ enabled: true, google: false, email: false });
        signedOut(message(e));
        return;
      }
      setConfig(loaded);
      if (!loaded.enabled) return setStep('off');
      if (fromHash) {
        // Whose link is it? Asked before "Continue" (read only: it does not use the link). A dead link is told now.
        try {
          setLinkEmail((await outsideApi.peek(fromHash)).email);
        } catch (e) {
          window.history.replaceState(null, '', OUTSIDE_PATH);
          return signedOut(message(e));
        }
        setToken(fromHash);
        return setStep('verify');
      }
      if (code) {
        signedOut(errorSentence(code) ?? 'That sign-in did not work. Try again.', code === 'landflow_user' ? '/access' : undefined);
        window.history.replaceState(null, '', OUTSIDE_PATH);
        return;
      }
      await loadSession();
    })();
  }, [loadSession, signedOut]);

  // Any call that answers 401 sends the page back to sign-in.
  useEffect(() => {
    const ended = () => signedOut('Your session ended. Sign in again.');
    window.addEventListener(OUTSIDE_SESSION_ENDED, ended);
    return () => window.removeEventListener(OUTSIDE_SESSION_ENDED, ended);
  }, [signedOut]);

  const setTab = (next: OutsideTab) => {
    setTabState(next);
    setHighlight(undefined);
    window.history.replaceState(null, '', `${OUTSIDE_PATH}?tab=${next}`);
  };

  return (
    <OutsideView
      step={step}
      config={config}
      session={session}
      notice={notice}
      noticeLink={noticeLink}
      sent={sent}
      linkEmail={linkEmail}
      busy={busy}
      error={error}
      tab={tab}
      mode={mode}
      highlight={highlight}
      landflowUser={landflowUser}
      onTab={setTab}
      onMode={setMode}
      onAnother={() => setSent(undefined)}
      onSend={async (email) => {
        setBusy(true);
        setError(undefined);
        try {
          await outsideApi.signInEmail(email);
          setNotice(undefined);
          setSent(email);
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
      onContinue={async () => {
        if (!token) return;
        setBusy(true);
        setError(undefined);
        try {
          await outsideApi.verify(token);
          // The token is spent: the address bar drops it, and a reload shows the signed-in page.
          window.history.replaceState(null, '', OUTSIDE_PATH);
          setToken(undefined);
          await loadSession();
        } catch (e) {
          window.history.replaceState(null, '', OUTSIDE_PATH);
          setToken(undefined);
          if (e instanceof ApiError && e.status === 409) signedOut(e.message, (e.body as { signInUrl?: string } | undefined)?.signInUrl ?? '/access');
          else signedOut(message(e));
        } finally {
          setBusy(false);
        }
      }}
      onSignOut={async () => {
        try {
          await outsideApi.signOut();
        } catch {
          // The session may already be over: either way the page is signed out.
        }
        signedOut();
      }}
      onAsked={() => {
        toast.success('Asked. You will see the answer under My requests.');
        setTab('mine');
      }}
      onFiled={() => toast.success('Filed. You will see the answer under My requests.')}
      onOpen={(id) => {
        setTab('mine');
        setHighlight(id);
      }}
    />
  );
}
