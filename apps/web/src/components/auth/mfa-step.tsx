'use client';
/**
 * The second step of signing in: the six-digit code from the authenticator app, or a recovery code instead. It posts the
 * single-use challenge the password step answered with to /api/auth/mfa/verify and, once signed in, loads the next page
 * in full. A challenge that expired or was used up says so and offers a way back to the password step.
 */
import { useState, type FormEvent } from 'react';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/client/api';
import type { MfaMethod } from '@/lib/shared/auth';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input } from '@/components/ui/inputs';

export function MfaStep({ challenge, methods, next, onBack }: { challenge: string; methods: MfaMethod[]; next: string; onBack: () => void }) {
  const [method, setMethod] = useState<MfaMethod>(methods.includes('totp') ? 'totp' : 'recovery');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dead, setDead] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/auth/mfa/verify', { method: 'POST', json: { challenge, method, code: code.trim() } });
      window.location.assign(next);
    } catch (caught) {
      const message = (caught as Error).message ?? 'Something went wrong';
      // 401 with "Sign in again": the challenge is spent (expired, used or burnt), so another code can't help.
      setDead(caught instanceof ApiError && caught.status === 401 && /sign in again/i.test(message));
      setError(message);
      setBusy(false);
    }
  };

  return (
    <form method="post" onSubmit={submit} className="space-y-3.5">
      <p className="text-[13px] leading-relaxed text-t2">
        {method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes. Each one works once.'}
      </p>
      <label className="block">
        <FieldLabel>{method === 'totp' ? 'Code' : 'Recovery code'}</FieldLabel>
        {method === 'totp' ? (
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus disabled={dead} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-[0.2em]" />
        ) : (
          <Input name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={24} required autoFocus disabled={dead} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder="XXXXX-XXXXX" />
        )}
      </label>
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
          Sign in <ArrowRight className="size-3.5" />
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        {methods.length > 1 ? (
          <button
            type="button"
            className="text-t3 hover:text-ac max-md:min-h-11"
            onClick={() => {
              setMethod(method === 'totp' ? 'recovery' : 'totp');
              setCode('');
              setError(undefined);
            }}
          >
            {method === 'totp' ? 'Use a recovery code instead' : 'Use my authenticator app instead'}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="text-t3 hover:text-ac max-md:min-h-11" onClick={onBack}>
          Start over
        </button>
      </div>
    </form>
  );
}
