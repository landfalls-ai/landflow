/**
 * Settings → Alerts: the fields of the two channels that open tickets for approval requests (C12): ServiceNow (instance
 * URL, a Basic or Bearer login, the table, and the optional state each outcome sets) and the webhook's "Opens tickets"
 * box. Rendered inside the channel editor (alerts-settings.tsx), which owns the state; for any other kind it renders
 * nothing. The ticket carries no parameter values and never decides: it only notifies and links back.
 */
import type { AlertChannelConfig, AlertChannelKind } from '@/lib/shared/alerts';
import { Checkbox, FieldLabel, Input, Select } from '@/components/ui/inputs';

const LOGINS = ['core.httpBasicAuth', 'core.httpBearerAuth'];

const STATES = [
  { field: 'approvedState', label: 'State when approved', placeholder: 'e.g. 3' },
  { field: 'deniedState', label: 'State when denied', placeholder: 'e.g. 4' },
  { field: 'expiredState', label: 'State when expired', placeholder: 'leave empty: note only' },
  { field: 'cancelledState', label: 'State when cancelled', placeholder: 'leave empty: note only' },
] as const;

export function AlertTicketFields({
  kind,
  config,
  set,
  credentials,
}: {
  kind: AlertChannelKind;
  config: AlertChannelConfig;
  set: (next: Partial<AlertChannelConfig>) => void;
  credentials: readonly { id: string; name: string; type: string }[];
}) {
  if (kind === 'webhook') {
    return (
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] sm:gap-3">
        <div className="hidden sm:block" />
        <div>
          <Checkbox checked={config.tickets === true} onChange={(on) => set({ tickets: on })} label="Opens tickets" />
          <p className="mt-1 text-[11px] leading-snug text-t3">
            For approval requests this channel POSTs <code className="font-mono">approval.requested</code> and expects <code className="font-mono">{'{ "ticket": { "id": "…", "url": "…" } }'}</code> back, then{' '}
            <code className="font-mono">approval.settled</code> when a person has decided in Landflow. The ticket never decides.
          </p>
        </div>
      </div>
    );
  }
  if (kind !== 'servicenow') return null;
  const logins = credentials.filter((c) => LOGINS.includes(c.type));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Instance URL</FieldLabel>
          <Input value={config.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.service-now.com" />
        </div>
        <div>
          <FieldLabel>Credential</FieldLabel>
          <Select value={config.credentialId ?? ''} onChange={(e) => set({ credentialId: e.target.value })}>
            <option value="">{logins.length ? 'Choose a Basic or Bearer login' : 'No Basic Auth or Bearer Auth credential yet'}</option>
            {logins.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Table</FieldLabel>
          <Input value={config.table ?? ''} onChange={(e) => set({ table: e.target.value })} placeholder="change_request" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {STATES.map((s) => (
          <div key={s.field}>
            <FieldLabel>{s.label}</FieldLabel>
            <Input value={config[s.field] ?? ''} onChange={(e) => set({ [s.field]: e.target.value })} placeholder={s.placeholder} />
          </div>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-t3">
        Each approval request opens one ticket with the tool, workflow and a link back to Needs you, never the parameters. When a person decides, Landflow adds a work note and, for the states you fill in, sets the state. Use this
        channel in a rule for “Waits for your approval”.
      </p>
    </div>
  );
}
