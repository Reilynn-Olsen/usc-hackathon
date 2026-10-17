import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { JevAssessment, RecoveryStrategy, SimulationOptions, SimulationState, SimulationSummary, Recommendation } from "./types.ts";
import { assertSimulationBudget, DEFAULT_SIMULATION_OPTIONS, generateStrategies, simulateStrategy } from "./simulation.ts";

const CARGO_URGENCY_RUBRIC = [
  "No essential cargo, or the nearest essential deadline is more than 72 hours away with low delay consequences.",
  "The nearest essential deadline is 48 to 72 hours away and estimated delay consequences are limited.",
  "An essential deadline is 24 to 48 hours away, or delay consequences are significant.",
  "Essential cargo is due within 24 hours, or delay consequences are very high.",
] as const;
const OPERATIONAL_RISK_RUBRIC = [
  "Low: at least 80% of normal capacity, no severe active disruption, and no important modeled weather alert.",
  "Moderate: 60% to 79% of normal capacity, a moderate disruption, or a manageable queue.",
  "High: 40% to 59% of normal capacity, severe weather, or essential cargo at risk from the modeled queue.",
  "Severe: below 40% of normal capacity, no modeled unloading capacity, or low simulated odds of meeting the critical-cargo target.",
] as const;

export type JevReply = {
  model: string;
  selection: { choice: string; confidence: number; probabilities: Record<string, number> };
  cargoUrgency: { score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
  operationalRisk: { score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
  humanReview: number;
  timeCritical: number;
};

export type JevCall = (state: SimulationState, strategies: RecoveryStrategy[], outcomes: Map<string, SimulationSummary>) => Promise<JevReply>;

function reviewIndicators(state: SimulationState): string[] {
  const result: string[] = [];
  for (const port of state.ports) {
    const reduction = port.normalCapacityContainersPerDay ? 100 * (1 - port.currentCapacityContainersPerDay / port.normalCapacityContainersPerDay) : 100;
    if (reduction > 0) result.push(`${port.location.name} operating ${Math.round(reduction)}% below normal modeled capacity.`);
    for (const disruption of port.activeDisruptions) result.push(`${port.location.name}: ${disruption.description}`);
    if (Math.min(port.availableBerths, port.unloadingResources) < port.queueShipIds.length) result.push(`${port.location.name} has fewer concurrent unloading positions than queued ships.`);
  }
  for (const weather of state.weather) for (const alert of weather.alerts) result.push(`${weather.portId}: ${alert.description}`);
  if (state.provenance.weather === "unavailable") result.push("Weather forecast data is unavailable for this scenario.");
  if (state.provenance.weatherAlerts === "unavailable" || state.provenance.weatherAlerts === "mixed") result.push("Severe weather alert coverage is unavailable or incomplete in the supplied weather data.");
  return [...new Set(result)];
}

function affectedShipsForStrategy(state: SimulationState, strategy: RecoveryStrategy, baseline: RecoveryStrategy): string[] {
  const affected = new Set<string>();
  const baselineOrder = baseline.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId);
  const strategyOrder = strategy.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId);
  strategyOrder.forEach((vesselId, index) => { if (vesselId !== baselineOrder[index]) affected.add(vesselId); });
  for (const ship of state.ships) if (strategy.assignments[ship.vesselId] !== baseline.assignments[ship.vesselId]) affected.add(ship.vesselId);
  for (const action of strategy.actions) {
    if (action.type === "delay") affected.add(action.vesselId);
    if (action.type === "allocate-resources") for (const ship of state.ships) {
      if (strategy.assignments[ship.vesselId] === action.portId && hasCriticalCargo(ship)) affected.add(ship.vesselId);
    }
  }
  return [...affected];
}

