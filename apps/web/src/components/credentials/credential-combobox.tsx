'use client';
/**
 * The credential picker of the node panel (and of any form that picks one credential of a type): the kit's Combobox with
 * the credentials as options, each with its project as the hint ("shared" when it is reached through a share), and, for
 * text nothing matches, "Create “text”" that opens the credential dialog with that name. It holds no data and picks
 * nothing on its own: the caller gives the credentials (already limited to what the workflow's project may use) and keeps
 * the auto-pick of the one fitting credential (use-credentials.ts `autoPickStep`).
 */
import { Combobox, type ComboboxCreation, type ComboOption } from '../ui/combobox';
import type { ResourceOwnership } from '@/lib/shared/projects';
import type { CredentialSummary } from '@/lib/shared/types';

/** The project line under a credential: its home project, and "shared" when the person reaches it through a share. */
function hintOf(credential: CredentialSummary): string | undefined {
  const ownership = (credential as { ownership?: ResourceOwnership }).ownership;
  if (!ownership?.projectName) return undefined;
  return ownership.shared ? `${ownership.projectName} · shared` : ownership.projectName;
}

/** The options for a requirement's credentials, in the order given; `groupBy` heads a group when a requirement takes several types. */
export function credentialOptions(credentials: CredentialSummary[], options: { groupBy?: (credential: CredentialSummary) => string | undefined } = {}): ComboOption[] {
  return credentials.map((c) => {
    const hint = hintOf(c);
    const group = options.groupBy?.(c);
    return { value: c.id, label: c.name, ...(hint && { hint }), ...(group && { group }) };
  });
}

/** The combobox's creation row, handing the name to the dialog. */
export function credentialCreation(onCreate: (name: string) => void): ComboboxCreation {
  return { label: (text) => `Create “${text}”`, onCreate: (text) => onCreate(text.trim()) };
}

export function CredentialCombobox({
  id,
  label,
  credentials,
  value,
  onPick,
  onCreate,
  disabled,
  groupBy,
}: {
  id: string;
  label: string;
  credentials: CredentialSummary[];
  /** The picked credential's id. */
  value: string | undefined;
  onPick: (credential: CredentialSummary) => void;
  /** The create dialog, with the name that was typed. */
  onCreate: (name: string) => void;
  disabled?: boolean;
  groupBy?: (credential: CredentialSummary) => string | undefined;
}) {
  return (
    <Combobox
      id={id}
      label={label}
      value={value}
      options={credentialOptions(credentials, { groupBy })}
      onChange={(next) => {
        const picked = credentials.find((c) => c.id === next);
        if (picked) onPick(picked);
      }}
      placeholder={credentials.length ? 'Select a credential…' : 'No credential yet'}
      emptyText={credentials.length ? 'No credential matches' : 'No credential yet: type a name to create one'}
      creation={credentialCreation(onCreate)}
      disabled={disabled}
    />
  );
}
