/**
 * GET /api/audit/verify — check the audit log's hash chain (lib/server/audit/chain.ts): every event's hash against its
 * stored fields, every link against the event before it, no gaps, the newest event against the head record. Answers
 * the report (`ok`, how many were checked, where it breaks and why); the check itself is audited, as a failure when the
 * chain is broken (so a SIEM hears of it). Owners and admins; API keys need the `audit:read` scope.
 */
import { recordAudit } from '@/lib/server/audit';
import { verifyChain } from '@/lib/server/audit/chain';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const report = await verifyChain();
  recordAudit({
    action: 'audit.verify',
    outcome: report.ok ? 'success' : 'failure',
    target: { type: 'audit_log' },
    summary: report.ok ? `Verified the audit log’s hash chain: ${report.checked} events intact` : `The audit log’s hash chain is broken at #${report.brokenAt?.seq ?? '?'}: ${report.brokenAt?.reason ?? ''}`,
    details: { ok: report.ok, checked: report.checked, firstSeq: report.firstSeq, lastSeq: report.lastSeq, pending: report.pending, legacy: report.legacy, problems: report.problems.length, brokenAtSeq: report.brokenAt?.seq, brokenAtEvent: report.brokenAt?.eventId },
  });
  return json(report);
});
