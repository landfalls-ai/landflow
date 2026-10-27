/**
 * Settings → AI prices → AI usage caps: caps per model credential and per user (who started the run), per day or month,
 * in tokens or US dollars (lib/server/ai-usage/caps.ts). Enforced on every model call like the workflow and agent caps; a
 * call over a cap fails with a clear error, and an alert rule of kind "AI cost" warns before it.
 *
 * GET → { caps, usage } (what each used today and this month); PUT { credentials, users, allUsers? } — replace the caps.
 */
import { aiCaps, aiUsageMeter, saveAiCaps } from '@/lib/server/ai-usage';
import { aiCapsSchema } from '@/lib/server/ai-usage/caps';
import { recordAudit } from '@/lib/server/audit';
import { getUser } from '@/lib/server/auth/users';
import { credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';
import type { AiCapsView } from '@/lib/shared/ai-usage';

export const dynamic = 'force-dynamic';

function view(): AiCapsView {
  const meter = aiUsageMeter();
  const caps = aiCaps();
  const usage: AiCapsView['usage'] = { credentials: {}, users: {} };
  for (const id of Object.keys(caps.credentials)) usage.credentials[id] = { day: meter.sinceTotals('credential_id', id, 'day'), month: meter.sinceTotals('credential_id', id, 'month') };
  const users = new Set([...Object.keys(caps.users), ...(caps.allUsers ? meter.usersSince(`${meter.today().slice(0, 7)}-01`) : [])]);
  for (const id of users) usage.users[id] = { day: meter.sinceTotals('user_id', id, 'day'), month: meter.sinceTotals('user_id', id, 'month') };
  return { caps, usage };
}

export const GET = handler(async () => json(view()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, aiCapsSchema);
  if (!body.ok) return body.response;
  const { credentials: byCredential, users: byUser, allUsers } = body.data;
  // The names go with the caps, for the error a refused call shows.
  for (const [id, set] of Object.entries(byCredential)) {
    const credential = credentials.get(id);
    if (!credential) return error(`Credential ${id} not found`, 400);
    set.name = credential.name;
  }
  for (const [id, set] of Object.entries(byUser)) {
    const user = getUser(id);
    if (!user) return error(`User ${id} not found`, 400);
    set.name = user.name || user.email;
  }
  saveAiCaps({ credentials: byCredential, users: byUser, ...(allUsers && { allUsers }) });
  aiUsageMeter().invalidateCaps();
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'ai-caps', name: 'AI usage caps' }, details: { credentials: Object.keys(byCredential).length, users: Object.keys(byUser).length, allUsers: Boolean(allUsers) } });
  return json(view());
});
