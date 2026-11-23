/** The one word a request shows (docs/access-requests.md#the-access-page): waiting, approved, granted, denied, expired, failed, cancelled or removed. */
import type { AccessState } from '@/lib/shared/access';
import { STATE_WORDS } from '@/lib/client/access';
import { Badge, type Tone } from '../ui/badge';

const TONES: Record<AccessState, Tone> = {
  waiting: 'warning',
  approved: 'accent',
  granted: 'success',
  denied: 'danger',
  expired: 'muted',
  failed: 'danger',
  cancelled: 'muted',
  removed: 'muted',
};

export function StateBadge({ state }: { state: AccessState }) {
  return <Badge tone={TONES[state]}>{STATE_WORDS[state]}</Badge>;
}
