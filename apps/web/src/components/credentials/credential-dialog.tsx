'use client';
/**
 * Create or edit a saved credential: pick one of the types plugins publish,
 * fill in the form rendered from its properties, test the connection through
 * the plugin, save. Secret fields are never sent back by the API; leaving one
 * empty while editing keeps the saved value. OAuth2 types add provider presets
 * and a Connect panel (./oauth2-connect), which save the form first.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BookOpen, Check, KeyRound, PlugZap, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { duration } from '@/lib/client/format';
import { OAUTH2_CREDENTIAL } from '@/lib/shared/oauth2';
import type { CredentialDetail, CredentialTypeInfo, PropertyDescriptor } from '@/lib/shared/types';
import { ParamForm } from '../editor/param-form';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { AppIcon } from '../ui/icon';
import { FieldLabel, Input } from '../ui/inputs';
import { OAuth2Connection, OAuth2Presets } from './oauth2-connect';
import { useCredentialStore } from './use-credentials';
import { useDialogFocus } from '../ui/use-dialog-focus';
import { usePhone } from '@/lib/client/use-phone';

type TestResult = { ok: boolean; message?: string; durationMs?: number };

export function CredentialTypeIcon({ info, size = 32 }: { info?: CredentialTypeInfo; size?: number }) {
  return <AppIcon icon={info?.descriptor.icon ?? info?.pluginIcon ?? 'key-round'} color={info?.pluginColor} size={size} />;
}

function defaultsOf(info: CredentialTypeInfo) {
  return Object.fromEntries(info.descriptor.properties.filter((p) => p.default !== undefined).map((p) => [p.name, p.default]));
}

function TypePicker({ types, onPick }: { types: CredentialTypeInfo[]; onPick: (type: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return types
      .filter((t) => !q || `${t.descriptor.displayName} ${t.pluginName} ${t.descriptor.description ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => a.descriptor.displayName.localeCompare(b.descriptor.displayName));
  }, [types, query]);
  useEffect(() => setActive(0), [query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-5 pt-1">
        <Search className="pointer-events-none absolute left-8 top-1/2 size-4 -translate-y-1/2 text-t3" />
        <Input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((i) => Math.min(shown.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter' && shown[active]) onPick(shown[active].type);
            else return;
            e.preventDefault();
          }}
          placeholder="Search apps and services…"
          className="pl-9"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {shown.map((info, index) => (
          <button
            key={info.type}
            onClick={() => onPick(info.type)}
            onMouseEnter={() => setActive(index)}
            style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
            className={cn('flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors animate-fade-up', index === active && 'bg-acdim')}
          >
            <CredentialTypeIcon info={info} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-t1">{info.descriptor.displayName}</span>
              <span className="block truncate text-[12px] text-t3">{info.descriptor.description ?? `Used by ${info.nodeTypes.length} node${info.nodeTypes.length === 1 ? '' : 's'}`}</span>
            </span>
            <span className="shrink-0 text-[11px] text-t3">{info.pluginName}</span>
            {!info.available && <Badge tone="warning">offline</Badge>}
          </button>
        ))}
        {!shown.length && (
          <p className="px-3 py-10 text-center text-[13px] text-t3">
            {types.length ? 'No credential type matches.' : 'No plugin publishes a credential type yet. Start an integration plugin and it shows up here.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function CredentialDialog({
  credentialId,
  allowedTypes,
  onClose,
  onSaved,
  projectId,
}: {
  /** Edit this credential; otherwise create one. */
  credentialId?: string;
  /** Create it in this project (default: the viewer's personal project). */
  projectId?: string;
  /** Restrict the type picker (a node's requirement); one type skips the picker. */
  allowedTypes?: string[];
  onClose: () => void;
  onSaved?: (credential: CredentialDetail) => void;
}) {
  const types = useCredentialStore((s) => s.types) ?? [];
  const [type, setType] = useState<string | undefined>(allowedTypes?.length === 1 ? allowedTypes[0] : undefined);
  const panel = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  // A phone: a bottom sheet that keeps the focus inside (docs/mobile.md#sheets-and-dialogs).
  useDialogFocus(panel, phone);
  const [existing, setExisting] = useState<CredentialDetail>();
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [test, setTest] = useState<TestResult | 'running'>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Rate limit (calls per interval, shared by every node and run that uses the credential); empty = none.
  const [rateCalls, setRateCalls] = useState('');
  const [rateSeconds, setRateSeconds] = useState('60');
  const info = types.find((t) => t.type === type);

  useEffect(() => {
    if (!credentialId) return;
    api<{ credential: CredentialDetail }>(`/api/credentials/${credentialId}`)
      .then(({ credential }) => {
        setExisting(credential);
        setType(credential.type);
        setName(credential.name);
        setValues(credential.data);
        setRateCalls(credential.rateLimit ? String(credential.rateLimit.limit) : '');
        setRateSeconds(credential.rateLimit ? String(credential.rateLimit.intervalSeconds) : '60');
      })
      .catch((e: Error) => setError(e.message));
  }, [credentialId]);

  // A new credential starts from the type's defaults and a name like "Telegram API account".
  useEffect(() => {
    if (credentialId || !info) return;
    setValues(defaultsOf(info));
    setName((n) => n || `${info.descriptor.displayName} account`);
    setTest(undefined);
  }, [info, credentialId]);

  // Capture phase: Escape closes this dialog, not the node panel underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pickable = allowedTypes ? types.filter((t) => allowedTypes.includes(t.type)) : types;
  // Saved secrets render empty with a hint; leaving them empty keeps them.
  const properties = useMemo<PropertyDescriptor[]>(
    () =>
      (info?.descriptor.properties ?? []).map((p) => {
        const saved = existing?.secrets.includes(p.name);
        return {
          ...p,
          noDataExpression: true,
          placeholder: saved ? '•••••••• saved — type to replace' : (p.placeholder ?? ''),
          ...(saved && { required: false }),
        };
      }),
    [info, existing],
  );

  const runTest = async () => {
    if (!type) return;
    setTest('running');
    try {
      setTest(await api<TestResult>('/api/credentials/test', { method: 'POST', json: { type, data: values, ...(existing && { id: existing.id }) } }));
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
    }
  };

  /** Save the form (PATCH, or create the credential): the saved credential, or undefined with the error shown. */
  const persist = async (): Promise<CredentialDetail | undefined> => {
    if (!type) return undefined;
    setError(undefined);
    const calls = Math.floor(Number(rateCalls));
    const seconds = Number(rateSeconds);
    if (rateCalls.trim() && (!(calls >= 1) || !(seconds >= 0.1))) {
      setError('The rate limit needs at least 1 call per interval of at least 0.1 seconds (or leave the calls empty for no limit).');
      return undefined;
    }
    const rateLimit = rateCalls.trim() ? { limit: calls, intervalSeconds: seconds } : null;
    try {
      const { credential } = existing
        ? await api<{ credential: CredentialDetail }>(`/api/credentials/${existing.id}`, { method: 'PATCH', json: { name, data: values, rateLimit } })
        : await api<{ credential: CredentialDetail }>(`/api/credentials${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`, { method: 'POST', json: { name, type, data: values, ...(rateLimit && { rateLimit }) } });
      await useCredentialStore.getState().refresh();
      return credential;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  };

  const save = async () => {
    setSaving(true);
    const credential = await persist();
    setSaving(false);
    if (!credential) return;
    toast.success(existing ? `Saved ${credential.name}` : `Created ${credential.name}`);
    onSaved?.(credential);
    onClose();
  };

  /** OAuth2 Connect / Get token save first; a credential created that way is the one this dialog edits from then on. */
  const ensureSaved = async () => {
    const credential = await persist();
    if (credential && !existing) {
      setExisting(credential);
      onSaved?.(credential);
    }
    return credential;
  };

  const remove = async () => {
    if (!existing) return;
    try {
      await api(`/api/credentials/${existing.id}`, { method: 'DELETE' });
      await useCredentialStore.getState().refresh();
      toast.success(`Deleted ${existing.name}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const picking = !type && !credentialId;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 animate-in max-md:items-end max-md:p-0" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal={phone || undefined}
        aria-label={existing ? `Edit ${existing.name}` : 'New credential'}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[min(720px,90vh)] w-[560px] flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop animate-panel max-md:w-full max-md:!max-w-none max-md:max-h-[92dvh] max-md:rounded-b-none max-md:pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex items-center gap-3 border-b border-hair px-5 py-3.5">
          {!picking && !credentialId && (!allowedTypes || allowedTypes.length > 1) && (
            <Button size="icon-sm" variant="ghost" onClick={() => setType(undefined)} aria-label="Choose another type">
              <ArrowLeft className="size-4" />
            </Button>
          )}
          {picking ? <AppIcon icon="key-round" size={32} /> : <CredentialTypeIcon info={info} />}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-t1">{picking ? 'New credential' : (info?.descriptor.displayName ?? existing?.type ?? 'Credential')}</h2>
            <p className="truncate text-[12px] text-t3">
              {picking ? 'Choose the app or service to connect' : info ? `${info.pluginName} · stored encrypted on the host` : 'The plugin that owns this type is not registered'}
            </p>
          </div>
          {info?.descriptor.documentationUrl && (
            <a href={info.descriptor.documentationUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[12px] text-t2 hover:text-ac">
              <BookOpen className="size-3.5" /> Docs
            </a>
          )}
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close" className="max-md:size-11">
            <X className="size-4" />
          </Button>
        </header>

        {picking ? (
          <TypePicker types={pickable} onPick={setType} />
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <FieldLabel>Credential name</FieldLabel>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My account" />
              </div>
              {info ? (
                <>
                  {info.type === OAUTH2_CREDENTIAL && <OAuth2Presets values={values} onChange={setValues} />}
                  <ParamForm nodeType="" properties={properties} values={values} onChange={setValues} expressionScope="credential" />
                  {info.oauth2 && <OAuth2Connection credential={existing} grantType={String(values.grantType ?? 'pkce')} ensureSaved={ensureSaved} onChange={setExisting} />}
                </>
              ) : (
                existing && (
                  <div className="rounded-[10px] border border-dashed border-bd p-4 text-[13px] text-t2">
                    Start the plugin that publishes <span className="font-mono">{existing.type}</span> to edit or test this credential. Nodes keep using it in the meantime.
                  </div>
                )
              )}
              {info && (
                <div>
                  <FieldLabel>Rate limit</FieldLabel>
                  <div className="flex items-center gap-2 text-[13px] text-t2">
                    <Input className="w-24" inputMode="numeric" value={rateCalls} onChange={(e) => setRateCalls(e.target.value)} placeholder="No limit" aria-label="Calls per interval" />
                    <span>calls per</span>
                    <Input className="w-20" inputMode="decimal" value={rateSeconds} onChange={(e) => setRateSeconds(e.target.value)} aria-label="Interval in seconds" />
                    <span>seconds</span>
                  </div>
                  <p className="mt-1 text-[12px] text-t3">Shared by every node and run that uses this credential (and across processes in queue mode). Calls over it wait their turn instead of failing.</p>
                </div>
              )}
              {test && test !== 'running' && (
                <div
                  key={`${test.ok}${test.message}${test.durationMs}`}
                  className={cn('flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[13px] animate-fade-up', test.ok ? 'border-gnbd bg-gndim text-gn' : 'border-rdbd bg-rddim text-rd animate-shake')}
                >
                  {test.ok ? <Check className="mt-0.5 size-4 shrink-0" /> : <X className="mt-0.5 size-4 shrink-0" />}
                  <span className="min-w-0 flex-1 break-words">{test.message ?? (test.ok ? 'Connection works' : 'Connection failed')}</span>
                  {test.durationMs !== undefined && <span className="shrink-0 font-mono text-[11px] opacity-70">{duration(test.durationMs)}</span>}
                </div>
              )}
              {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error}</div>}
            </div>

            <footer className="flex items-center gap-2 border-t border-hair px-5 py-3">
              {existing &&
                (confirmDelete ? (
                  <div role="alertdialog" aria-label="Delete this credential?" className="flex items-center gap-2 animate-fade-up">
                    <span className="text-[12px] text-t2">{existing.usedBy.length ? `Used by ${existing.usedBy.length} workflow(s). Delete?` : 'Delete?'}</span>
                    <Button size="sm" variant="danger" onClick={remove}>
                      <Trash2 className="size-3" /> Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete credential" title="Delete credential">
                    <Trash2 className="size-4" />
                  </Button>
                ))}
              <div className="ml-auto flex items-center gap-2">
                {info?.descriptor.testable && (
                  <Button onClick={runTest} loading={test === 'running'} title="Ask the plugin to make a cheap authenticated call">
                    <PlugZap className="size-3.5" /> Test connection
                  </Button>
                )}
                <Button variant="primary" onClick={save} loading={saving} disabled={!info}>
                  <KeyRound className="size-3.5" /> {existing ? 'Save' : 'Create'}
                </Button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
