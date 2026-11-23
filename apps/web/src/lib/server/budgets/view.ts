/**
 * The `ProjectBudgetView` for one viewer (docs/projects-and-goals.md#ai-budget): the budget, the month's spend and
 * incidents, and what the viewer may do. "Ask for more" (`canAsk`) is for a project's editors who are not its admins,
 * while the cap-raise flow is on.
 */
import type { ProjectBudgetView } from '../../shared/project-budget';
import { capRaiseSetup } from '../llm-gateway/console';
import { projectRole, type Actor } from '../projects/access';
import { viewerOf } from './enforce';
import { budgetView, getBudget, type BudgetMeter } from './store';

export function budgetViewFor(meter: BudgetMeter, actor: Actor, projectId: string): ProjectBudgetView {
  const viewer = viewerOf(actor, projectId, getBudget(projectId));
  return budgetView(meter, projectId, { canEdit: viewer.canEdit, canResume: viewer.canResume, canAsk: projectRole(actor, projectId) === 'editor' && capRaiseSetup().active });
}
