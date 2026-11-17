import type { BuildPlan } from './build-plan'; // SB13:

/**
 * The plan without a step: a main step that followed it follows the step's own `from` (and output); a sub-node attached
 * to it (a chat model on an agent) goes with it. The trigger stays (a step with no `from` is never dropped).
 */
export function withoutStep(plan: BuildPlan, key: string): BuildPlan {
  const gone = plan.steps.find((s) => s.key === key);
  if (!gone || !gone.from) return plan;
  return {
    ...plan,
    steps: plan.steps
      .filter((s) => s.key !== key && !(s.attach && s.from === key))
      .map((s) => {
        if (s.from !== key) return s;
        const { output: _output, ...rest } = s;
        return { ...rest, from: gone.from, ...(gone.output ? { output: gone.output } : {}) };
      }),
  };
}
