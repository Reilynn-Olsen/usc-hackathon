import { DEFAULT_SIMULATION_OPTIONS, generateStrategies } from "../../../lib/harbormind/simulation.ts";
import { readDecisionCriteria, readHarnessRequest } from "../../../lib/harbormind/http.ts";

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  const { state, options, body } = parsed.value;
  const { criteria: decision, error: decisionError } = readDecisionCriteria(body.decision);
  if (!decision) return Response.json({ error: decisionError }, { status: 400 });
  const strategies = generateStrategies(state, options.horizonHours ?? DEFAULT_SIMULATION_OPTIONS.horizonHours, decision, options.criticalCargoOnTimeTargetPercent ?? DEFAULT_SIMULATION_OPTIONS.criticalCargoOnTimeTargetPercent);
  return Response.json({ scenarioId: state.scenarioId, strategies, dataProvenance: state.provenance });
}
