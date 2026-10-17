import { createRecommendation } from "../../../lib/harbormind/decision.ts";
import { SimulationBudgetError } from "../../../lib/harbormind/simulation.ts";
import { readHarnessRequest } from "../../../lib/harbormind/http.ts";
import type { DecisionCriteria, OptimizationObjective } from "../../../lib/harbormind/types.ts";

const objectives = new Set<OptimizationObjective>(["critical-delivery", "minimize-delay", "minimize-cost", "balanced"]);

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  const rawDecision = parsed.value.body.decision;
  let decision: DecisionCriteria = { objective: "balanced" };
  if (rawDecision !== undefined) {
    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)) return Response.json({ error: "decision must be an object." }, { status: 400 });
    const value = rawDecision as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["objective", "maximumDisruptionCost"].includes(key))
      || typeof value.objective !== "string" || !objectives.has(value.objective as OptimizationObjective)
      || (value.maximumDisruptionCost !== undefined && (typeof value.maximumDisruptionCost !== "number" || !Number.isFinite(value.maximumDisruptionCost) || value.maximumDisruptionCost < 0))) {
      return Response.json({ error: "decision must contain a supported objective and an optional nonnegative maximumDisruptionCost." }, { status: 400 });
    }
    decision = {
      objective: value.objective as OptimizationObjective,
      ...(typeof value.maximumDisruptionCost === "number" ? { maximumDisruptionCost: value.maximumDisruptionCost } : {}),
    };
  }
  try {
    const { recommendation, strategies, evaluatedStrategies } = await createRecommendation(parsed.value.state, parsed.value.options, undefined, decision);
    return Response.json({ recommendation, availableStrategies: strategies, evaluatedStrategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not evaluate the scenario.";
    return Response.json({ error: message }, { status: error instanceof SimulationBudgetError ? 400 : message.startsWith("No feasible recovery strategy") ? 422 : 500 });
  }
}
