import type { SimulationOptions, SimulationState } from "./types.ts";
import { validateSimulationState } from "./validate.ts";

export interface HarnessRequest {
  state: SimulationState;
  options: Partial<SimulationOptions>;
  body: Record<string, unknown>;
}

export async function readHarnessRequest(request: Request): Promise<{ value?: HarnessRequest; response?: Response }> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { response: Response.json({ error: "Content-Type must be application/json." }, { status: 415 }) };
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) return { response: Response.json({ error: "Request body exceeds the 2 MB limit." }, { status: 413 }) };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: Response.json({ error: "Request body must be valid JSON." }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { response: Response.json({ error: "Request body must be an object." }, { status: 400 }) };
  const object = body as Record<string, unknown>;
  const validated = validateSimulationState(object.state);
  if (!validated.state) return { response: Response.json({ error: "Invalid simulation state.", details: validated.errors }, { status: 400 }) };
  const rawOptions = object.options;
  if (rawOptions !== undefined && (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions))) {
    return { response: Response.json({ error: "options must be an object." }, { status: 400 }) };
  }
  const options = (rawOptions ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const allowedOptions = new Set(["runs", "seed", "horizonHours", "timeStepHours", "criticalCargoOnTimeTargetPercent", "maxArrivalDelayHours", "weatherSeverityVariation", "capacityReductionVariation", "unloadingTimeVariation", "equipmentFailureProbability"]);
  for (const key of Object.keys(options)) if (!allowedOptions.has(key)) errors.push(`options.${key} is not supported.`);
  const integer = (key: "runs" | "seed" | "horizonHours" | "timeStepHours", min: number, max: number) => {
    const value = options[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) errors.push(`options.${key} must be an integer from ${min} to ${max}.`);
  };
  integer("runs", 1, 500);
  integer("seed", 0, 4_294_967_295);
  integer("horizonHours", 1, 720);
  integer("timeStepHours", 1, 24);
  const ranges: Array<[keyof SimulationOptions, number, number]> = [
    ["criticalCargoOnTimeTargetPercent", 0, 100],
    ["maxArrivalDelayHours", 0, 168],
    ["weatherSeverityVariation", 0, 1],
    ["capacityReductionVariation", 0, 1],
    ["unloadingTimeVariation", 0, 1],
    ["equipmentFailureProbability", 0, 1],
  ];
  for (const [key, min, max] of ranges) if (options[key] !== undefined && (typeof options[key] !== "number" || !Number.isFinite(options[key]) || Number(options[key]) < min || Number(options[key]) > max)) {
    errors.push(`options.${key} must be a number from ${min} to ${max}.`);
  }
  if (errors.length) return { response: Response.json({ error: "Invalid simulation options.", details: errors }, { status: 400 }) };
  return { value: { state: validated.state, options: options as Partial<SimulationOptions>, body: object } };
}
