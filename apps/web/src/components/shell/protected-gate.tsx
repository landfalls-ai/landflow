'use client';
/**
 * Wraps a control that creates or changes workflows: in a protected environment (`reason`, from
 * lib/client/environment.ts `useWorkflowsReadOnly`) the control is disabled by its caller and this shows why on hover
 * (a disabled button gets no pointer events of its own).
 */
import type { ReactNode } from 'react';

export function ProtectedGate({ reason, children }: { reason?: string; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <span title={reason} className="inline-flex cursor-not-allowed" data-testid="protected-gate">
      {children}
    </span>
  );
}