function modelSummary(state: SimulationState, strategies: RecoveryStrategy[], outcomes: Map<string, SimulationSummary>) {
  return {
    scenarioId: state.scenarioId,
    startAt: state.startAt,
    ports: state.ports.map((port) => ({
      portId: port.portId, location: port.location.name,
      currentCapacityContainersPerDay: port.currentCapacityContainersPerDay,
      normalCapacityContainersPerDay: port.normalCapacityContainersPerDay,
      availableBerths: port.availableBerths, unloadingResources: port.unloadingResources,
      queueShipIds: port.queueShipIds,
      activeDisruptions: port.activeDisruptions,
    })),
    ships: state.ships.map((ship) => ({
      vesselId: ship.vesselId, position: ship.position, heading: ship.heading, speedKnots: ship.speedKnots,
      estimatedArrival: ship.estimatedArrival, destinationPortId: ship.destinationPortId,
      cargo: ship.cargo.map(({ cargoId, category, containers, essential, deadline, specialHandling }) => ({ cargoId, category, containers, essential, deadline, specialHandling })),
    })),
    weather: state.weather.map((item) => ({ portId: item.portId, forecasts: item.forecasts, alerts: item.alerts })),
    risks: reviewIndicators(state),
    dataProvenance: state.provenance,
    feasibleStrategies: strategies.map((strategy) => ({
      id: strategy.id, name: strategy.name, summary: strategy.summary, actions: strategy.actions,
      simulatedOutcome: outcomes.get(strategy.id)?.mean ?? null,
      probabilityOfMeetingTarget: outcomes.get(strategy.id)?.probabilityOfMeetingTarget ?? null,
    })),
  };
}

const probabilityRecord = (value: object) => Object.fromEntries(Object.entries(value)) as Record<string, number>;
const legendRecord = (value: object) => Object.fromEntries(Object.entries(value)) as Record<string, string>;
const hasCriticalCargo = (ship: SimulationState["ships"][number]) => ship.cargo.some((cargo) => cargo.essential);

export const callJev: JevCall = async (state, strategies, outcomes) => {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not configured.");
  const available = Object.fromEntries(strategies.map((strategy) => [strategy.id, strategy.name + ": " + strategy.summary]));
  const client = new TypeSafeClient({ logLevel: "error", timeout: 10_000, retry: { maxRetries: 0 } });
  const response = await client.systemOne({
    state: JSON.parse(JSON.stringify(modelSummary(state, strategies, outcomes))) as Record<string, JsonValue>,
    questions: {
      selection: choice("Select the best feasible recovery strategy by its exact ID. Use only the listed candidates and their simulated outcomes.", available),
      cargoUrgency: score("Score cargo urgency from 0 to 3 using the ordered rubric. Consider essential classification, explicit deadlines, and estimated consequences of delay.", CARGO_URGENCY_RUBRIC),
      operationalRisk: score("Score operational risk from 0 to 3 using the ordered rubric. Consider capacity constraints, weather, active disruptions, and simulated outcome likelihoods.", OPERATIONAL_RISK_RUBRIC),
      humanReview: noul("Should a human port operator review this recommendation before any operational decision is approved?"),
      timeCritical: noul("Is the scenario's essential cargo time-critical based on its explicit deadlines and consequences of delay?"),
    },
  }, { timeout: 10_000, retry: { maxRetries: 0 } });
  const { selection, cargoUrgency, operationalRisk, humanReview, timeCritical } = response.answers;
  return {
    model: response.model,
    selection: { choice: selection.choice, confidence: selection.confidence, probabilities: probabilityRecord(selection.probabilities) },
    cargoUrgency: { score: cargoUrgency.score, confidence: cargoUrgency.confidence, probabilities: probabilityRecord(cargoUrgency.probabilities), legend: legendRecord(cargoUrgency.legend) },
    operationalRisk: { score: operationalRisk.score, confidence: operationalRisk.confidence, probabilities: probabilityRecord(operationalRisk.probabilities), legend: legendRecord(operationalRisk.legend) },
    humanReview: humanReview.noul,
    timeCritical: timeCritical.noul,
  };
};

