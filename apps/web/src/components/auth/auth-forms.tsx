'use client';
/**
 * The sign-in pages' forms: sign in (password, and SSO when configured), owner setup, accept an invite, forgot and
 * reset password. Each posts to /api/auth/* and, once signed in, loads the next page in full so the layout picks up
 * the session.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, KeyRound, MailCheck, TriangleAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/client/api';
import { MIN_PASSWORD_LENGTH, type Role } from '@/lib/shared/auth';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input } from '@/components/ui/inputs';

/** The message to show for a failed request: the first validation issue, else the error. */
function messageOf(caught: unknown): string {
  if (caught instanceof ApiError) {
    const issues = (caught.body as { issues?: Array<{ message?: string }> } | undefined)?.issues;
    return issues?.[0]?.message ?? caught.message;
  }
  return (caught as Error).message ?? 'Something went wrong';
}

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-[380px] animate-fade-up">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] border border-acbd bg-ac2 text-[12px] font-bold tracking-[0.02em] text-on-ac">LF</span>
          <span className="text-[13px] font-semibold text-t1">Landflow</span>
        </div>
        <h1 className="text-[20px] font-semibold text-t1">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[13px] leading-relaxed text-t2">{subtitle}</p>}
        <div className="mt-5 rounded-2xl border border-hair bg-sf px-5 py-5">{children}</div>
        {footer && <div className="mt-4 text-center text-[12px] text-t3">{footer}</div>}
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <FieldLabel>{label}</FieldLabel>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-t3">{hint}</span>}
    </label>
  );
}

function ErrorBox({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[12px] text-rd animate-fade-up">
      <TriangleAlert className="mt-px size-3.5 shrink-0" /> {message}
    </div>
  );
}

function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  };
  return { busy, error, submit, setError };
}

const passwordHint = `At least ${MIN_PASSWORD_LENGTH} characters`;

export function LoginForm({ next, oidcLabel, samlLabel, initialError, smtp }: { next: string; oidcLabel?: string; samlLabel?: string; initialError?: string; smtp: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await api('/api/auth/login', { method: 'POST', json: { email, password } });
    window.location.assign(next);
  });
  return (
    <form onSubmit={submit} className="space-y-3.5">
      {(oidcLabel || samlLabel) && (
        <>
          {oidcLabel && (
            <a
              href={`/api/auth/oidc/login?next=${encodeURIComponent(next)}`}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-full border border-bd text-[13px] font-semibold text-t1 transition-colors duration-[120ms] hover:border-ac hover:text-ac"
            >
              <KeyRound className="size-3.5" /> {oidcLabel}
            </a>
          )}
          {samlLabel && (
            <a
              href={`/api/auth/saml/login?next=${encodeURIComponent(next)}`}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-full border border-bd text-[13px] font-semibold text-t1 transition-colors duration-[120ms] hover:border-ac hover:text-ac"
            >
              <KeyRound className="size-3.5" /> {samlLabel}
            </a>
          )}
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
            <span className="h-px flex-1 bg-hair" /> or <span className="h-px flex-1 bg-hair" />
          </div>
        </>
      )}
      <Field label="Email">
        <Input type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password">
        <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorBox message={error ?? initialError} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Sign in <ArrowRight className="size-3.5" />
      </Button>
      <div className="text-center text-[12px]">
        <Link href="/forgot-password" className="text-t3 hover:text-ac">
          {smtp ? 'Forgot your password?' : 'Can’t sign in?'}
        </Link>
      </div>
    </form>
  );
}

export function SetupForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await api('/api/auth/setup', { method: 'POST', json: { name, email, password } });
    window.location.assign('/');
  });
  return (
    <form onSubmit={submit} className="space-y-3.5">
      <Field label="Name">
        <Input name="name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email">
        <Input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" hint={passwordHint}>
        <Input type="password" name="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Create owner account <ArrowRight className="size-3.5" />
      </Button>
    </form>
  );
}

export function InviteForm({ token }: { token: string }) {
  const [invite, setInvite] = useState<{ email: string; role: Role; invitedBy?: string }>();
  const [loadError, setLoadError] = useState<string>();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    api<{ email: string; role: Role; invitedBy?: string }>(`/api/auth/invites/${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch((e) => setLoadError(messageOf(e)));
  }, [token]);
  const { busy, error, submit } = useSubmit(async () => {
    await api(`/api/auth/invites/${encodeURIComponent(token)}`, { method: 'POST', json: { name, password } });
    window.location.assign('/');
  });
  if (loadError) return <ErrorBox message={loadError} />;
  if (!invite) return <div className="h-40 rounded-xl bg-sf2 animate-pulse-soft" />;
  return (
    <form onSubmit={submit} className="space-y-3.5">
      <p className="text-[13px] leading-relaxed text-t2">
        {invite.invitedBy ? `${invite.invitedBy} invited you to join as ` : 'You are invited to join as '}
        <span className="font-semibold text-t1">{invite.role === 'admin' ? 'an admin' : 'a member'}</span>. You’ll sign in as{' '}
        <span className="font-mono text-[12px] text-t1">{invite.email}</span>.
      </p>
      <Field label="Your name">
        <Input name="name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Password" hint={passwordHint}>
        <Input type="password" name="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <input type="email" name="email" autoComplete="username" value={invite.email} readOnly hidden />
      <ErrorBox message={error} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Create account <ArrowRight className="size-3.5" />
      </Button>
    </form>
  );
}

export function ForgotForm({ smtp }: { smtp: boolean }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string>();
  const { busy, error, submit } = useSubmit(async () => {
    const result = await api<{ message: string }>('/api/auth/password/forgot', { method: 'POST', json: { email } });
    setSent(result.message);
  });
  if (!smtp) {
    return (
      <p className="text-[13px] leading-relaxed text-t2">
        This Landflow doesn’t send email. Ask an owner or admin for a password reset link: they can make one in Settings → Users.
      </p>
    );
  }
  if (sent) {
    return (
      <div className="flex gap-2.5 text-[13px] leading-relaxed text-t2">
        <MailCheck className="mt-0.5 size-4 shrink-0 text-gn" /> {sent}
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3.5">
      <Field label="Email">
        <Input type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Send reset link
      </Button>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [account, setAccount] = useState<{ email: string; name: string }>();
  const [loadError, setLoadError] = useState<string>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    api<{ email: string; name: string }>(`/api/auth/password/reset?token=${encodeURIComponent(token)}`)
      .then(setAccount)
      .catch((e) => setLoadError(messageOf(e)));
  }, [token]);
  const { busy, error, submit, setError } = useSubmit(async () => {
    await api('/api/auth/password/reset', { method: 'POST', json: { token, password } });
    window.location.assign('/');
  });
  if (loadError) return <ErrorBox message={loadError} />;
  if (!account) return <div className="h-40 rounded-xl bg-sf2 animate-pulse-soft" />;
  return (
    <form
      onSubmit={(e) => {
        if (password !== confirm) {
          e.preventDefault();
          setError('The passwords don’t match');
          return;
        }
        void submit(e);
      }}
      className="space-y-3.5"
    >
      <p className="text-[13px] text-t2">
        For <span className="font-mono text-[12px] text-t1">{account.email}</span>
      </p>
      <input type="email" name="email" autoComplete="username" value={account.email} readOnly hidden />
      <Field label="New password" hint={passwordHint}>
        <Input type="password" name="password" autoComplete="new-password" required autoFocus minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Repeat it">
        <Input type="password" name="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Set password and sign in
      </Button>
    </form>
  );
}
