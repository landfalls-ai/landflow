'use client';
/**
 * Adding a passkey: the account's password (asked so nobody on a session left open can add their own key), a name, then
 * the browser's prompt. The server makes the options and checks the answer; the first second factor of any kind brings
 * the recovery codes, passed on to `onAdded`.
 */
import { useState, type FormEvent } from 'react';
import { KeyRound, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/client/api';
import { createPasskey, passkeyProblem, usePasskeysSupported, type PublicKeyCredentialCreationOptionsJSON } from '@/lib/client/webauthn';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input } from '@/components/ui/inputs';

export function PasskeyEnrol({ onAdded, onCancel }: { onAdded: (recoveryCodes?: string[]) => void; onCancel?: () => void }) {
  const supported = usePasskeysSupported();
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const started = await api<{ challenge: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/me/mfa/passkeys/options', { method: 'POST', json: { purpose: 'register', password } });
      const response = await createPasskey(started.options);
      const done = await api<{ recoveryCodes?: string[] }>('/api/me/mfa/passkeys', { method: 'POST', json: { challenge: started.challenge, name: name.trim(), response } });
      onAdded(done.recoveryCodes);
    } catch (caught) {
      setError(passkeyProblem(caught) ?? (caught as Error).message);
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <p role="alert" className="flex items-start gap-2 text-[12px] text-t3">
        <TriangleAlert className="mt-px size-3.5 shrink-0" /> This browser can’t make passkeys. Try another browser or an authenticator app.
      </p>
    );
  }
  return (
    <form method="post" onSubmit={submit} className="space-y-3">
      <p className="text-[12px] leading-relaxed text-t2">A passkey is your fingerprint, face, screen lock or a security key. You use it after your password, instead of typing a code.</p>
      <div className="flex gap-3 max-md:flex-col">
        <label className="block min-w-0 flex-1 max-w-[260px] max-md:max-w-none">
          <FieldLabel>Name this passkey</FieldLabel>
          <Input name="name" autoComplete="off" required maxLength={60} placeholder="Laptop, phone, security key" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block min-w-0 flex-1 max-w-[260px] max-md:max-w-none">
          <FieldLabel>Your password</FieldLabel>
          <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      {error && (
        <div role="alert" className="flex gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[12px] text-rd">
          <TriangleAlert className="mt-px size-3.5 shrink-0" /> {error}
        </div>
      )}
      <div className="flex gap-2 max-md:flex-col">
        <Button type="submit" variant="primary" size="sm" loading={busy} className="max-md:w-full">
          <KeyRound className="size-3.5" /> Add a passkey
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
