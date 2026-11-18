/** AG23: one asks-first tool a run nobody watches will refuse (GET /api/workflows/:id/unattended-approvals). */
export interface UnattendedApproval {
  tool: string;
  agent: string;
  node: string;
  trigger: string;
  /** `unattendedLine(tool, trigger)`. */
  line: string;
}
