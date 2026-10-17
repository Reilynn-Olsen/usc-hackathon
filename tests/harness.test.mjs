import assert from "node:assert/strict";
import test from "node:test";
import { createStormScenario } from "../lib/harbormind/demo.ts";
import { createRecommendation } from "../lib/harbormind/decision.ts";
import { applyAisPositionReport, applyOpenMeteoForecast } from "../lib/harbormind/adapters.ts";
import { generateStrategies, generateStrategyForPlan, simulateStrategy, simulateStrategyWithReplay } from "../lib/harbormind/simulation.ts";
import { validateSimulationState } from "../lib/harbormind/validate.ts";
import { SCENARIOS, EMPTY_ACTIONS } from "../app/lib/data.ts";
import { actionSelectionForStrategy, availableActionsForStrategies, configureScenarioState, isLatestScenarioRequest, replayForMode, scenarioSignature, snapshotAtHour, toggleAction } from "../app/lib/scenario.ts";
import { GET as getScenario } from "../app/api/scenario/route.ts";
import { POST as postStrategies } from "../app/api/strategies/route.ts";
import { POST as postSimulation } from "../app/api/simulate/route.ts";
import { POST as postRecommendation } from "../app/api/recommendation/route.ts";

const startAt = "2026-10-16T12:00:00.000Z";
const scenario = () => createStormScenario(startAt);
function cargoOperationsState() {
  const state = scenario();
  const port = {
    ...state.ports[0], currentCapacityContainersPerDay: 24, normalCapacityContainersPerDay: 24,
    availableBerths: 1, unloadingResources: 1, queueShipIds: ["vessel-a", "vessel-b"],
    activeDisruptions: [{ id: "fog-18h", description: "Synthetic reduced port throughput", severity: 0.5, startHour: 0, durationHours: 18 }],
  };
  const cargo = (source, cargoId, category, containers, essential, deadline) => ({
    ...source, cargoId, category, containers, essential, deadline, delayCostPerContainerHour: 2, specialHandling: [],
  });
  const vesselA = {
    ...state.ships[0], vesselId: "vessel-a", estimatedArrival: startAt, destinationPortId: port.portId,
    eligibleAlternativePortIds: [], cargo: [
      cargo(state.ships[0].cargo[0], "retail-batch", "retail", 10, false, "2026-10-16T13:00:00.000Z"),
      cargo(state.ships[0].cargo[0], "medical-batch", "medical", 2, true, "2026-10-16T16:00:00.000Z"),
    ],
  };
  const vesselB = {
    ...state.ships[1], vesselId: "vessel-b", estimatedArrival: "2026-10-16T18:00:00.000Z", destinationPortId: port.portId,
    eligibleAlternativePortIds: [], cargo: [cargo(state.ships[1].cargo[0], "consumer-batch", "consumer", 5, false, "2026-10-16T13:00:00.000Z")],
  };
  state.ports = [port];
  state.ships = [vesselA, vesselB];
  state.weather = [];
  return state;
}
const cargoOperationsOptions = { runs: 1, seed: 42, horizonHours: 18, timeStepHours: 1, maxArrivalDelayHours: 0, weatherSeverityVariation: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, equipmentFailureProbability: 0 };
const validReply = (state, strategyId) => ({
  model: "test-jev",
  selection: { choice: strategyId, confidence: 0.8, probabilities: Object.fromEntries(generateStrategies(state).map((strategy) => [strategy.id, strategy.id === strategyId ? 0.8 : 0.2 / (generateStrategies(state).length - 1)])) },
  cargoUrgency: { score: 3, confidence: 0.8, probabilities: { "0": 0, "1": 0.1, "2": 0.2, "3": 0.7 }, legend: { "0": "Low", "1": "Moderate", "2": "High", "3": "Severe" } },
  operationalRisk: { score: 2, confidence: 0.75, probabilities: { "0": 0.1, "1": 0.2, "2": 0.5, "3": 0.2 }, legend: { "0": "Low", "1": "Moderate", "2": "High", "3": "Severe" } },
  humanReview: 0.9,
  timeCritical: 0.95,
});

