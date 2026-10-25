'use client';
/**
 * The OAuth2 parts of the credential dialog: provider presets for the generic OAuth2 API type (they only fill in
 * URLs and scopes), and the connection panel for every OAuth2 type: status ("Connected as …", expiry, the last
 * error), the redirect URL to register, and Connect / Reconnect (a popup through the provider's consent page),
 * Get token (client credentials), Refresh and Disconnect. The popup reports back by postMessage and a
 * BroadcastChannel; the panel also reloads when the popup closes, whichever comes first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Link2, Link2Off, PlugZap, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { OAUTH2_MESSAGE_CHANNEL, type OAuth2CallbackMessage, type OAuth2Preset, type OAuth2Status } from '@/lib/shared/oauth2';
import type { CredentialDetail } from '@/lib/shared/types';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { FieldLabel } from '../ui/inputs';

interface OAuth2Info {
  redirectUrl: string;
  presets: OAuth2Preset[];
}

let infoCache: Promise<OAuth2Info> | undefined;
/** The redirect URL and presets (GET /api/oauth2), once per page load. */
function useOAuth2Info(): OAuth2Info | undefined {
  const [info, setInfo] = useState<OAuth2Info>();
  useEffect(() => {
    infoCache ??= api<OAuth2Info>('/api/oauth2').catch((error) => {
      infoCache = undefined;
      throw error;
    });
    infoCache.then(setInfo, () => setInfo({ redirectUrl: `${window.location.origin}/api/oauth2/callback`, presets: [] }));
  }, []);
  return info;
}

/** "in 14 min", "in 3 h": how long until an ISO time. */
function untilText(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 90) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

/** Preset chips for the generic type: picking one fills in the provider's URLs, scopes and client authentication. */
export function OAuth2Presets({ values, onChange }: { values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  const info = useOAuth2Info();
  const [picked, setPicked] = useState<string>();
  if (!info?.presets.length) return null;
  const preset = info.presets.find((p) => p.id === picked);
  return (
    <div>
      <FieldLabel>Fill in for</FieldLabel>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="OAuth2 provider presets">
        {info.presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setPicked(p.id);
              onChange({ ...values, authentication: 'header', authQueryParameters: '', userInfoUrl: '', ...p.values, grantType: values.grantType === 'clientCredentials' ? 'pkce' : (values.grantType ?? 'pkce') });
            }}
            className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors', picked === p.id ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
          >
            {p.name}
          </button>
        ))}
      </div>
      {preset && (
        <p className="mt-1.5 text-[12px] leading-snug text-t3 animate-fade-up">
          {preset.hint}{' '}
          <a href={preset.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-t2 hover:text-ac">
            <BookOpen className="size-3" /> Register an app
          </a>
        </p>
      )}
    </div>
  );
}

function statusLine(status: OAuth2Status | undefined): { tone: 'ok' | 'warn' | 'off'; text: string } {
  if (!status?.connected) return { tone: 'off', text: status?.grantType === 'clientCredentials' ? 'No token yet — one is fetched at first use, or now with Get token' : 'Not connected' };
  if (status.expired && !status.refreshable) return { tone: 'warn', text: `Token expired ${status.expiresAt ? timeAgo(status.expiresAt) : ''} — reconnect`.replace('  ', ' ') };
  const who = status.account ? `Connected as ${status.account}` : 'Connected';
  if (status.expired) return { tone: 'ok', text: `${who} · token expired, renewed at next use` };
  return { tone: 'ok', text: `${who}${status.expiresAt ? ` · token renews ${untilText(status.expiresAt)}` : ''}` };
}

