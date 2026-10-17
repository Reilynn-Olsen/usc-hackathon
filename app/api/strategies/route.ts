import { DEFAULT_SIMULATION_OPTIONS, generateStrategies } from "../../../lib/harbormind/simulation.ts";
import { readHarnessRequest } from "../../../lib/harbormind/http.ts";

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  const { state, options } = parsed.value;
  const strategies = generateStrategies(state, options.horizonHours ?? DEFAULT_SIMULATION_OPTIONS.horizonHours);
  return Response.json({ scenarioId: state.scenarioId, strategies, dataProvenance: state.provenance });
}
