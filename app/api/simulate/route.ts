import { assertReplayBudget, assertSimulationBudget, DEFAULT_SIMULATION_OPTIONS, generateStrategies, generateStrategyForPlan, simulateStrategyWithReplay } from "../../../lib/harbormind/simulation.ts";
import { readHarnessRequest } from "../../../lib/harbormind/http.ts";
import { validateStrategySelection } from "../../../lib/harbormind/decision.ts";
import type { RecoveryPlanSelection } from "../../../lib/harbormind/types.ts";

function readPlan(value: unknown): RecoveryPlanSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  const keys = ["prioritizeCriticalCargo", "staggerLowerPriorityVessels", "reserveCapacityForCriticalCargo", "divertStandardShipment"];
  if (Object.keys(plan).length !== keys.length || keys.some((key) => typeof plan[key] !== "boolean")) return undefined;
  return plan as unknown as RecoveryPlanSelection;
}

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  const { state, options, body } = parsed.value;
  const hasPlan = Object.hasOwn(body, "plan");
  const hasStrategyId = Object.hasOwn(body, "strategyId");
  if (hasPlan === hasStrategyId) return Response.json({ error: "Provide exactly one of plan or strategyId." }, { status: 400 });
  const simulationOptions = { ...DEFAULT_SIMULATION_OPTIONS, ...options };
  const strategies = generateStrategies(state, simulationOptions.horizonHours);
  const plan = hasPlan ? readPlan(body.plan) : undefined;
  if (hasPlan && !plan) return Response.json({ error: "plan must contain four boolean recovery action fields." }, { status: 400 });
  const strategy = plan
    ? generateStrategyForPlan(state, plan, simulationOptions.horizonHours)
    : validateStrategySelection(body.strategyId, strategies);
  if (!strategy) return Response.json({ error: hasPlan ? "The selected action combination is not feasible for this simulation state." : "strategyId must identify a feasible strategy for this simulation state." }, { status: 422 });
  const baseline = strategies.find((item) => item.id === "baseline-arrival-order")!;
  try {
    assertSimulationBudget(state, simulationOptions, strategy.id === baseline.id ? 1 : 2);
    assertReplayBudget(state, simulationOptions, strategy.id === baseline.id ? 1 : 2);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Simulation request is too large." }, { status: 400 });
  }
  const baselineResult = simulateStrategyWithReplay(state, baseline, simulationOptions);
  const selectedResult = strategy.id === baseline.id ? baselineResult : simulateStrategyWithReplay(state, strategy, simulationOptions);
  const { summary: outcome, replay } = selectedResult;
  const baselineOutcome = baselineResult.summary;
  return Response.json({
    scenarioId: state.scenarioId,
    strategyId: strategy.id,
    strategy,
    outcome,
    baseline: baselineOutcome,
    replay,
    baselineReplay: baselineResult.replay,
    criticalCargoOnTimeChangePercent: Math.round((outcome.mean.criticalCargoOnTimePercent - baselineOutcome.mean.criticalCargoOnTimePercent) * 100) / 100,
    dataProvenance: state.provenance,
    humanApprovalRequired: true,
  });
}