function validateJevReply(reply: JevReply, strategies: RecoveryStrategy[]): JevAssessment {
  const validProbability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  const candidates = new Set(strategies.map((strategy) => strategy.id));
  if (!reply.model || typeof reply.model !== "string") throw new Error("Jev returned invalid model metadata.");
  if (!candidates.has(reply.selection.choice)) throw new Error("Jev selected an ID outside the feasible candidate set.");
  const choiceProbabilities = reply.selection.probabilities;
  if (!validProbability(reply.selection.confidence) || Object.keys(choiceProbabilities).length !== candidates.size || !Object.entries(choiceProbabilities).every(([id, value]) => candidates.has(id) && validProbability(value))) throw new Error("Jev returned invalid strategy confidence or probabilities.");
  const validScore = (value: JevReply["operationalRisk"]) => Number.isFinite(value.score) && value.score >= 0 && value.score <= 3 && validProbability(value.confidence) && Object.values(value.probabilities).length >= 2 && Object.values(value.probabilities).every(validProbability) && Object.values(value.legend).every((label) => typeof label === "string");
  if (!validScore(reply.operationalRisk) || !validScore(reply.cargoUrgency)) throw new Error("Jev returned an invalid qualitative score.");
  if (!validProbability(reply.humanReview) || !validProbability(reply.timeCritical)) throw new Error("Jev returned an invalid Noul probability.");
  return {
    model: reply.model,
    selection: { strategyId: reply.selection.choice, confidence: reply.selection.confidence, probabilities: reply.selection.probabilities },
    cargoUrgency: reply.cargoUrgency,
    operationalRisk: reply.operationalRisk,
    humanReviewProbability: reply.humanReview,
    timeCriticalProbability: reply.timeCritical,
  };
}

function mockReply(strategies: RecoveryStrategy[], outcomes: Map<string, SimulationSummary>, state: SimulationState): JevReply {
  const best = [...strategies].sort((left, right) => {
    const a = outcomes.get(left.id)!.mean;
    const b = outcomes.get(right.id)!.mean;
    return outcomes.get(right.id)!.probabilityOfMeetingTarget - outcomes.get(left.id)!.probabilityOfMeetingTarget
      || b.criticalCargoOnTimePercent - a.criticalCargoOnTimePercent
      || (a.estimatedDelayCost ?? 0) - (b.estimatedDelayCost ?? 0);
  })[0];
  const probabilities = Object.fromEntries(strategies.map((strategy) => [strategy.id, strategy.id === best.id ? 0.9 : 0.1 / Math.max(1, strategies.length - 1)]));
  return {
    model: "mock-jev",
    selection: { choice: best.id, confidence: 0.9, probabilities },
    cargoUrgency: { score: state.ships.some((ship) => ship.cargo.some((cargo) => cargo.essential)) ? 3 : 1, confidence: 0.8, probabilities: { "0": 0.05, "1": 0.1, "2": 0.25, "3": 0.6 }, legend: { "0": "Low cargo urgency", "1": "Moderate cargo urgency", "2": "High cargo urgency", "3": "Severe cargo urgency" } },
    operationalRisk: { score: 2, confidence: 0.8, probabilities: { "0": 0.05, "1": 0.2, "2": 0.55, "3": 0.2 }, legend: { "0": "Low operational risk", "1": "Moderate operational risk", "2": "High operational risk", "3": "Severe operational risk" } },
    humanReview: 0.9,
    timeCritical: state.ships.some((ship) => ship.cargo.some((cargo) => cargo.essential)) ? 0.9 : 0.1,
  };
}

