'use client';
/**
 * The second step of signing in: a passkey, the six-digit code from the authenticator app, or a recovery code. It posts
 * the single-use challenge the password step answered with to /api/auth/mfa/verify (for a passkey, after fetching the
 * options for it from /api/auth/mfa/options) and, once signed in, loads the next page in full. A challenge that expired or was used up says so and offers a way back to the password step.
 */
import { useState, type FormEvent } from 'react';
import { ArrowRight, KeyRound, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/client/api';
import { askPasskey, passkeyProblem, usePasskeysSupported, type PublicKeyCredentialRequestOptionsJSON } from '@/lib/client/webauthn';
import type { MfaMethod } from '@/lib/shared/auth';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input } from '@/components/ui/inputs';

const SWITCH: Record<MfaMethod, string> = { webauthn: 'Use a passkey instead', totp: 'Use my authenticator app instead', recovery: 'Use a recovery code instead' };

export function MfaStep({ challenge, methods, next, onBack }: { challenge: string; methods: MfaMethod[]; next: string; onBack: () => void }) {
  const supported = usePasskeysSupported();
  // A browser without passkey support can't use that method; the others stay.
  const available = methods.filter((m) => m !== 'webauthn' || supported);
  const [method, setMethod] = useState<MfaMethod>(methods[0] ?? 'recovery');
  const shown = available.includes(method) ? method : (available[0] ?? 'recovery');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dead, setDead] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (shown === 'webauthn') {
        const { options } = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/mfa/options', { method: 'POST', json: { challenge } });
        const response = await askPasskey(options);
        await api('/api/auth/mfa/verify', { method: 'POST', json: { challenge, method: 'webauthn', response } });
      } else {
        await api('/api/auth/mfa/verify', { method: 'POST', json: { challenge, method: shown, code: code.trim() } });
      }
      window.location.assign(next);
    } catch (caught) {
      const message = passkeyProblem(caught) ?? (caught as Error).message ?? 'Something went wrong';
      // 401 with "Sign in again": the challenge is spent (expired, used or burnt), so another code can't help.
      setDead(caught instanceof ApiError && caught.status === 401 && /sign in again/i.test(message));
      setError(message);
      setBusy(false);
    }
  };

  const others = available.filter((m) => m !== shown);
  return (
    <form method="post" onSubmit={submit} className="space-y-3.5">
      <p className="text-[13px] leading-relaxed text-t2">
        {shown === 'webauthn' ? 'Use the passkey you added to this account: your fingerprint, face, screen lock or security key.' : shown === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes. Each one works once.'}
      </p>
      {shown !== 'webauthn' && (
        <label className="block">
          <FieldLabel>{shown === 'totp' ? 'Code' : 'Recovery code'}</FieldLabel>
          {shown === 'totp' ? (
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus disabled={dead} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-[0.2em]" />
          ) : (
            <Input name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={24} required autoFocus disabled={dead} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder="XXXXX-XXXXX" />
          )}
        </label>
      )}
      {error && (
        <div role="alert" className="flex gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[12px] text-rd animate-fade-up">
          <TriangleAlert className="mt-px size-3.5 shrink-0" /> {error}
        </div>
      )}
      {dead ? (
        <Button type="button" variant="primary" className="w-full" onClick={onBack}>
          Back to sign in
        </Button>
      ) : (
        <Button type="submit" variant="primary" loading={busy} className="w-full">
          {shown === 'webauthn' ? (
            <>
              <KeyRound className="size-3.5" /> Use my passkey
            </>
          ) : (
            <>
              Sign in <ArrowRight className="size-3.5" />
            </>
          )}
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px]">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {others.map((other) => (
            <button
              key={other}
              type="button"
              className="text-left text-t3 hover:text-ac max-md:min-h-11"
              onClick={() => {
                setMethod(other);
                setCode('');
                setError(undefined);
              }}
            >
              {SWITCH[other]}
            </button>
          ))}
        </div>
        <button type="button" className="text-t3 hover:text-ac max-md:min-h-11" onClick={onBack}>
          Start over
        </button>
      </div>
    </form>
  );
}
