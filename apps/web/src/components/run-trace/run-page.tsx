'use client';
/** The full-screen Run Trace page: a back link to the execution, then the trace. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { ExecutionRecord } from '@/lib/shared/types';
import { RunTraceView } from './run-trace-view';

export function RunPage({ executionId }: { executionId: string }) {
  const [record, setRecord] = useState<Pick<ExecutionRecord, 'workflowId' | 'workflowName'>>();
  useEffect(() => {
    api<{ execution: ExecutionRecord }>(`/api/executions/${executionId}`)
      .then((r) => setRecord(r.execution))
      .catch(() => {});
  }, [executionId]);
  const href = record ? `/workflows/${record.workflowId}/executions/${executionId}` : '/executions';
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair bg-bg px-3">
        <Link href={href} className="inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-t2 hover:bg-acdim hover:text-t1">
          <ArrowLeft className="size-4" /> Execution
        </Link>
        <span className="min-w-0 truncate text-[14px] font-semibold text-t1">{record?.workflowName ?? 'Run trace'}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunTraceView executionId={executionId} executionHref={href} />
      </div>
    </div>
  );
}
