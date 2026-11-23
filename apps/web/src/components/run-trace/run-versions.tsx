'use client';
/** AG21: the Run Trace's versions line: "workflow v4 · Alert triager v2" (the workflow version and each agent's, as the run recorded them). */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { runVersionsLine, type RunVersions } from '@/lib/shared/agent-versions';

export function RunVersionsLine({ executionId }: { executionId: string }) {
  const [versions, setVersions] = useState<RunVersions>();
  useEffect(() => {
    let cancelled = false;
    api<{ execution: { versions?: RunVersions } }>(`/api/executions/${executionId}`, { background: true })
      .then((r) => !cancelled && setVersions(r.execution.versions))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [executionId]);
  if (!versions?.agents.length) return null;
  return (
    <div data-testid="run-versions" className="text-[12px] leading-snug text-t2 [overflow-wrap:anywhere]" title="The workflow version and the agent versions this run used">
      {runVersionsLine(versions)}
    </div>
  );
}