export async function createRecommendation(
  state: SimulationState,
  partialOptions: Partial<SimulationOptions> = {},
  jevCall: JevCall = callJev,
): Promise<{ recommendation: Recommendation; strategies: RecoveryStrategy[]; evaluatedStrategies: Array<{ strategy: RecoveryStrategy; outcome: SimulationSummary; affectedShips: string[]; affectedCargo: string[] }> }> {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const strategies = generateStrategies(state, options.horizonHours);
  if (!strategies.length) throw new Error("No feasible recovery strategy exists for this state.");
  assertSimulationBudget(state, options, strategies.length);
  const outcomes = new Map(strategies.map((strategy) => [strategy.id, simulateStrategy(state, strategy, options)]));
  const baselineStrategy = strategies.find((strategy) => strategy.id === "baseline-arrival-order");
  if (!baselineStrategy) throw new Error("The deterministic baseline strategy could not be generated.");

  let assessment: JevAssessment | null = null;
  let decisionSource: Recommendation["decisionSource"] = "jev";
  let fallbackReason: string | undefined;
  const warnings = reviewIndicators(state);
  if ([...Object.values(state.provenance)].some((source) => source === "synthetic" || source === "mixed")) warnings.push("Some simulation inputs are synthetic or combine sources; review provenance before relying on the recommendation.");
  if (state.weather.length) warnings.push("Forecast weather adjustments and sampled capacity reductions are applied on top of the supplied current capacity; confirm the input capacity does not already include those future impacts.");
  warnings.push("Each vessel manifest is modeled as one unloading job; all cargo aboard is treated as delivered when that vessel's unloading completes.");
  if (state.ships.some((ship) => ship.cargo.some((cargo) => cargo.delayCostPerContainerHour !== undefined)) && state.ships.some((ship) => ship.cargo.some((cargo) => cargo.delayCostPerContainerHour === undefined))) warnings.push("Estimated delay cost is omitted because cost inputs are incomplete for some cargo.");
  let selectedStrategyId = baselineStrategy.id;
  const useMock = process.env.JEV_MOCK === "true" && process.env.NODE_ENV !== "production";
  try {
    const reply = useMock ? mockReply(strategies, outcomes, state) : await jevCall(state, strategies, outcomes);
    assessment = validateJevReply(reply, strategies);
    selectedStrategyId = assessment.selection.strategyId;
    if (useMock) {
      decisionSource = "mock";
      warnings.push("JEV_MOCK=true: the selection is a local mock, not a Jev model response.");
    }
  } catch (error) {
    decisionSource = "fallback";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const safeDecisionError = error instanceof Error && (error.message.startsWith("Jev selected an ID") || error.message.startsWith("Jev returned invalid"));
    const detail = error instanceof Error && error.message === "TYPESAFE_API_KEY is not configured." ? error.message
      : safeDecisionError ? error.message : `Jev decision failed (${errorName}).`;
    fallbackReason = detail;
    warnings.push(`${detail} The deterministic arrival-order baseline was selected.`);
  }

  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId)!;
  const selected = outcomes.get(selectedStrategyId)!;
  const baseline = outcomes.get(baselineStrategy.id)!;
  const changedShips = affectedShipsForStrategy(state, selectedStrategy, baselineStrategy);
  const affectedCargo = state.ships.filter((ship) => changedShips.includes(ship.vesselId)).flatMap((ship) => ship.cargo.map((cargo) => cargo.cargoId));
  const riskIndicators = reviewIndicators(state);
  const recommendation: Recommendation = {
    scenarioId: state.scenarioId,
    generatedAt: new Date().toISOString(),
    selectedStrategyId,
    recommendationSummary: `${selectedStrategy.name}: ${selectedStrategy.summary}`,
    actions: selectedStrategy.actions,
    affectedShips: changedShips,
    affectedCargo,
    estimatedOutcomes: selected,
    baselineComparison: {
      baselineStrategyId: baselineStrategy.id, baseline, selected,
      criticalCargoOnTimeChangePercent: Math.round((selected.mean.criticalCargoOnTimePercent - baseline.mean.criticalCargoOnTimePercent) * 100) / 100,
    },
    jev: assessment,
    aiGenerated: decisionSource === "jev",
    decisionSource,
    ...(fallbackReason ? { fallbackReason } : {}),
    simulatedOutcomeLikelihoods: { probabilityOfMeetingTarget: selected.probabilityOfMeetingTarget, runs: selected.runs, seed: selected.seed },
    riskIndicators,
    humanReviewRecommended: assessment ? assessment.humanReviewProbability >= 0.5 : true,
    humanApprovalRequired: true,
    dataProvenance: state.provenance,
    warnings: [...new Set(warnings)],
  };
  const evaluatedStrategies = strategies.map((strategy) => {
    const affectedShips = affectedShipsForStrategy(state, strategy, baselineStrategy);
    return {
      strategy,
      outcome: outcomes.get(strategy.id)!,
      affectedShips,
      affectedCargo: state.ships.filter((ship) => affectedShips.includes(ship.vesselId)).flatMap((ship) => ship.cargo.map((cargo) => cargo.cargoId)),
    };
  });
  return { recommendation, strategies, evaluatedStrategies };
}

export function validateStrategySelection(strategyId: unknown, strategies: RecoveryStrategy[]): RecoveryStrategy | undefined {
  return typeof strategyId === "string" ? strategies.find((strategy) => strategy.id === strategyId) : undefined;
}