test("synthetic storm state validates and strategies put essential shipments first", () => {
  const state = scenario();
  assert.deepEqual(validateSimulationState(state).errors, []);
  const strategies = generateStrategies(state);
  const criticalFirst = strategies.find((strategy) => strategy.id === "critical-cargo-first");
  assert.ok(criticalFirst);
  const scheduled = criticalFirst.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId);
  assert.deepEqual(scheduled.slice(0, 2), ["pacific-star", "northwind"]);
  assert.ok(strategies.some((strategy) => strategy.id === "dedicated-critical-capacity"));
});

test("simulated throughput respects port capacity and fixed seed repeats exactly", () => {
  const state = scenario();
  const baseline = generateStrategies(state).find((strategy) => strategy.id === "baseline-arrival-order");
  const options = { runs: 8, seed: 1234, horizonHours: 24 };
  const first = simulateStrategy(state, baseline, options);
  const second = simulateStrategy(state, baseline, options);
  assert.deepEqual(first, second);
  assert.ok(first.mean.totalContainersProcessed <= 132 + 0.01);
  assert.notEqual(first.mean.estimatedDelayCost, null);
  delete state.ships[0].cargo[0].delayCostPerContainerHour;
  assert.equal(simulateStrategy(state, baseline, options).mean.estimatedDelayCost, null);
});

test("hourly cargo replay unloads urgent batches ahead of earlier manifest items under berth and throughput limits", () => {
  const state = cargoOperationsState();
  assert.deepEqual(validateSimulationState(state).errors, []);
  const strategies = generateStrategies(state);
  const baseline = strategies.find((item) => item.id === "baseline-arrival-order");
  const prioritized = strategies.find((item) => item.id === "critical-cargo-first");
  const baseResult = simulateStrategyWithReplay(state, baseline, cargoOperationsOptions);
  const priorityResult = simulateStrategyWithReplay(state, prioritized, cargoOperationsOptions);
  const snapshots = priorityResult.replay.snapshots;
  const hourTwo = snapshots.find((item) => item.simulationHour === 2);

  assert.equal(hourTwo.cargoBatches.find((item) => item.batchId === "medical-batch").containersUnloaded, 1);
  assert.equal(hourTwo.cargoBatches.find((item) => item.batchId === "retail-batch").containersUnloaded, 0);
  assert.equal(hourTwo.ports[0].capacityContainersPerHour, 0.5);
  assert.equal(hourTwo.ports[0].activeDisruptions[0].id, "fog-18h");
  assert.equal(baseResult.replay.snapshots.find((item) => item.simulationHour === 2).cargoBatches.find((item) => item.batchId === "retail-batch").containersUnloaded, 1);
  assert.equal(snapshots.find((item) => item.simulationHour === 4).cargoBatches.find((item) => item.batchId === "medical-batch").status, "completed");
  assert.equal(snapshots.find((item) => item.simulationHour === 6).vessels.find((item) => item.vesselId === "vessel-b").status, "waiting");
  assert.equal(snapshots.find((item) => item.simulationHour === 5).cargoBatches.find((item) => item.batchId === "consumer-batch").containersUnloaded, 0);

  for (const snapshot of snapshots) {
    const berths = snapshot.ports[0].berthAssignments;
    assert.ok(berths.length <= state.ports[0].availableBerths);
    assert.equal(new Set(berths.map((item) => item.berthId)).size, berths.length);
  }
  const unloaded = snapshots.slice(1).reduce((sum, item) => sum + item.ports[0].containersUnloadedThisStep, 0);
  assert.ok(unloaded <= state.ports[0].currentCapacityContainersPerDay * cargoOperationsOptions.horizonHours / 24);
  assert.equal(priorityResult.summary.mean.criticalCargoOnTimePercent, 100);
  assert.equal(baseResult.summary.mean.criticalCargoOnTimePercent, 0);
  assert.notEqual(priorityResult.summary.mean.averageCargoDelayHours, baseResult.summary.mean.averageCargoDelayHours);
  assert.notEqual(priorityResult.summary.mean.estimatedDelayCost, baseResult.summary.mean.estimatedDelayCost);
  assert.deepEqual(
    priorityResult.replay.snapshots[0].vessels.map(({ vesselId, arrivalHour }) => [vesselId, arrivalHour]),
    baseResult.replay.snapshots[0].vessels.map(({ vesselId, arrivalHour }) => [vesselId, arrivalHour]),
  );
  assert.deepEqual(priorityResult.replay.snapshots[0].ports.map(({ portId, capacityContainersPerHour }) => [portId, capacityContainersPerHour]),
    baseResult.replay.snapshots[0].ports.map(({ portId, capacityContainersPerHour }) => [portId, capacityContainersPerHour]));
});

