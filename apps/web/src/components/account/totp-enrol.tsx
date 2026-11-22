'use client';
/**
 * Adding an authenticator app: start (the server makes a sealed secret and a QR code), scan or type the setup key, then
 * confirm with a current code. The secret is shown here once; the server never returns it again.
 */
import { useState, type FormEvent } from 'react';
import { Smartphone, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldLabel, Input } from '@/components/ui/inputs';

interface Started {
  factorId: string;
  secret: string;
  otpauthUrl: string;
  qr: string;
}

/** `initial` shows the enrolment already started (tests render it on the server). */
export function TotpEnrol({ onConfirmed, onCancel, initial }: { onConfirmed: (recoveryCodes?: string[]) => void; onCancel?: () => void; initial?: Started }) {
  const [started, setStarted] = useState<Started | undefined>(initial);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setStarted(await api<Started>('/api/me/mfa/totp', { method: 'POST', json: { password } }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!started) return;
    setBusy(true);
    setError(undefined);
    try {
      const done = await api<{ recoveryCodes?: string[] }>(`/api/me/mfa/totp/${started.factorId}/confirm`, { method: 'POST', json: { code: code.trim() } });
      onConfirmed(done.recoveryCodes);
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  };

  if (!started) {
    return (
      <form method="post" onSubmit={start} className="space-y-3">
        <p className="text-[12px] leading-relaxed text-t2">An authenticator app (1Password, Google Authenticator, Authy and others) makes a 6-digit code every 30 seconds. You enter it after your password.</p>
        <label className="block max-w-[260px] max-md:max-w-none">
          <FieldLabel>Your password</FieldLabel>
          <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="mt-1 block text-[11px] text-t3">Asked so nobody on a session left open can add their own app.</span>
        </label>
        {error && <Problem message={error} />}
        <div className="flex gap-2 max-md:flex-col">
          <Button type="submit" variant="primary" size="sm" loading={busy} className="max-md:w-full">
            <Smartphone className="size-3.5" /> Add authenticator app
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="max-md:w-full">
              Cancel
            </Button>
          )}
        </div>
      </form>
    );
  }
  return (
    <form method="post" onSubmit={confirm} className="space-y-3.5">
      <p className="text-[12px] leading-relaxed text-t2">Scan this with your authenticator app, or type the setup key. Then enter the code the app shows.</p>
      <div className="flex flex-wrap items-start gap-4 max-md:flex-col">
        {/* The QR code is an SVG data URL (the CSP allows data: images); it is the same text as the setup key below. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={started.qr} alt="QR code for your authenticator app" width={192} height={192} className="size-48 shrink-0 rounded-[10px] border border-hair bg-white p-1" />
        <div className="min-w-0 space-y-1.5">
          <FieldLabel>Setup key</FieldLabel>
          <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-sf2 py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-t1" data-testid="totp-secret">
              {started.secret}
            </code>
            <CopyButton text={started.secret} label="Copy setup key" />
          </div>
          <p className="text-[11px] text-t3">Time-based, 6 digits, 30 seconds.</p>
        </div>
      </div>
      <label className="block max-w-[260px] max-md:max-w-none">
        <FieldLabel>Code from the app</FieldLabel>
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-[0.2em]" />
      </label>
      {error && <Problem message={error} />}
      <div className="flex gap-2 max-md:flex-col">
        <Button type="submit" variant="primary" size="sm" loading={busy} className="max-md:w-full">
          Turn on
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="max-md:w-full">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <div role="alert" className="flex gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[12px] text-rd">
      <TriangleAlert className="mt-px size-3.5 shrink-0" /> {message}
    </div>
  );
}
