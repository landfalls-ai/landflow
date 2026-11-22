'use client';
/**
 * Sign-in & security (/account/security): your second factors with when each was last used, adding an authenticator
 * app, the recovery codes (how many are left, a new set), and removing a factor. Removing one and making new codes need a
 * second-factor check from the last five minutes: the page asks for a code first, then goes on. `EnrolFlow` is the
 * same enrolment for the chromeless /login/second-factor page, where a covered account must add a factor to go on.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck, Smartphone, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { MfaStateView } from '@/lib/shared/auth';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { FieldLabel, Input, SectionLabel } from '@/components/ui/inputs';
import { RecoveryCodes } from './recovery-codes';
import { TotpEnrol } from './totp-enrol';

function useMfaState(initial?: MfaStateView) {
  const [state, setState] = useState<MfaStateView | undefined>(initial);
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      api<MfaStateView>('/api/me/mfa')
        .then(setState)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { state, error, load };
}

/** A code field that checks the session's second factor (POST /api/me/mfa/step-up), then runs what was waiting. */
function StepUp({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/me/mfa/step-up', { method: 'POST', json: { method, code: code.trim() } });
      onVerified();
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  };
  return (
    <form method="post" onSubmit={submit} className="space-y-2.5 rounded-[10px] border border-hair bg-sf2 px-3 py-3" aria-label="Check your second factor">
      <div className="text-[13px] font-semibold text-t1">Check your second factor first</div>
      <label className="block max-w-[260px] max-md:max-w-none">
        <FieldLabel>{method === 'totp' ? 'Code from the app' : 'Recovery code'}</FieldLabel>
        <Input name="code" inputMode={method === 'totp' ? 'numeric' : 'text'} autoComplete={method === 'totp' ? 'one-time-code' : 'off'} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
      </label>
      {error && <p role="alert" className="text-[12px] text-rd">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Check
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <button type="button" className="text-[12px] text-t3 hover:text-ac max-md:min-h-11" onClick={() => (setMethod(method === 'totp' ? 'recovery' : 'totp'), setCode(''))}>
          {method === 'totp' ? 'Use a recovery code' : 'Use my app'}
        </button>
      </div>
    </form>
  );
}

/** `initial` is what the first render shows before the state loads (tests render it on the server). */
export function SignInSecurity({ initial }: { initial?: MfaStateView } = {}) {
  const { state, error, load } = useMfaState(initial);
  const [adding, setAdding] = useState(false);
  const [codes, setCodes] = useState<string[]>();
  const [waiting, setWaiting] = useState<() => Promise<void>>();

  /** Run `action`; when the session needs a second-factor check first, ask for it and run `action` after. */
  const withCheck = async (action: () => Promise<void>) => {
    if (state && !state.recentlyVerified) return setWaiting(() => action);
    try {
      await action();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.body as { code?: string } | undefined)?.code === 'mfa_step_up_required') setWaiting(() => action);
      else toast.error((caught as Error).message);
    }
  };

  if (error) return <div role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!state) return <div className="h-48 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  const removeFactor = (id: string) => async () => {
    if (!(await confirmAction('Remove this second factor? Your recovery codes stop working too when it is your last one.', { action: 'Remove', danger: true }))) return;
    await api(`/api/me/mfa/${id}`, { method: 'DELETE' });
    toast.success('Second factor removed');
    await load();
  };
  const newCodes = async () => {
    const made = await api<{ recoveryCodes: string[] }>('/api/me/mfa/recovery-codes', { method: 'POST', json: {} });
    setCodes(made.recoveryCodes);
    await load();
  };
  const confirmed = state.factors.filter((factor) => factor.confirmed);

  return (
    <div className="space-y-4">
      {state.covered && (
        <p className="flex items-start gap-2 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5 text-[12px] text-t2">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-gn" /> Your role needs a second factor on this instance. You can add another one, but not remove your last.
        </p>
      )}
      <Card className="space-y-3 px-5 py-4">
        <div className="flex items-center gap-2">
          <Smartphone className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Second factor</SectionLabel>
        </div>
        {confirmed.length === 0 && !adding && <p className="text-[13px] text-t2">You sign in with your password alone. Add an authenticator app to ask for a code as well.</p>}
        {confirmed.map((factor) => (
          <div key={factor.id} className="flex items-center gap-3 rounded-[10px] border border-hair px-3 py-2.5">
            <Smartphone className="size-4 shrink-0 text-t3" strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-t1">{factor.name}</div>
              <div className="truncate text-[12px] text-t3">{factor.lastUsedAt ? `Last used ${timeAgo(factor.lastUsedAt)}` : 'Not used yet'}</div>
            </div>
            {factor.flagged && <Badge tone="warning">flagged</Badge>}
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${factor.name}`} title="Remove" onClick={() => void withCheck(removeFactor(factor.id))}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {adding ? (
          <TotpEnrol
            onCancel={() => setAdding(false)}
            onConfirmed={(made) => {
              setAdding(false);
              if (made) setCodes(made);
              void load();
            }}
          />
        ) : (
          state.canEnrol &&
          !confirmed.some((factor) => factor.kind === 'totp') && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Smartphone className="size-3.5" /> Add authenticator app
            </Button>
          )
        )}
        {!state.canEnrol && (
          <p className="flex items-start gap-2 text-[12px] text-t3">
            <TriangleAlert className="mt-px size-3.5 shrink-0" /> This account signs in with single sign-on: your identity provider’s second factor applies.
          </p>
        )}
      </Card>

      {waiting && (
        <StepUp
          onCancel={() => setWaiting(undefined)}
          onVerified={() => {
            const run = waiting;
            setWaiting(undefined);
            void load().then(() => run().catch((e: Error) => toast.error(e.message)));
          }}
        />
      )}

      {codes ? (
        <Card className="px-5 py-4">
          <RecoveryCodes codes={codes} onDone={() => setCodes(undefined)} />
        </Card>
      ) : (
        confirmed.length > 0 && (
          <Card className="space-y-2.5 px-5 py-4">
            <SectionLabel>Recovery codes</SectionLabel>
            <p className="text-[13px] text-t1" data-testid="codes-left">
              {state.recoveryCodesLeft} recovery {state.recoveryCodesLeft === 1 ? 'code' : 'codes'} left
            </p>
            <p className="text-[12px] text-t3">Each works once, if you lose your phone. A new set replaces the old one.</p>
            <Button size="sm" variant="outline" onClick={() => void withCheck(newCodes)}>
              <RefreshCw className="size-3.5" /> Make new codes
            </Button>
          </Card>
        )
      )}
    </div>
  );
}

/** For /login/second-factor: add the first factor, save the recovery codes, then go on to `next`. */
export function EnrolFlow({ next }: { next: string }) {
  const [codes, setCodes] = useState<string[]>();
  const go = () => window.location.assign(next);
  if (codes) return <RecoveryCodes codes={codes} onDone={go} doneLabel="I’ve saved them: continue" />;
  return <TotpEnrol onConfirmed={(made) => (made ? setCodes(made) : go())} />;
}