test("an 18-hour disruption begins at T+0, remains through T+17, then restores port capacity", () => {
  const state = configureScenarioState(scenario(), SCENARIOS.find((item) => item.id === "fog"), 35, 18);
  state.weather = [];
  const baseline = generateStrategies(state).find((item) => item.id === "baseline-arrival-order");
  const { replay } = simulateStrategyWithReplay(state, baseline, { runs: 1, seed: 7, horizonHours: 36, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 });
  const at = (hour) => replay.snapshots.find((snapshot) => snapshot.simulationHour === hour).ports[0];
  assert.equal(at(0).capacityContainersPerHour, 6.5);
  assert.equal(at(0).activeDisruptions.length, 1);
  assert.equal(at(17).activeDisruptions.length, 1);
  assert.equal(at(17).capacityContainersPerHour, 6.5);
  assert.equal(at(18).activeDisruptions.length, 0);
  assert.equal(at(18).capacityContainersPerHour, 10);
  assert.equal(replay.snapshots.at(-1).simulationHour, 36);
});

test("overlapping disruption capacity losses multiply and remain bounded at event boundaries", () => {
  const state = scenario();
  state.weather = [];
  state.ports[0].currentCapacityContainersPerDay = 240;
  state.ports[0].activeDisruptions = [
    { id: "first", description: "first", severity: 0.5, startHour: 0, durationHours: 2 },
    { id: "second", description: "second", severity: 0.5, startHour: 1, durationHours: 2 },
  ];
  const baseline = generateStrategies(state).find((item) => item.id === "baseline-arrival-order");
  const { replay } = simulateStrategyWithReplay(state, baseline, { runs: 1, seed: 2, horizonHours: 4, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 });
  const capacities = replay.snapshots.map((snapshot) => snapshot.ports[0]);
  assert.deepEqual(capacities.slice(0, 4).map((port) => port.capacityContainersPerHour), [5, 2.5, 5, 10]);
  assert.deepEqual(capacities.slice(0, 4).map((port) => port.activeDisruptions.length), [1, 2, 1, 0]);
  assert.ok(capacities.every((port) => port.capacityContainersPerHour >= 0 && port.capacityContainersPerHour <= 10));
});

test("a disruption boundary inside a multi-hour step contributes capacity only for its active hours", () => {
  const state = scenario();
  state.weather = [];
  state.ports[0].activeDisruptions = [{ id: "partial-step", description: "partial step", severity: 0.5, startHour: 1, durationHours: 2 }];
  const baseline = generateStrategies(state).find((item) => item.id === "baseline-arrival-order");
  const { replay } = simulateStrategyWithReplay(state, baseline, { runs: 1, seed: 3, horizonHours: 4, timeStepHours: 2, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 });
  assert.equal(replay.snapshots[1].simulationHour, 2);
  assert.equal(replay.snapshots[1].ports[0].activeDisruptions.length, 1);
  assert.equal(replay.snapshots[1].ports[0].capacityContainersPerHour, 5);
  assert.equal(replay.snapshots[1].ports[0].containersUnloadedThisStep, 15);
  assert.equal(replay.snapshots[2].ports[0].activeDisruptions.length, 0);
  assert.equal(replay.snapshots[2].ports[0].containersUnloadedThisStep, 15);
});

test("replay mode selects the matching plan, scrubbing chooses the latest available snapshot, and missing data is safe", () => {
  const baseline = { snapshots: [{ simulationHour: 0 }, { simulationHour: 2 }, { simulationHour: 4 }] };
  const recovery = { snapshots: [{ simulationHour: 0 }, { simulationHour: 1 }] };
  assert.equal(replayForMode("baseline", baseline, recovery), baseline);
  assert.equal(replayForMode("recovery", baseline, recovery), recovery);
  assert.equal(snapshotAtHour(baseline, 3), baseline.snapshots[1]);
  assert.equal(snapshotAtHour(null, 3), null);
  assert.equal(replayForMode("baseline"), null);
});

