import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { DecisionCriteria, JevAssessment, RecoveryPlan, RecoveryStrategy, SimulationOptions, SimulationState, SimulationSummary, Recommendation } from "./types.ts";
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
const round = (value: number) => Math.round(value * 100) / 100;

function recoveryPlan(strategy: RecoveryStrategy): RecoveryPlan {
  return {
    scheduling: strategy.scheduling,
    stagingWindowsByVessel: strategy.stagingWindowsByVessel,
    cargoPrioritiesByBatch: strategy.cargoPrioritiesByBatch,
    reserveBerthForCriticalCargo: strategy.reserveBerthForCriticalCargo,
    criticalCapacityReservation: strategy.criticalCapacityReservation,
    assignments: strategy.assignments,
    objective: strategy.objective,
    minimumCriticalCargoOnTimePercent: strategy.minimumCriticalCargoOnTimePercent,
    maximumDisruptionCost: strategy.maximumDisruptionCost,
  };
}

export type JevReply = {
  model: string;
  selection: { choice: string; confidence: number; probabilities: Record<string, number> };
  cargoUrgency: { score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
  operationalRisk: { score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
  humanReview: number;
  timeCritical: number;
};

export type JevCall = (state: SimulationState, strategies: RecoveryStrategy[], outcomes: Map<string, SimulationSummary>, criteria: DecisionCriteria, targetPercent: number, selectableIds: string[]) => Promise<JevReply>;
export type StrategyOutcomeEvaluator = (strategies: RecoveryStrategy[]) => Map<string, SimulationSummary>;

export function assessAdaptivePlanQuality(
  proposed: SimulationSummary,
  continuation: SimulationSummary,
  criteria: DecisionCriteria,
  targetPercent: number,
): { applyProposed: boolean; status: "accepted" | "rejected-constraints" | "rejected-dominated" | "equivalent"; explanation: string } {
  const a = proposed.mean;
  const b = continuation.mean;
  const violatesTarget = a.criticalCargoOnTimePercent < targetPercent;
  const violatesCost = criteria.maximumDisruptionCost !== undefined
    && (a.estimatedDisruptionCost === null || a.estimatedDisruptionCost > criteria.maximumDisruptionCost);
  if (violatesTarget || violatesCost) {
    const constraints = [violatesTarget && `the ${targetPercent}% critical-delivery target`, violatesCost && `the $${criteria.maximumDisruptionCost} cost ceiling`].filter(Boolean).join(" and ");
    const continuationMeets = b.criticalCargoOnTimePercent >= targetPercent
      && (criteria.maximumDisruptionCost === undefined || b.estimatedDisruptionCost !== null && b.estimatedDisruptionCost <= criteria.maximumDisruptionCost);
    return {
      applyProposed: false,
      status: "rejected-constraints",
      explanation: `Rejected Jev's plan because it violates ${constraints}; ${continuationMeets ? "the current plan meets the mandatory constraints, so it continues" : "the current plan continues because no compliant alternative was established"}.`,
    };
  }

  const costComparable = a.estimatedDisruptionCost !== null && b.estimatedDisruptionCost !== null;
  const costNoWorse = costComparable && b.estimatedDisruptionCost! <= a.estimatedDisruptionCost! + 0.01;
  const noWorse = b.criticalCargoOnTimePercent >= a.criticalCargoOnTimePercent - 0.01
    && b.averageCargoDelayHours <= a.averageCargoDelayHours + 0.01
    && b.totalContainersProcessed >= a.totalContainersProcessed - 0.01
    && b.delayedVessels <= a.delayedVessels
    && continuation.probabilityOfMeetingTarget >= proposed.probabilityOfMeetingTarget - 0.01
    && costComparable && costNoWorse;
  const strictlyBetter = b.criticalCargoOnTimePercent > a.criticalCargoOnTimePercent + 0.01
    || b.averageCargoDelayHours < a.averageCargoDelayHours - 0.01
    || b.totalContainersProcessed > a.totalContainersProcessed + 0.01
    || b.delayedVessels < a.delayedVessels
    || continuation.probabilityOfMeetingTarget > proposed.probabilityOfMeetingTarget + 0.01
    || costComparable && b.estimatedDisruptionCost! < a.estimatedDisruptionCost! - 0.01;
  if (noWorse && strictlyBetter) {
    return { applyProposed: false, status: "rejected-dominated", explanation: "Rejected Jev's plan because continuing the current plan is no worse across measured delivery, delay, vessel delays, throughput, success likelihood, and cost, and improves at least one." };
  }

  const sameCost = a.estimatedDisruptionCost === null && b.estimatedDisruptionCost === null
    || costComparable && Math.abs(a.estimatedDisruptionCost! - b.estimatedDisruptionCost!) <= 0.01;
  if (Math.abs(a.criticalCargoOnTimePercent - b.criticalCargoOnTimePercent) <= 0.01
    && Math.abs(a.averageCargoDelayHours - b.averageCargoDelayHours) <= 0.01
    && Math.abs(a.totalContainersProcessed - b.totalContainersProcessed) <= 0.01
    && a.delayedVessels === b.delayedVessels
    && Math.abs(proposed.probabilityOfMeetingTarget - continuation.probabilityOfMeetingTarget) <= 0.01 && sameCost) {
    return { applyProposed: false, status: "equivalent", explanation: "The plans have equivalent measured outcomes, so the current plan continues without an unnecessary operational change." };
  }
  return { applyProposed: true, status: "accepted", explanation: "Accepted Jev's plan: it meets the mandatory constraints and is not strictly dominated by continuing the current plan." };
}

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
    if (action.type === "reroute") affected.add(action.vesselId);
    if (action.type === "cargo-priority") {
      const ship = state.ships.find((item) => item.cargo.some((cargo) => cargo.cargoId === action.cargoId));
      if (ship) affected.add(ship.vesselId);
    }
    if (action.type === "reserve-throughput") for (const ship of state.ships) {
      if (strategy.assignments[ship.vesselId] && hasCriticalCargo(ship)) affected.add(ship.vesselId);
    }
    if (action.type === "allocate-resources") for (const ship of state.ships) {
      if (strategy.assignments[ship.vesselId] === action.portId && hasCriticalCargo(ship)) affected.add(ship.vesselId);
    }
  }
  return [...affected];
}