export function OAuth2Connection({
  credential,
  grantType,
  ensureSaved,
  onChange,
}: {
  /** The saved credential (undefined until the first save). */
  credential?: CredentialDetail;
  /** The grant the form shows now (it may differ from the saved one until Connect saves it). */
  grantType: string;
  /** Saves the form (creating the credential if needed) and returns it; undefined when saving failed. */
  ensureSaved: () => Promise<CredentialDetail | undefined>;
  onChange: (credential: CredentialDetail) => void;
}) {
  const info = useOAuth2Info();
  const [busy, setBusy] = useState<'connect' | 'token' | 'disconnect'>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const watching = useRef<{ id: string; timer?: ReturnType<typeof setInterval> }>(undefined);
  const status = credential?.oauth2;
  const clientCredentials = grantType === 'clientCredentials';

  const reload = useCallback(
    async (id: string) => {
      try {
        const { credential: fresh } = await api<{ credential: CredentialDetail }>(`/api/credentials/${id}`);
        onChange(fresh);
        return fresh;
      } catch {
        return undefined;
      }
    },
    [onChange],
  );

  const finish = useCallback(
    (result?: OAuth2CallbackMessage) => {
      const current = watching.current;
      if (!current) return;
      if (current.timer) clearInterval(current.timer);
      watching.current = undefined;
      setBusy(undefined);
      if (result) {
        setMessage({ ok: result.ok, text: result.message });
        if (result.ok) toast.success(result.message);
      }
      void reload(current.id);
    },
    [reload],
  );

  // The popup's answer: postMessage to this window, or the BroadcastChannel when the provider cut the opener link.
  useEffect(() => {
    const accept = (data: unknown) => {
      const result = data as OAuth2CallbackMessage | undefined;
      if (result?.source !== OAUTH2_MESSAGE_CHANNEL || !watching.current || (result.credentialId && result.credentialId !== watching.current.id)) return;
      finish(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin) accept(event.data);
    };
    window.addEventListener('message', onMessage);
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(OAUTH2_MESSAGE_CHANNEL);
      channel.onmessage = (event) => accept(event.data);
    } catch {
      // No BroadcastChannel: postMessage and the closed-popup check still work.
    }
    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
      if (watching.current?.timer) clearInterval(watching.current.timer);
    };
  }, [finish]);

  const connect = async () => {
    setMessage(undefined);
    // Opened before the save, inside the click: an await first would get the popup blocked.
    const popup = window.open('about:blank', 'landflow-oauth2', 'popup,width=520,height=720');
    setBusy('connect');
    const saved = await ensureSaved();
    if (!saved) {
      popup?.close();
      setBusy(undefined);
      return;
    }
    const url = `/api/credentials/${saved.id}/oauth2/authorize`;
    if (!popup) {
      setBusy(undefined);
      setMessage({ ok: false, text: 'The browser blocked the popup: allow popups for this site and try again.' });
      return;
    }
    popup.location.href = url;
    watching.current = { id: saved.id };
    // A closed popup without a message (closed by hand, or the opener link was cut): reload the status anyway.
    watching.current.timer = setInterval(() => {
      if (popup.closed) finish();
    }, 600);
  };

  const getToken = async () => {
    setMessage(undefined);
    setBusy('token');
    try {
      const saved = await ensureSaved();
      if (!saved) return;
      const { credential: fresh } = await api<{ credential: CredentialDetail }>(`/api/credentials/${saved.id}/oauth2/token`, { method: 'POST' });
      onChange(fresh);
      setMessage({ ok: true, text: clientCredentials ? 'Got a token' : 'Token renewed' });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
      if (credential) void reload(credential.id);
    } finally {
      setBusy(undefined);
    }
  };

  const disconnect = async () => {
    if (!credential) return;
    setBusy('disconnect');
    setMessage(undefined);
    try {
      const { credential: fresh } = await api<{ credential: CredentialDetail }>(`/api/credentials/${credential.id}/oauth2/token`, { method: 'DELETE' });
      onChange(fresh);
      toast.success('Disconnected');
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const line = statusLine(status);
  return (
    <div className="space-y-3 rounded-[12px] border border-hair bg-sf2 p-3.5">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className={cn('mt-0.5 size-4 shrink-0', line.tone === 'ok' ? 'text-gn' : line.tone === 'warn' ? 'text-warn' : 'text-t3')} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-t1">{line.text}</div>
          {status?.connectedAt && <div className="text-[12px] text-t3">Token from {timeAgo(status.connectedAt)}{status.scope ? ` · scope ${status.scope}` : ''}</div>}
          {status?.error && (
            <div className="mt-1 flex items-start gap-1.5 text-[12px] text-rd">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{status.error}</span>
            </div>
          )}
        </div>
      </div>

      {!clientCredentials && info && (
        <div>
          <FieldLabel>Redirect URL — register it with the provider</FieldLabel>
          <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" title={info.redirectUrl}>
              {info.redirectUrl}
            </code>
            <CopyButton text={info.redirectUrl} label="Copy the redirect URL" />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {clientCredentials ? (
          <Button size="sm" variant="primary" onClick={() => void getToken()} loading={busy === 'token'}>
            <PlugZap className="size-3.5" /> Get token
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void connect()} loading={busy === 'connect'} title="Sign in with the provider in a popup">
            <Link2 className="size-3.5" /> {status?.connected ? 'Reconnect' : 'Connect'}
          </Button>
        )}
        {!clientCredentials && status?.connected && status.refreshable && (
          <Button size="sm" onClick={() => void getToken()} loading={busy === 'token'} title="Renew the access token with the refresh token now">
            <RefreshCw className="size-3.5" /> Refresh now
          </Button>
        )}
        {status?.connected && (
          <Button size="sm" variant="ghost" onClick={() => void disconnect()} loading={busy === 'disconnect'} title="Forget the stored token">
            <Link2Off className="size-3.5" /> Disconnect
          </Button>
        )}
        {busy === 'connect' && <span className="text-[12px] text-t3">Finish signing in in the popup…</span>}
      </div>
      {message && <div className={cn('text-[12px] animate-fade-up', message.ok ? 'text-gn' : 'text-rd')}>{message.text}</div>}
    </div>
  );
}