test("standard-shipment rerouting excludes essential vessels and requires a feasible modeled alternative", () => {
  const state = scenario();
  const alternative = {
    ...state.ports[0], portId: "port-alternative", location: { name: "Modeled Alternative", latitude: 34, longitude: -119 },
    normalCapacityContainersPerDay: 400, currentCapacityContainersPerDay: 400, queueShipIds: [], activeDisruptions: [], source: "synthetic",
  };
  state.ports.push(alternative);
  state.ships[2].eligibleAlternativePortIds = [alternative.portId];
  assert.ok(!generateStrategies(state).some((strategy) => strategy.id === `reroute-northwind-${alternative.portId}`));
  state.ships[0].eligibleAlternativePortIds = [alternative.portId];
  assert.ok(generateStrategies(state).some((strategy) => strategy.id === `reroute-evergreen-1-${alternative.portId}`));
  alternative.currentCapacityContainersPerDay = 1;
  assert.ok(!generateStrategies(state).some((strategy) => strategy.id === `reroute-evergreen-1-${alternative.portId}`));
});

test("invalid Jev choices and Jev failures fall back to normal arrival-order scheduling", async () => {
  const state = scenario();
  const invalid = await createRecommendation(state, { runs: 3 }, async () => ({ ...validReply(state, "baseline-arrival-order"), selection: { choice: "not-feasible", confidence: 0.99, probabilities: { "not-feasible": 1 } } }));
  assert.equal(invalid.recommendation.selectedStrategyId, "baseline-arrival-order");
  assert.equal(invalid.recommendation.decisionSource, "fallback");
  assert.match(invalid.recommendation.fallbackReason, /outside the feasible candidate set/);
  assert.equal(invalid.recommendation.humanReviewRecommended, true);

  const failed = await createRecommendation(state, { runs: 3 }, async () => { throw new Error("provider timeout"); });
  assert.equal(failed.recommendation.selectedStrategyId, "baseline-arrival-order");
  assert.equal(failed.recommendation.aiGenerated, false);
  assert.match(failed.recommendation.warnings.join(" "), /Jev decision failed/);

  const incomplete = await createRecommendation(state, { runs: 3 }, async () => {
    const reply = validReply(state, "baseline-arrival-order");
    delete reply.selection.confidence;
    return reply;
  });
  assert.equal(incomplete.recommendation.decisionSource, "fallback");
  assert.equal(incomplete.recommendation.jev, null);
});

test("storm example selects a feasible critical-cargo strategy and beats the baseline", async () => {
  const state = scenario();
  const selectedId = "dedicated-critical-capacity";
  const result = await createRecommendation(state, { runs: 20, seed: 42 }, async (_state, strategies) => validReply(state, strategies.some((item) => item.id === selectedId) ? selectedId : "baseline-arrival-order"));
  assert.ok(result.strategies.some((strategy) => strategy.id === result.recommendation.selectedStrategyId));
  assert.equal(result.recommendation.decisionSource, "jev");
  assert.equal(result.recommendation.aiGenerated, true);
  assert.equal(result.recommendation.jev.model, "test-jev");
  assert.deepEqual(result.evaluatedStrategies.find((item) => item.strategy.id === selectedId).outcome, result.recommendation.baselineComparison.selected);
  assert.ok(result.recommendation.baselineComparison.selected.mean.criticalCargoOnTimePercent > result.recommendation.baselineComparison.baseline.mean.criticalCargoOnTimePercent);
  assert.ok(result.recommendation.baselineComparison.criticalCargoOnTimeChangePercent > 0);
  assert.equal(result.recommendation.humanApprovalRequired, true);
});

