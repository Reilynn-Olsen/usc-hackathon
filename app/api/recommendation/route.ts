import { createRecommendation } from "../../../lib/harbormind/decision.ts";
import { SimulationBudgetError } from "../../../lib/harbormind/simulation.ts";
import { readHarnessRequest } from "../../../lib/harbormind/http.ts";

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  try {
    const { recommendation, strategies } = await createRecommendation(parsed.value.state, parsed.value.options);
    return Response.json({ recommendation, availableStrategies: strategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not evaluate the scenario.";
    return Response.json({ error: message }, { status: error instanceof SimulationBudgetError ? 400 : message.startsWith("No feasible recovery strategy") ? 422 : 500 });
  }
}
