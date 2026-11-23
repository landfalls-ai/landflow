'use client';
/** The "Your sessions" list on /connect: the person's own open Claude Code sessions with status, repository and counts (docs/connect-your-harness.md). */
import { timeAgo, plural } from '@/lib/client/format';
import { harnessChipLabel, harnessChipTone, type HarnessSessionView } from '@/lib/shared/harness';
import { Badge } from '@/components/ui/badge';

export function YourSessions({ sessions }: { sessions?: HarnessSessionView[] }) {
  if (!sessions) return <p className="text-[12px] text-t3">Loading…</p>;
  if (sessions.length === 0) return <p className="text-[12px] text-t3">No open sessions yet. They show here once the hooks are in place and you start Claude Code.</p>;
  return (
    <ul className="divide-y divide-hair rounded-[10px] border border-hair">
      {sessions.map((s) => (
        <li key={s.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <Badge tone={harnessChipTone(s)}>{harnessChipLabel(s)}</Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t2">{s.repository ?? 'Repository not shared'}</span>
          <span className="text-[12px] text-t3">
            {plural(s.prompts, 'prompt')}, {plural(s.toolCalls, 'tool call')} · {timeAgo(s.lastEventAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