test("local mock mode returns typed advice without an API key and marks it as a mock", async () => {
  const saved = { mock: process.env.JEV_MOCK, nodeEnv: process.env.NODE_ENV };
  process.env.JEV_MOCK = "true";
  process.env.NODE_ENV = "test";
  try {
    const result = await createRecommendation(scenario(), { runs: 3 });
    assert.equal(result.recommendation.decisionSource, "mock");
    assert.equal(result.recommendation.aiGenerated, false);
    assert.equal(result.recommendation.jev.model, "mock-jev");
  } finally {
    if (saved.mock === undefined) delete process.env.JEV_MOCK;
    else process.env.JEV_MOCK = saved.mock;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
});

test("live API adapters update only fields provided by Open-Meteo and AISStream", () => {
  const state = scenario();
  const forecast = applyOpenMeteoForecast(state, {
    location: { name: "Port of Los Angeles" },
    weather: { hourly: { time: [startAt], wind_speed_10m: [35], wind_gusts_10m: [55], precipitation: [2] } },
    marine: { hourly: { time: [startAt], wave_height: [2.2] } },
  });
  assert.equal(forecast.weather[0].source, "live");
  assert.equal(forecast.weather[0].forecasts[0].waveHeightM, 2.2);
  assert.equal(forecast.weather[0].alertsSource, "unavailable");
  const originalEta = state.ships[0].estimatedArrival;
  const position = applyAisPositionReport(state, {
    MetaData: { MMSI: "synthetic-338123000" },
    Message: { PositionReport: { Latitude: 33.8, Longitude: -118.3, TrueHeading: 270, Sog: 7 } },
  });
  assert.deepEqual(position.ships[0].position, { latitude: 33.8, longitude: -118.3 });
  assert.equal(position.ships[0].positionSource, "live");
  assert.equal(position.ships[0].operationsSource, "synthetic");
  assert.equal(position.ships[0].estimatedArrival, originalEta);
  assert.equal(position.provenance.shipPositions, "mixed");
});

test("scenario controls produce backend input and action cards reflect feasible strategies", () => {
  const state = scenario();
  const fog = configureScenarioState(state, SCENARIOS.find((item) => item.id === "fog"), 35);
  assert.deepEqual(validateSimulationState(fog).errors, []);
  assert.equal(fog.scenarioId, "fog");
  assert.equal(fog.ports[0].currentCapacityContainersPerDay, 240);
  assert.equal(fog.ports[0].activeDisruptions[0].severity, 0.35);
  assert.equal(fog.ports[0].activeDisruptions[0].durationHours, 18);
  assert.deepEqual(fog.weather, []);
  assert.equal(fog.provenance.weather, "unavailable");
  assert.notEqual(scenarioSignature("storm", 60, 12), scenarioSignature("fog", 35, 12));

  const strategies = generateStrategies(state);
  assert.deepEqual(availableActionsForStrategies(strategies), { critical: true, stagger: true, trucks: true, divert: false });
  const recommended = actionSelectionForStrategy(strategies.find((item) => item.id === "dedicated-critical-capacity"));
  assert.deepEqual(recommended, { critical: true, stagger: false, trucks: true, divert: false });
  assert.deepEqual(toggleAction(toggleAction(EMPTY_ACTIONS, "critical", true), "critical", false), EMPTY_ACTIONS);
  const reserved = toggleAction(EMPTY_ACTIONS, "trucks", true);
  assert.equal(reserved.critical, true);
  assert.equal(toggleAction(reserved, "critical", false).trucks, false);

  const controller = new AbortController();
  assert.equal(isLatestScenarioRequest(2, 2, controller, controller), true);
  assert.equal(isLatestScenarioRequest(1, 2, controller, controller), false);
  controller.abort();
  assert.equal(isLatestScenarioRequest(2, 2, controller, controller), false);
});

test("dense fog recommendation and plan evaluation use the same horizon, seed, and baseline", async () => {
  const fog = configureScenarioState(scenario(), SCENARIOS.find((item) => item.id === "fog"), 35);
  const options = { runs: 8, seed: 42, horizonHours: 36 };
  const result = await createRecommendation(fog, options, async () => validReply(fog, "stage-lower-priority"));
  assert.equal(result.recommendation.decisionSource, "jev");
  assert.equal(result.recommendation.estimatedOutcomes.horizonHours, 36);

  const response = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: fog, options, strategyId: result.recommendation.selectedStrategyId }),
  }));
  const evaluated = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(evaluated.outcome, result.recommendation.estimatedOutcomes);
  assert.deepEqual(evaluated.baseline, result.recommendation.baselineComparison.baseline);
  assert.equal(evaluated.replay.sampleRunIndex, 0);
  assert.equal(evaluated.baselineReplay.sampleRunIndex, 0);
  assert.deepEqual(evaluated.baselineReplay.snapshots, simulateStrategyWithReplay(fog, generateStrategies(fog)[0], options).replay.snapshots);
  assert.equal(evaluated.replay.snapshots.length, 37);
  assert.equal(evaluated.replay.snapshots.at(-1).simulationHour, 36);
});

