import { alertsView } from '@/lib/server/alerts/api';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** GET: the alert channels (secrets masked), the rules, and whether email can go out. */
export const GET = handler(async () => json(alertsView()));
