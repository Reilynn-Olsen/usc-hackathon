import { createStormScenario } from "../../../lib/harbormind/demo.ts";

export async function GET() {
  return Response.json(createStormScenario(), { headers: { "Cache-Control": "no-store" } });
}