test("combined recovery actions are validated and use the same seeded baseline simulation", async () => {
  const state = scenario();
  const options = { runs: 5, seed: 9, horizonHours: 24 };
  const plan = { prioritizeCriticalCargo: true, staggerLowerPriorityVessels: true, reserveCapacityForCriticalCargo: true, divertStandardShipment: false };
  const response = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.strategy.scheduling, "critical-first");
  assert.equal(result.strategy.holdNonessentialHours, 8);
  assert.equal(result.strategy.resourceMode, "dedicated-priority");
  assert.equal(result.outcome.runs, options.runs);
  assert.equal(result.outcome.seed, options.seed);
  assert.equal(result.outcome.horizonHours, options.horizonHours);
  assert.deepEqual(result.baseline, simulateStrategy(state, generateStrategies(state)[0], options));

  const infeasible = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan: { ...plan, divertStandardShipment: true } }),
  }));
  assert.equal(infeasible.status, 422);
  const invalidCombination = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan: { ...plan, prioritizeCriticalCargo: false } }),
  }));
  assert.equal(invalidCombination.status, 422);
  assert.match((await invalidCombination.json()).error, /not feasible/);
});

test("a selected action may perform worse than baseline and the simulator returns the loss", () => {
  const state = scenario();
  state.ports[0].activeDisruptions[0].durationHours = 72;
  for (const ship of state.ships) for (const cargo of ship.cargo) {
    cargo.essential = false;
    cargo.deadline = "2026-10-16T13:00:00.000Z";
  }
  const strategies = generateStrategies(state);
  const baseline = strategies.find((item) => item.id === "baseline-arrival-order");
  const stagger = generateStrategyForPlan(state, { prioritizeCriticalCargo: false, staggerLowerPriorityVessels: true, reserveCapacityForCriticalCargo: false, divertStandardShipment: false });
  const baselineOutcome = simulateStrategy(state, baseline, { runs: 20, seed: 42, horizonHours: 72 });
  const staggerOutcome = simulateStrategy(state, stagger, { runs: 20, seed: 42, horizonHours: 72 });
  assert.ok(staggerOutcome.mean.averageCargoDelayHours > baselineOutcome.mean.averageCargoDelayHours);
  assert.ok(staggerOutcome.mean.totalContainersProcessed < baselineOutcome.mean.totalContainersProcessed);
});

test("scenario and strategy API routes expose the example and reject bad input", async () => {
  const response = await getScenario();
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.provenance.weather, "synthetic");

  const list = await postStrategies(new Request("http://localhost/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options: { runs: 5 } }) }));
  const listed = await list.json();
  assert.equal(list.status, 200);
  assert.ok(listed.strategies.length >= 4);
  const simulation = await postSimulation(new Request("http://localhost/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, strategyId: "dedicated-critical-capacity", options: { runs: 5 } }) }));
  assert.equal(simulation.status, 200);
  assert.equal((await simulation.json()).humanApprovalRequired, true);

  const invalid = await postStrategies(new Request("http://localhost/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(invalid.status, 400);
  const invalidStep = await postStrategies(new Request("http://localhost/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options: { timeStepHours: 0 } }) }));
  assert.equal(invalidStep.status, 400);
});

test("recommendation route returns the complete baseline fallback when Jev has no key", async () => {
  const saved = { key: process.env.TYPESAFE_API_KEY, mock: process.env.JEV_MOCK, nodeEnv: process.env.NODE_ENV };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_MOCK;
  process.env.NODE_ENV = "test";
  try {
    const response = await postRecommendation(new Request("http://localhost/api/recommendation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: scenario(), options: { runs: 3, seed: 12 } }),
    }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.recommendation.decisionSource, "fallback");
    assert.equal(result.recommendation.fallbackReason, "TYPESAFE_API_KEY is not configured.");
    assert.equal(result.recommendation.simulatedOutcomeLikelihoods.seed, 12);
    assert.equal(result.recommendation.humanApprovalRequired, true);
    assert.ok(result.recommendation.baselineComparison.baseline.mean.criticalCargoOnTimePercent >= 0);
    assert.ok(result.availableStrategies.some((strategy) => strategy.id === result.recommendation.selectedStrategyId));
    assert.equal(result.evaluatedStrategies.length, result.availableStrategies.length);
    assert.ok(result.evaluatedStrategies.every((entry) => entry.outcome.runs === 3 && typeof entry.outcome.probabilityOfMeetingTarget === "number"));
  } finally {
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved.key;
    if (saved.mock === undefined) delete process.env.JEV_MOCK;
    else process.env.JEV_MOCK = saved.mock;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
});
