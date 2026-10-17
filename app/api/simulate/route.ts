import { assertSimulationBudget, DEFAULT_SIMULATION_OPTIONS, generateStrategies, simulateStrategy } from "../../../lib/harbormind/simulation.ts";
import { readHarnessRequest } from "../../../lib/harbormind/http.ts";
import { validateStrategySelection } from "../../../lib/harbormind/decision.ts";

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  const { state, options, body } = parsed.value;
  const strategies = generateStrategies(state, options.horizonHours ?? DEFAULT_SIMULATION_OPTIONS.horizonHours);
  const strategy = validateStrategySelection(body.strategyId, strategies);
  if (!strategy) return Response.json({ error: "strategyId must identify a feasible strategy for this simulation state." }, { status: 422 });
  const baseline = strategies.find((item) => item.id === "baseline-arrival-order")!;
  try {
    assertSimulationBudget(state, { ...DEFAULT_SIMULATION_OPTIONS, ...options }, strategy.id === baseline.id ? 1 : 2);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Simulation request is too large." }, { status: 400 });
  }
  const outcome = simulateStrategy(state, strategy, options);
  const baselineOutcome = strategy.id === baseline.id ? outcome : simulateStrategy(state, baseline, options);
  return Response.json({
    scenarioId: state.scenarioId,
    strategyId: strategy.id,
    outcome,
    baseline: baselineOutcome,
    criticalCargoOnTimeChangePercent: Math.round((outcome.mean.criticalCargoOnTimePercent - baselineOutcome.mean.criticalCargoOnTimePercent) * 100) / 100,
    dataProvenance: state.provenance,
    humanApprovalRequired: true,
  });
}
