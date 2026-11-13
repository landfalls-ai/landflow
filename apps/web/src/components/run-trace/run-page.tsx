'use client';
/** The full-screen Run Trace page: the header (back to the run in its workflow's Executions), then the trace. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { ExecutionRecord } from '@/lib/shared/types';
import { RunTraceView } from './run-trace-view';
import { JsonRenderGallery } from './ui-cards';
import { useJsonRender } from './use-json-render';
import { DebugAccessButton } from './debug-access';
import { PageHeader } from '../shell/page-header';

/**
 * With json-render on (Settings → General, read at runtime), /runs/json-render-gallery shows the spec cards (dev page).
 * Off, it is just an id no run has: the usual page for a run that does not exist.
 */
export function RunPage({ executionId }: { executionId: string }) {
  return executionId === 'json-render-gallery' ? <GalleryOrRun executionId={executionId} /> : <RunPageOf executionId={executionId} />;
}

function GalleryOrRun({ executionId }: { executionId: string }) {
  const on = useJsonRender();
  if (on === undefined) return null;
  return on ? <JsonRenderGallery /> : <RunPageOf executionId={executionId} />;
}

function RunPageOf({ executionId }: { executionId: string }) {
  const [record, setRecord] = useState<Pick<ExecutionRecord, 'workflowId' | 'workflowName'>>();
  useEffect(() => {
    api<{ execution: ExecutionRecord }>(`/api/executions/${executionId}`)
      .then((r) => setRecord(r.execution))
      .catch(() => {});
  }, [executionId]);
  const href = record ? `/workflows/${record.workflowId}/executions/${executionId}` : '/executions';
  return (
    <div className="flex h-dvh flex-col">
      <PageHeader back={{ href, label: 'Executions' }} title="Run trace" actions={<DebugAccessButton executionId={executionId} />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunTraceView executionId={executionId} executionHref={href} />
      </div>
    </div>
  );
}