function modelSummary(state: SimulationState, strategies: RecoveryStrategy[], outcomes: Map<string, SimulationSummary>, criteria: DecisionCriteria, targetPercent: number, selectableIds: string[]) {
  return {
    scenarioId: state.scenarioId,
    startAt: state.startAt,
    ports: state.ports.map((port) => ({
      portId: port.portId, location: port.location.name,
      currentCapacityContainersPerDay: port.currentCapacityContainersPerDay,
      normalCapacityContainersPerDay: port.normalCapacityContainersPerDay,
      availableBerths: port.availableBerths, unloadingResources: port.unloadingResources,
      rerouteCostPerContainer: port.rerouteCostPerContainer ?? null,
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
    operatorObjective: {
      objective: criteria.objective,
      minimumCriticalCargoOnTimePercent: targetPercent,
      maximumDisruptionCost: criteria.maximumDisruptionCost ?? null,
      selectionRule: "If one or more candidates satisfy all objective constraints, select among those candidates; otherwise choose the best available and report the unmet constraints.",
    },
    selectableStrategyIds: selectableIds,
    feasibleStrategies: strategies.map((strategy) => {
      const outcome = outcomes.get(strategy.id);
      const cost = outcome?.mean.estimatedDisruptionCost;
      return {
        id: strategy.id, name: strategy.name, summary: strategy.summary, operationalActions: strategy.actions,
        plan: recoveryPlan(strategy),
        metrics: outcome?.mean ?? null,
        estimatedTargetSuccessProbability: outcome?.probabilityOfMeetingTarget ?? null,
        selectionEligible: selectableIds.includes(strategy.id),
        constraints: {
          feasible: true,
          criticalDeliveryTarget: outcome ? outcome.mean.criticalCargoOnTimePercent >= targetPercent : false,
          costLimit: criteria.maximumDisruptionCost === undefined ? null : cost === null || cost === undefined ? false : cost <= criteria.maximumDisruptionCost,
          capacity: state.ports.filter((port) => state.ships.some((ship) => strategy.assignments[ship.vesselId] === port.portId)).map((port) => ({
            portId: port.portId,
            assignedVesselIds: state.ships.filter((ship) => strategy.assignments[ship.vesselId] === port.portId).map((ship) => ship.vesselId),
            assignedContainers: state.ships.filter((ship) => strategy.assignments[ship.vesselId] === port.portId).reduce((sum, ship) => sum + ship.cargo.reduce((cargoSum, cargo) => cargoSum + cargo.containers, 0), 0),
            availableBerths: port.availableBerths,
            unloadingResources: port.unloadingResources,
            currentCapacityContainersPerDay: port.currentCapacityContainersPerDay,
            rerouteCostPerContainer: port.rerouteCostPerContainer ?? null,
            activeDisruptions: port.activeDisruptions,
          })),
        },
        uncertainty: outcome ? { monteCarloRuns: outcome.runs, seed: outcome.seed, targetSuccessProbability: outcome.probabilityOfMeetingTarget } : null,
      };
    }),
  };
}

const probabilityRecord = (value: object) => Object.fromEntries(Object.entries(value)) as Record<string, number>;
const legendRecord = (value: object) => Object.fromEntries(Object.entries(value)) as Record<string, string>;
const hasCriticalCargo = (ship: SimulationState["ships"][number]) => ship.cargo.some((cargo) => cargo.essential);

export const callJev: JevCall = async (state, strategies, outcomes, criteria, targetPercent, selectableIds) => {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not configured.");
  const orderedStrategies = [...strategies].sort((left, right) => left.id.localeCompare(right.id));
  const orderedSelectableIds = [...selectableIds].sort();
  const available = Object.fromEntries(orderedStrategies.filter((strategy) => orderedSelectableIds.includes(strategy.id)).map((strategy) => [strategy.id, strategy.name + ": " + strategy.summary]));
  const client = new TypeSafeClient({ logLevel: "error", timeout: 10_000, retry: { maxRetries: 0 } });
  const response = await client.systemOne({
    state: JSON.parse(JSON.stringify(modelSummary(state, orderedStrategies, outcomes, criteria, targetPercent, orderedSelectableIds))) as Record<string, JsonValue>,
    questions: {
      selection: choice(`Select the feasible recovery strategy best matched to the operator objective "${criteria.objective}". The list order carries no preference; compare the simulated outcomes. Choose only an ID listed in selectableStrategyIds; candidates marked selectionEligible=false are not selectable. Respect the critical-delivery target of ${targetPercent}%${criteria.maximumDisruptionCost === undefined ? "" : ` and the disruption-cost limit of $${criteria.maximumDisruptionCost}`}. A cost objective should prefer the cheaper plan when it satisfies the delivery target.`, available),
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
  const normalized = (values: number[]) => values.length > 0 && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.01;
  const candidates = new Set(strategies.map((strategy) => strategy.id));
  if (!reply.model || typeof reply.model !== "string") throw new Error("Jev returned invalid model metadata.");
  if (!candidates.has(reply.selection.choice)) throw new Error("Jev selected an ID outside the feasible candidate set.");
  const choiceProbabilities = reply.selection.probabilities;
  if (!validProbability(reply.selection.confidence) || Object.keys(choiceProbabilities).length !== candidates.size || !Object.entries(choiceProbabilities).every(([id, value]) => candidates.has(id) && validProbability(value)) || !normalized(Object.values(choiceProbabilities))) throw new Error("Jev returned invalid strategy confidence or probabilities.");
  const validScore = (value: JevReply["operationalRisk"]) => Number.isFinite(value.score) && value.score >= 0 && value.score <= 3 && validProbability(value.confidence) && Object.values(value.probabilities).length >= 2 && Object.values(value.probabilities).every(validProbability) && normalized(Object.values(value.probabilities)) && Object.values(value.legend).every((label) => typeof label === "string");
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

function compareOutcomes(left: SimulationSummary, right: SimulationSummary, objective: DecisionCriteria["objective"]): number {
  const a = left.mean;
  const b = right.mean;
  const delay = a.averageCargoDelayHours - b.averageCargoDelayHours;
  const cost = a.estimatedDisruptionCost === null ? b.estimatedDisruptionCost === null ? 0 : 1
    : b.estimatedDisruptionCost === null ? -1 : a.estimatedDisruptionCost - b.estimatedDisruptionCost;
  const critical = b.criticalCargoOnTimePercent - a.criticalCargoOnTimePercent;
  const success = right.probabilityOfMeetingTarget - left.probabilityOfMeetingTarget;
  if (objective === "critical-delivery") return critical || success || delay || cost;
  if (objective === "minimize-delay") return delay || critical || success || cost;
  if (objective === "minimize-cost") return cost || success || critical || delay;
  return success || critical || delay || cost;
}

function decisionExplanation(strategy: RecoveryStrategy, outcome: SimulationSummary, baseline: SimulationSummary, criteria: DecisionCriteria, targetPercent: number): string {
  const metrics = outcome.mean;
  const criticalChange = round(metrics.criticalCargoOnTimePercent - baseline.mean.criticalCargoOnTimePercent);
  const delayChange = round(metrics.averageCargoDelayHours - baseline.mean.averageCargoDelayHours);
  const cost = metrics.estimatedDisruptionCost === null ? "cost unavailable" : `modeled disruption cost $${round(metrics.estimatedDisruptionCost)}`;
  const delivery = `${metrics.criticalCargoOnTimePercent.toFixed(1)}% critical cargo on time (${criticalChange >= 0 ? "+" : ""}${criticalChange.toFixed(1)} pp vs baseline)`;
  const delay = `${metrics.averageCargoDelayHours.toFixed(1)}h average container delay (${delayChange >= 0 ? "+" : ""}${delayChange.toFixed(1)}h vs baseline)`;
  const objective = criteria.objective === "critical-delivery" ? "critical cargo delivery" : criteria.objective === "minimize-delay" ? "average container delay" : criteria.objective === "minimize-cost" ? "modeled disruption cost" : "balanced recovery";
  const constraint = metrics.criticalCargoOnTimePercent >= targetPercent ? `meets the ${targetPercent}% critical-delivery target` : `misses the ${targetPercent}% critical-delivery target`;
  const costConstraint = criteria.maximumDisruptionCost === undefined ? "" : metrics.estimatedDisruptionCost === null ? "; cost ceiling cannot be checked" : metrics.estimatedDisruptionCost <= criteria.maximumDisruptionCost ? ` and stays within the $${criteria.maximumDisruptionCost} cost ceiling` : ` and exceeds the $${criteria.maximumDisruptionCost} cost ceiling`;
  return `Selected for ${objective}. Simulation outcome: ${delivery}, ${delay}, and ${cost}; it ${constraint}${costConstraint}. ${strategy.actions.length} modeled operational actions.`;
}

function mockReply(strategies: RecoveryStrategy[], outcomes: Map<string, SimulationSummary>, state: SimulationState, objective: DecisionCriteria["objective"]): JevReply {
  const best = [...strategies].sort((left, right) => {
    return compareOutcomes(outcomes.get(left.id)!, outcomes.get(right.id)!, objective) || left.id.localeCompare(right.id);
  })[0];
  const probabilities = Object.fromEntries(strategies.map((strategy) => [strategy.id, strategies.length === 1 ? 1 : strategy.id === best.id ? 0.9 : 0.1 / (strategies.length - 1)]));
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
  criteria: DecisionCriteria = { objective: "balanced" },
  evaluateStrategies?: StrategyOutcomeEvaluator,
  additionalCandidates: RecoveryStrategy[] = [],
  selectAllCandidates = false,
): Promise<{ recommendation: Recommendation; strategies: RecoveryStrategy[]; evaluatedStrategies: Array<{ strategy: RecoveryStrategy; outcome: SimulationSummary; affectedShips: string[]; affectedCargo: string[] }> }> {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const baseStrategies = generateStrategies(state, options.horizonHours, criteria, options.criticalCargoOnTimeTargetPercent);
  if (additionalCandidates.some((candidate) => baseStrategies.some((strategy) => strategy.id === candidate.id))
    || new Set(additionalCandidates.map((candidate) => candidate.id)).size !== additionalCandidates.length) {
    throw new Error("Additional recovery candidates must have unique IDs outside the generated candidate set.");
  }
  const generated = [...baseStrategies, ...additionalCandidates];
  if (!generated.length) throw new Error("No feasible recovery strategy exists for this state.");
  assertSimulationBudget(state, options, generated.length);
  const generatedOutcomes = evaluateStrategies?.(generated) ?? new Map(generated.map((strategy) => [strategy.id, simulateStrategy(state, strategy, options)]));
  const baselineStrategy = generated.find((strategy) => strategy.id === "baseline-arrival-order");
  if (!baselineStrategy) throw new Error("The deterministic baseline strategy could not be generated.");
  const protectedIds = new Set(additionalCandidates.map((strategy) => strategy.id));
  const outcomeFingerprint = (strategy: RecoveryStrategy) => JSON.stringify({
    mean: generatedOutcomes.get(strategy.id)!.mean,
    probabilityOfMeetingTarget: generatedOutcomes.get(strategy.id)!.probabilityOfMeetingTarget,
  });
  const unique = [baselineStrategy, ...generated.filter((strategy) => strategy.id !== baselineStrategy.id)]
    .filter((strategy, index, all) => protectedIds.has(strategy.id) || all.findIndex((other) => outcomeFingerprint(other) === outcomeFingerprint(strategy)) === index);
  const dominates = (left: RecoveryStrategy, right: RecoveryStrategy) => {
    const a = generatedOutcomes.get(left.id)!.mean;
    const b = generatedOutcomes.get(right.id)!.mean;
    const costNoWorse = a.estimatedDisruptionCost === null ? b.estimatedDisruptionCost === null : b.estimatedDisruptionCost === null || a.estimatedDisruptionCost <= b.estimatedDisruptionCost;
    const costBetter = a.estimatedDisruptionCost !== null && (b.estimatedDisruptionCost === null || a.estimatedDisruptionCost < b.estimatedDisruptionCost);
    const noWorse = a.criticalCargoOnTimePercent >= b.criticalCargoOnTimePercent
      && a.averageCargoDelayHours <= b.averageCargoDelayHours
      && a.totalContainersProcessed >= b.totalContainersProcessed
      && costNoWorse
      && generatedOutcomes.get(left.id)!.probabilityOfMeetingTarget >= generatedOutcomes.get(right.id)!.probabilityOfMeetingTarget;
    const better = a.criticalCargoOnTimePercent > b.criticalCargoOnTimePercent
      || a.averageCargoDelayHours < b.averageCargoDelayHours
      || a.totalContainersProcessed > b.totalContainersProcessed
      || costBetter
      || generatedOutcomes.get(left.id)!.probabilityOfMeetingTarget > generatedOutcomes.get(right.id)!.probabilityOfMeetingTarget;
    return noWorse && better;
  };
  const pareto = unique.filter((candidate) => candidate.id === baselineStrategy.id || protectedIds.has(candidate.id) || !unique.some((other) => other.id !== candidate.id && dominates(other, candidate)));
  const generatedMeetsConstraints = (strategy: RecoveryStrategy) => {
    const outcome = generatedOutcomes.get(strategy.id)!;
    return outcome.mean.criticalCargoOnTimePercent >= options.criticalCargoOnTimeTargetPercent
      && (criteria.maximumDisruptionCost === undefined || outcome.mean.estimatedDisruptionCost !== null && outcome.mean.estimatedDisruptionCost <= criteria.maximumDisruptionCost);
  };
  const violation = (strategy: RecoveryStrategy) => {
    const outcome = generatedOutcomes.get(strategy.id)!;
    const criticalShortfall = Math.max(0, options.criticalCargoOnTimeTargetPercent - outcome.mean.criticalCargoOnTimePercent) / 100;
    const costOverrun = criteria.maximumDisruptionCost === undefined ? 0
      : outcome.mean.estimatedDisruptionCost === null ? 1
        : Math.max(0, outcome.mean.estimatedDisruptionCost - criteria.maximumDisruptionCost) / Math.max(1, criteria.maximumDisruptionCost);
    return criticalShortfall + costOverrun;
  };
  const rankedPareto = pareto.filter((candidate) => candidate.id !== baselineStrategy.id)
    .sort((left, right) => compareOutcomes(generatedOutcomes.get(left.id)!, generatedOutcomes.get(right.id)!, criteria.objective) || left.id.localeCompare(right.id));
  const compliant = rankedPareto.filter(generatedMeetsConstraints);
  const minimumParetoViolation = Math.min(...rankedPareto.map(violation));
  const preferred = compliant.length ? compliant : rankedPareto.filter((candidate) => violation(candidate) === minimumParetoViolation);
  // shortcut: send at most 16 non-duplicate Pareto alternatives to Jev to keep the prompt bounded.
  const strategies = [baselineStrategy, ...additionalCandidates, ...preferred, ...rankedPareto.filter((candidate) => !preferred.includes(candidate))]
    .filter((strategy, index, all) => all.findIndex((item) => item.id === strategy.id) === index).slice(0, 16);
  const outcomes = new Map(strategies.map((strategy) => [strategy.id, generatedOutcomes.get(strategy.id)!]));
  const meetsConstraints = (strategy: RecoveryStrategy) => {
    const outcome = outcomes.get(strategy.id)!;
    return outcome.mean.criticalCargoOnTimePercent >= options.criticalCargoOnTimeTargetPercent
      && (criteria.maximumDisruptionCost === undefined || outcome.mean.estimatedDisruptionCost !== null && outcome.mean.estimatedDisruptionCost <= criteria.maximumDisruptionCost);
  };
  const constraintCandidates = strategies.filter(meetsConstraints);
  const constraintViolation = (strategy: RecoveryStrategy) => {
    const outcome = outcomes.get(strategy.id)!;
    const criticalShortfall = Math.max(0, options.criticalCargoOnTimeTargetPercent - outcome.mean.criticalCargoOnTimePercent) / 100;
    const costOverrun = criteria.maximumDisruptionCost === undefined ? 0
      : outcome.mean.estimatedDisruptionCost === null ? 1
        : Math.max(0, outcome.mean.estimatedDisruptionCost - criteria.maximumDisruptionCost) / Math.max(1, criteria.maximumDisruptionCost);
    return criticalShortfall + costOverrun;
  };
  const minimumViolation = Math.min(...strategies.map(constraintViolation));
  const selectableStrategies = selectAllCandidates ? strategies : constraintCandidates.length ? constraintCandidates
    : strategies.filter((strategy) => constraintViolation(strategy) === minimumViolation);
  const selectableIds = selectableStrategies.map((strategy) => strategy.id);

  let assessment: JevAssessment | null = null;
  let decisionSource: Recommendation["decisionSource"] = "jev";
  let fallbackReason: string | undefined;
  let safeguardExplanation: string | undefined;
  const warnings = reviewIndicators(state);
  if ([...Object.values(state.provenance)].some((source) => source === "synthetic" || source === "mixed")) warnings.push("Some simulation inputs are synthetic or combine sources; review provenance before relying on the recommendation.");
  if (state.weather.length) warnings.push("Forecast weather adjustments and sampled capacity reductions are applied on top of the supplied current capacity; confirm the input capacity does not already include those future impacts.");
  if (state.ships.some((ship) => ship.cargo.some((cargo) => cargo.delayCostPerContainerHour === undefined))) warnings.push("Total disruption cost is unavailable or incomplete because cargo delay-cost inputs are missing.");
  if (generated.some((strategy) => strategy.actions.some((action) => action.type === "reroute"))
    && state.ports.some((port) => generated.some((strategy) => state.ships.some((ship) => strategy.assignments[ship.vesselId] === port.portId && ship.destinationPortId !== port.portId)) && port.rerouteCostPerContainer === undefined)) {
    warnings.push("Some feasible reroutes have no modeled alternate-port charge; their total disruption cost is unavailable and they cannot satisfy a configured cost limit.");
  }
  let selectedStrategyId = baselineStrategy.id;
  const useMock = process.env.JEV_MOCK === "true" && process.env.NODE_ENV !== "production";
  try {
    const reply = useMock ? mockReply(selectableStrategies, outcomes, state, criteria.objective) : await jevCall(state, strategies, outcomes, criteria, options.criticalCargoOnTimeTargetPercent, selectableIds);
    assessment = validateJevReply(reply, selectableStrategies);
    selectedStrategyId = assessment.selection.strategyId;
    if (useMock) {
      decisionSource = "mock";
      warnings.push("JEV_MOCK=true: the selection is a local mock, not a Jev model response.");
    }
  } catch (error) {
    decisionSource = "fallback";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const safeDecisionError = error instanceof Error && (error.message.startsWith("Jev selected an ID") || error.message.startsWith("Jev returned"));
    const detail = error instanceof Error && error.message === "TYPESAFE_API_KEY is not configured." ? error.message
      : safeDecisionError ? error.message : `Jev decision failed (${errorName}).`;
    fallbackReason = detail;
    warnings.push(`${detail} The deterministic arrival-order baseline was selected.`);
  }

  const proposedStrategy = generated.find((strategy) => strategy.id === selectedStrategyId)!;
  if (decisionSource !== "fallback" && proposedStrategy.id !== baselineStrategy.id && meetsConstraints(proposedStrategy)) {
    const quality = assessAdaptivePlanQuality(outcomes.get(proposedStrategy.id)!, outcomes.get(baselineStrategy.id)!, criteria, options.criticalCargoOnTimeTargetPercent);
    if (!quality.applyProposed && (quality.status === "equivalent" || quality.status === "rejected-dominated")) {
      selectedStrategyId = baselineStrategy.id;
      safeguardExplanation = quality.status === "equivalent"
        ? `Jev selected ${proposedStrategy.name}, but the plans have equivalent measured outcomes, so the no-intervention baseline was retained.`
        : `Jev selected ${proposedStrategy.name}, but the no-intervention baseline is no worse across measured outcomes and improves at least one, so the no-intervention baseline was retained.`;
      warnings.push(safeguardExplanation);
    }
  }

  const selectedStrategy = generated.find((strategy) => strategy.id === selectedStrategyId)!;
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
    decisionExplanation: safeguardExplanation ?? decisionExplanation(selectedStrategy, selected, baseline, criteria, options.criticalCargoOnTimeTargetPercent),
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
    decisionAudit: {
      objective: criteria.objective,
      minimumCriticalCargoOnTimePercent: options.criticalCargoOnTimeTargetPercent,
      maximumDisruptionCost: criteria.maximumDisruptionCost ?? null,
      selectedStrategyId,
      fallback: decisionSource === "fallback",
      candidates: strategies.map((strategy) => ({
        strategyId: strategy.id,
        name: strategy.name,
        plan: recoveryPlan(strategy),
        actions: strategy.actions,
        metrics: outcomes.get(strategy.id)!.mean,
        probabilityOfMeetingTarget: outcomes.get(strategy.id)!.probabilityOfMeetingTarget,
        meetsConstraints: meetsConstraints(strategy),
        selectionEligible: selectableIds.includes(strategy.id),
      })),
    },
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
