import assert from "node:assert/strict";
import test from "node:test";
import { createStormScenario } from "../lib/harbormind/demo.ts";
import { assessAdaptivePlanQuality, createRecommendation } from "../lib/harbormind/decision.ts";
import { applyAisPositionReport, applyOpenMeteoForecast } from "../lib/harbormind/adapters.ts";
import { generateStrategies, generateStrategyForPlan, isRecoveryPlan, simulateStrategy, simulateStrategyWithReplay } from "../lib/harbormind/simulation.ts";
import { validateSimulationState } from "../lib/harbormind/validate.ts";
import { SCENARIOS } from "../app/lib/data.ts";
import { configureScenarioState, copyRecoveryPlan, isLatestScenarioRequest, recoveryPlanForStrategy, replayForMode, sameRecoveryPlan, scenarioSignature, snapshotAtHour } from "../app/lib/scenario.ts";
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
function objectiveTradeoffState() {
  const state = cargoOperationsState();
  state.ships[0].estimatedArrival = startAt;
  state.ships[1].estimatedArrival = startAt;
  state.ships[0].cargo[0].deadline = "2026-10-16T13:00:00.000Z";
  state.ships[0].cargo[0].delayCostPerContainerHour = 100;
  state.ships[0].cargo[1].deadline = "2026-10-16T15:00:00.000Z";
  state.ships[0].cargo[1].delayCostPerContainerHour = 0;
  state.ships[1].cargo[0].deadline = "2026-10-17T12:00:00.000Z";
  state.ships[1].cargo[0].delayCostPerContainerHour = 100;
  return state;
}
const cargoOperationsOptions = { runs: 1, seed: 42, horizonHours: 18, timeStepHours: 1, maxArrivalDelayHours: 0, weatherSeverityVariation: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, equipmentFailureProbability: 0 };
const planSignature = (plan) => JSON.stringify([
  plan.scheduling, Object.entries(plan.stagingWindowsByVessel).sort(), Object.entries(plan.cargoPrioritiesByBatch).sort(),
  plan.reserveBerthForCriticalCargo, plan.criticalCapacityReservation, Object.entries(plan.assignments).sort(),
  plan.objective, plan.minimumCriticalCargoOnTimePercent, plan.maximumDisruptionCost,
]);
const validReply = (state, strategyId, candidates = generateStrategies(state), selectableIds = candidates.map((strategy) => strategy.id)) => {
  const selectable = candidates.filter((strategy) => selectableIds.includes(strategy.id));
  return ({
  model: "test-jev",
  selection: { choice: strategyId, confidence: 0.8, probabilities: Object.fromEntries(selectable.map((strategy) => [strategy.id, selectable.length === 1 ? 1 : strategy.id === strategyId ? 0.8 : 0.2 / (selectable.length - 1)])) },
  cargoUrgency: { score: 3, confidence: 0.8, probabilities: { "0": 0, "1": 0.1, "2": 0.2, "3": 0.7 }, legend: { "0": "Low", "1": "Moderate", "2": "High", "3": "Severe" } },
  operationalRisk: { score: 2, confidence: 0.75, probabilities: { "0": 0.1, "1": 0.2, "2": 0.5, "3": 0.2 }, legend: { "0": "Low", "1": "Moderate", "2": "High", "3": "Severe" } },
  humanReview: 0.9,
  timeCritical: 0.95,
  });
};

test("synthetic storm state validates and strategies put essential shipments first", () => {
  const state = scenario();
  assert.deepEqual(validateSimulationState(state).errors, []);
  const strategies = generateStrategies(state);
  const criticalFirst = strategies.find((strategy) => strategy.scheduling === "critical-first");
  assert.ok(criticalFirst);
  const scheduled = criticalFirst.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId);
  assert.deepEqual(scheduled.slice(0, 2), ["pacific-star", "northwind"]);
  assert.ok(strategies.some((strategy) => strategy.reserveBerthForCriticalCargo || strategy.criticalCapacityReservation));
});

test("bounded strategy generation offers timed staging for selected vessels and produces different berth states", () => {
  const state = cargoOperationsState();
  state.ships[1].estimatedArrival = startAt;
  state.ports[0].availableBerths = 2;
  state.ports[0].unloadingResources = 2;
  const strategies = generateStrategies(state, 18);
  const staged = strategies.filter((strategy) => Object.keys(strategy.stagingWindowsByVessel).length > 0);
  assert.ok(strategies.length <= 40);
  assert.deepEqual([2, 4, 8, 12].map((hours) => staged.some((strategy) => Object.values(strategy.stagingWindowsByVessel).some((window) => window.durationHours === hours))), [true, true, true, true]);
  assert.ok(staged.some((strategy) => strategy.stagingWindowsByVessel["vessel-b"]));
  assert.ok(strategies.some((strategy) => strategy.scheduling === "deadline-risk-first"));
  assert.equal(new Set(strategies.map((strategy) => planSignature(strategy))).size, strategies.length, "candidate plans are deduplicated");

  const baseline = simulateStrategyWithReplay(state, strategies.find((item) => item.id === "baseline-arrival-order"), cargoOperationsOptions);
  const stagedPlan = simulateStrategyWithReplay(state, staged.find((item) => item.stagingWindowsByVessel["vessel-b"]?.durationHours === 2), cargoOperationsOptions);
  assert.equal(baseline.replay.snapshots[1].vessels.find((item) => item.vesselId === "vessel-b").status, "berthed");
  assert.equal(stagedPlan.replay.snapshots[1].vessels.find((item) => item.vesselId === "vessel-b").status, "waiting");
});

test("critical throughput reservations change cargo movement without exceeding port throughput", () => {
  const state = cargoOperationsState();
  state.ports[0].currentCapacityContainersPerDay = 240;
  state.ports[0].activeDisruptions[0].severity = 0;
  state.ports[0].availableBerths = 2;
  state.ports[0].unloadingResources = 2;
  state.ships[0].estimatedArrival = startAt;
  state.ships[0].cargo[0].containers = 10;
  state.ships[0].cargo[1].containers = 10;
  state.ships[1].estimatedArrival = startAt;
  const strategies = generateStrategies(state, 12);
  const reservations = [...new Set(strategies.map((item) => item.criticalCapacityReservation?.percent).filter(Boolean))];
  assert.ok([25, 50, 75].every((percent) => reservations.includes(percent)));
  const reserved = strategies.find((item) => item.criticalCapacityReservation?.percent === 50);
  const result = simulateStrategyWithReplay(state, reserved, { ...cargoOperationsOptions, horizonHours: 12 });
  const firstHour = result.replay.snapshots.find((item) => item.simulationHour === 1);
  assert.equal(firstHour.cargoBatches.find((item) => item.batchId === "medical-batch").containersUnloaded, 5);
  assert.equal(firstHour.cargoBatches.find((item) => item.batchId === "retail-batch").containersUnloaded, 5);
  assert.equal(firstHour.ports[0].containersUnloadedThisStep, 10);
});

test("deadline-risk scheduling puts the tighter critical deadline first", () => {
  const state = cargoOperationsState();
  state.ships[1].cargo[0].essential = true;
  state.ships[1].cargo[0].deadline = "2026-10-16T13:00:00.000Z";
  state.ships[0].cargo[1].deadline = "2026-10-16T16:00:00.000Z";
  const strategy = generateStrategies(state).find((item) => item.scheduling === "deadline-risk-first");
  const order = strategy.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId);
  assert.deepEqual(order.slice(0, 2), ["vessel-b", "vessel-a"]);
});

test("deadline-risk scheduling helps a congested queue even without essential cargo", () => {
  const state = cargoOperationsState();
  state.ships[1].estimatedArrival = startAt;
  state.ships[0].cargo.forEach((cargo) => { cargo.essential = false; cargo.deadline = "2026-10-17T00:00:00.000Z"; });
  state.ships[1].cargo[0].deadline = "2026-10-16T13:00:00.000Z";
  state.ports[0].availableBerths = 2;
  state.ports[0].unloadingResources = 2;
  const strategies = generateStrategies(state, 24);
  const baseline = simulateStrategy(state, strategies.find((item) => item.id === "baseline-arrival-order"), { ...cargoOperationsOptions, horizonHours: 24 });
  const deadlineRisk = simulateStrategy(state, strategies.find((item) => item.scheduling === "deadline-risk-first"), { ...cargoOperationsOptions, horizonHours: 24 });
  assert.ok(deadlineRisk.mean.averageCargoDelayHours < baseline.mean.averageCargoDelayHours);
  assert.ok(deadlineRisk.mean.totalContainersProcessed <= 24);
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
  const prioritized = strategies.find((item) => item.scheduling === "critical-first");
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

test("a vessel-specific cargo priority changes the actual batch selected for unloading", () => {
  const state = cargoOperationsState();
  const baseline = generateStrategies(state).find((item) => item.id === "baseline-arrival-order");
  const custom = generateStrategyForPlan(state, { ...recoveryPlanForStrategy(baseline), cargoPrioritiesByBatch: { "medical-batch": 3 } }, 18);
  const baselineReplay = simulateStrategyWithReplay(state, baseline, cargoOperationsOptions).replay;
  const customReplay = simulateStrategyWithReplay(state, custom, cargoOperationsOptions).replay;
  const baselineAtTwo = baselineReplay.snapshots.find((item) => item.simulationHour === 2).cargoBatches;
  const customAtTwo = customReplay.snapshots.find((item) => item.simulationHour === 2).cargoBatches;
  assert.equal(baselineAtTwo.find((item) => item.batchId === "retail-batch").containersUnloaded, 1);
  assert.equal(baselineAtTwo.find((item) => item.batchId === "medical-batch").containersUnloaded, 0);
  assert.equal(customAtTwo.find((item) => item.batchId === "medical-batch").containersUnloaded, 1);
  assert.equal(customAtTwo.find((item) => item.batchId === "retail-batch").containersUnloaded, 0);
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

test("zero and near-zero capacity never exceed throughput or invent berth capacity", () => {
  const state = scenario();
  state.ports[0].activeDisruptions = [];
  state.ports[0].currentCapacityContainersPerDay = 0;
  state.ports[0].availableBerths = 0;
  state.ports[0].unloadingResources = 0;
  state.weather = [];
  const baseline = generateStrategies(state, 48)[0];
  const options = { runs: 1, seed: 42, horizonHours: 48, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 };
  const zero = simulateStrategyWithReplay(state, baseline, options);
  assert.equal(zero.summary.mean.totalContainersProcessed, 0);
  assert.equal(zero.summary.mean.portUtilizationPercent, 0);
  assert.ok(zero.replay.snapshots.every((item) => item.ports[0].capacityContainersPerHour === 0 && item.ports[0].berthAssignments.length === 0));

  const nearZeroState = structuredClone(state);
  nearZeroState.ports[0].currentCapacityContainersPerDay = 1;
  nearZeroState.ports[0].availableBerths = 1;
  nearZeroState.ports[0].unloadingResources = 1;
  const nearZero = simulateStrategyWithReplay(nearZeroState, baseline, options);
  assert.ok(nearZero.summary.mean.totalContainersProcessed > 0);
  assert.ok(nearZero.summary.mean.totalContainersProcessed <= 2, "one container per day over 48 hours is the hard throughput ceiling");
  assert.ok(nearZero.replay.snapshots.every((item) => item.ports[0].containersUnloadedThisStep <= 1));
});

test("three critical shipments compete for one berth and the tightest deadline is served first", async () => {
  const state = scenario();
  const port = { ...state.ports[0], normalCapacityContainersPerDay: 24, currentCapacityContainersPerDay: 24, availableBerths: 1, unloadingResources: 1, activeDisruptions: [], queueShipIds: [] };
  const vessel = (source, vesselId, cargoId, deadline) => ({
    ...source,
    vesselId,
    estimatedArrival: startAt,
    destinationPortId: port.portId,
    eligibleAlternativePortIds: [],
    cargo: [{ ...source.cargo[0], cargoId, containers: 3, essential: true, deadline, delayCostPerContainerHour: 2, specialHandling: [] }],
  });
  state.ships = [
    vessel(state.ships[0], "deadline-late", "critical-late", "2026-10-17T00:00:00.000Z"),
    vessel(state.ships[1], "deadline-middle", "critical-middle", "2026-10-16T20:00:00.000Z"),
    vessel(state.ships[2], "deadline-urgent", "critical-urgent", "2026-10-16T16:00:00.000Z"),
  ];
  port.queueShipIds = state.ships.map((ship) => ship.vesselId);
  state.ports = [port];
  state.weather = [];

  const strategies = generateStrategies(state, 24);
  const baseline = strategies.find((item) => item.id === "baseline-arrival-order");
  const deadlineFirst = strategies.find((item) => item.scheduling === "deadline-risk-first");
  assert.ok(baseline && deadlineFirst);
  assert.deepEqual(deadlineFirst.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId), ["deadline-urgent", "deadline-middle", "deadline-late"]);
  const options = { ...cargoOperationsOptions, horizonHours: 24 };
  const before = simulateStrategyWithReplay(state, baseline, options);
  const after = simulateStrategyWithReplay(state, deadlineFirst, options);
  assert.equal(before.summary.mean.criticalCargoOnTimePercent, 66.67);
  assert.equal(after.summary.mean.criticalCargoOnTimePercent, 100);
  assert.ok(after.replay.snapshots.every((item) => item.ports[0].berthAssignments.length <= 1 && item.ports[0].containersUnloadedThisStep <= 1));
  assert.deepEqual(after.replay.snapshots.at(-1).cargoBatches.filter((item) => item.criticality === "critical").map((item) => item.containersUnloaded), [3, 3, 3]);

  const recommendation = await createRecommendation(state, options, async (_state, candidates, outcomes, _criteria, _target, selectableIds) => {
    const selected = candidates.filter((item) => selectableIds.includes(item.id))
      .sort((left, right) => outcomes.get(right.id).mean.criticalCargoOnTimePercent - outcomes.get(left.id).mean.criticalCargoOnTimePercent)[0];
    return validReply(state, selected.id, candidates, selectableIds);
  });
  const finalPlan = recommendation.strategies.find((item) => item.id === recommendation.recommendation.selectedStrategyId);
  assert.equal(recommendation.recommendation.decisionSource, "jev");
  assert.ok(finalPlan && finalPlan.scheduling !== "arrival-order");
  assert.deepEqual(recommendation.recommendation.estimatedOutcomes.mean, recommendation.evaluatedStrategies.find((item) => item.strategy.id === finalPlan.id).outcome.mean);
  assert.equal(recommendation.recommendation.estimatedOutcomes.mean.criticalCargoOnTimePercent, 100);
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
  assert.ok(!generateStrategies(state).some((strategy) => strategy.assignments["northwind"] === alternative.portId));
  state.ships[0].eligibleAlternativePortIds = [alternative.portId];
  assert.ok(generateStrategies(state).some((strategy) => strategy.assignments["evergreen-1"] === alternative.portId));
  alternative.currentCapacityContainersPerDay = 1;
  assert.ok(!generateStrategies(state).some((strategy) => strategy.assignments["evergreen-1"] === alternative.portId));
});

test("a feasible standard-vessel reroute changes its simulated port assignment", async () => {
  const state = scenario();
  const alternative = { ...state.ports[0], portId: "port-alternative", location: { name: "Modeled Alternative", latitude: 34, longitude: -119 }, normalCapacityContainersPerDay: 5000, currentCapacityContainersPerDay: 5000, rerouteCostPerContainer: 15, activeDisruptions: [], queueShipIds: [] };
  state.ports.push(alternative);
  state.ports.find((port) => port.portId === state.ships[0].destinationPortId).currentCapacityContainersPerDay = 0;
  state.ships[0].eligibleAlternativePortIds = [alternative.portId];
  const strategy = generateStrategies(state).find((item) => item.assignments["evergreen-1"] === alternative.portId);
  assert.ok(strategy);
  const response = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, strategyId: strategy.id, options: { runs: 1, seed: 9, horizonHours: 36, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 } }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.replay.snapshots.at(-1).vessels.find((item) => item.vesselId === "evergreen-1").portId, alternative.portId);
  assert.equal(result.outcome.mean.estimatedInterventionCost, 160 * alternative.rerouteCostPerContainer);
  assert.equal(result.outcome.mean.estimatedDisruptionCost, result.outcome.mean.estimatedDelayCost + result.outcome.mean.estimatedInterventionCost);
  assert.ok(result.outcome.mean.totalContainersProcessed > result.baseline.mean.totalContainersProcessed);
  assert.deepEqual(result.baselineReplay.snapshots[0].vessels.map((item) => item.portId), state.ships.map((item) => item.destinationPortId));
});

test("operator objectives select different measured trade-offs and Jev receives an auditable candidate set", async () => {
  const state = objectiveTradeoffState();
  const options = { ...cargoOperationsOptions, horizonHours: 24, criticalCargoOnTimeTargetPercent: 0 };
  const saved = { mock: process.env.JEV_MOCK, nodeEnv: process.env.NODE_ENV };
  process.env.JEV_MOCK = "true";
  process.env.NODE_ENV = "test";
  try {
    const critical = await createRecommendation(state, options, undefined, { objective: "critical-delivery" });
    const cost = await createRecommendation(state, options, undefined, { objective: "minimize-cost" });
    const constrained = await createRecommendation(state, options, undefined, { objective: "critical-delivery", maximumDisruptionCost: 10_000 });
    const strictCost = await createRecommendation(state, options, undefined, { objective: "minimize-cost", maximumDisruptionCost: 0 });
    assert.ok(critical.strategies.find((item) => item.id === critical.recommendation.selectedStrategyId));
    assert.equal(cost.recommendation.selectedStrategyId, "baseline-arrival-order");
    assert.notEqual(critical.recommendation.selectedStrategyId, cost.recommendation.selectedStrategyId);
    assert.equal(constrained.recommendation.selectedStrategyId, "baseline-arrival-order");
    assert.ok(critical.recommendation.baselineComparison.selected.mean.criticalCargoOnTimePercent > cost.recommendation.baselineComparison.selected.mean.criticalCargoOnTimePercent);
    assert.ok(cost.recommendation.baselineComparison.selected.mean.estimatedDelayCost < critical.recommendation.baselineComparison.selected.mean.estimatedDelayCost);
    assert.equal(critical.recommendation.decisionAudit.objective, "critical-delivery");
    assert.equal(constrained.recommendation.decisionAudit.maximumDisruptionCost, 10_000);
    const strictSelection = strictCost.recommendation.decisionAudit.candidates.find((item) => item.strategyId === strictCost.recommendation.selectedStrategyId);
    assert.ok(strictSelection.selectionEligible);
    assert.equal(strictCost.recommendation.decisionAudit.maximumDisruptionCost, 0);
    assert.equal(strictSelection.meetsConstraints, false);
    assert.match(strictCost.recommendation.decisionExplanation, /exceeds the \$0 cost ceiling/);
  } finally {
    if (saved.mock === undefined) delete process.env.JEV_MOCK;
    else process.env.JEV_MOCK = saved.mock;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }

  let observed;
  const jev = await createRecommendation(state, options, async (receivedState, strategies, outcomes, criteria, target, selectableIds) => {
    observed = { strategies, outcomes, criteria, target, selectableIds };
    return validReply(receivedState, selectableIds[0], strategies, selectableIds);
  }, { objective: "minimize-delay", maximumDisruptionCost: 10_000 });
  assert.equal(observed.criteria.objective, "minimize-delay");
  assert.equal(observed.target, 0);
  assert.ok(observed.strategies.every((strategy) => outcomesHaveMetrics(observed.outcomes.get(strategy.id))));
  assert.ok(observed.strategies.every((strategy) => isRecoveryPlan(recoveryPlanForStrategy(strategy))));
  assert.ok(observed.selectableIds.every((id) => observed.strategies.some((strategy) => strategy.id === id)));
  assert.equal(jev.recommendation.decisionAudit.objective, "minimize-delay");
  assert.deepEqual(jev.recommendation.decisionAudit.candidates.map((candidate) => candidate.strategyId), jev.strategies.map((strategy) => strategy.id));
  assert.ok(jev.recommendation.decisionAudit.candidates.every((candidate) => candidate.name && candidate.actions.length && outcomesHaveMetrics({ mean: candidate.metrics, probabilityOfMeetingTarget: candidate.probabilityOfMeetingTarget })));
  assert.deepEqual(jev.recommendation.decisionAudit.candidates.filter((candidate) => candidate.selectionEligible).map((candidate) => candidate.strategyId), observed.selectableIds);
  assert.equal(jev.recommendation.decisionAudit.fallback, false);
});

function outcomesHaveMetrics(outcome) {
  return Number.isFinite(outcome?.mean.averageCargoDelayHours)
    && Number.isFinite(outcome?.mean.totalContainersProcessed)
    && typeof outcome?.probabilityOfMeetingTarget === "number";
}

test("no-disruption Jev staging proposal is rejected when it adds vessel delay without cargo benefit", async () => {
  const state = scenario();
  state.ports[0].activeDisruptions = [];
  state.ports[0].currentCapacityContainersPerDay = 2400;
  state.ports[0].normalCapacityContainersPerDay = 2400;
  state.ports[0].availableBerths = 4;
  state.ports[0].unloadingResources = 4;
  state.weather = [];
  for (const ship of state.ships) ship.cargo.forEach((cargo) => { cargo.deadline = "2026-10-22T12:00:00.000Z"; });
  const baseline = generateStrategies(state, 36)[0];
  const plan = recoveryPlanForStrategy(baseline);
  const unnecessary = generateStrategyForPlan(state, {
    ...plan,
    stagingWindowsByVessel: { [state.ships[0].vesselId]: { startHour: 0, durationHours: 2 } },
  }, 36);
  assert.ok(unnecessary);
  const proposal = { ...unnecessary, id: "unnecessary-stage-proposal" };
  const result = await createRecommendation(
    state,
    { runs: 1, seed: 1, horizonHours: 36, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 },
    async (_state, candidates, _outcomes, _criteria, _target, selectableIds) => validReply(state, proposal.id, candidates, selectableIds),
    { objective: "balanced" },
    undefined,
    [proposal],
  );
  assert.equal(result.recommendation.jev.selection.strategyId, proposal.id, "the mocked Jev proposal is deliberately unnecessary");
  assert.equal(result.recommendation.selectedStrategyId, "baseline-arrival-order");
  assert.match(result.recommendation.decisionExplanation, /baseline is no worse across measured outcomes/);
  assert.ok(result.recommendation.warnings.some((warning) => /no-intervention baseline was retained/.test(warning)));
  const proposalOutcome = result.evaluatedStrategies.find((item) => item.strategy.id === proposal.id).outcome.mean;
  assert.ok(proposalOutcome.delayedVessels > result.recommendation.estimatedOutcomes.mean.delayedVessels);
});

test("invalid Jev choices and Jev failures fall back to normal arrival-order scheduling", async () => {
  const state = scenario();
  const invalid = await createRecommendation(state, { runs: 3 }, async (_state, strategies, _outcomes, _criteria, _target, ids) => ({ ...validReply(state, ids[0], strategies, ids), selection: { choice: "not-feasible", confidence: 0.99, probabilities: { "not-feasible": 1 } } }));
  assert.equal(invalid.recommendation.selectedStrategyId, "baseline-arrival-order");
  assert.equal(invalid.recommendation.decisionSource, "fallback");
  assert.match(invalid.recommendation.fallbackReason, /outside the feasible candidate set/);
  assert.equal(invalid.recommendation.humanReviewRecommended, true);

  const unnormalizedChoice = await createRecommendation(state, { runs: 3 }, async (_state, strategies, _outcomes, _criteria, _target, ids) => {
    const reply = validReply(state, ids[0], strategies, ids);
    reply.selection.probabilities[ids[0]] += 0.1;
    return reply;
  });
  assert.equal(unnormalizedChoice.recommendation.decisionSource, "fallback");
  assert.match(unnormalizedChoice.recommendation.fallbackReason, /invalid strategy confidence or probabilities/);

  const unnormalizedScore = await createRecommendation(state, { runs: 3 }, async (_state, strategies, _outcomes, _criteria, _target, ids) => {
    const reply = validReply(state, ids[0], strategies, ids);
    reply.cargoUrgency.probabilities["3"] -= 0.1;
    return reply;
  });
  assert.equal(unnormalizedScore.recommendation.decisionSource, "fallback");
  assert.match(unnormalizedScore.recommendation.fallbackReason, /invalid qualitative score/);

  const failed = await createRecommendation(state, { runs: 3 }, async () => { throw new Error("provider timeout"); });
  assert.equal(failed.recommendation.selectedStrategyId, "baseline-arrival-order");
  assert.equal(failed.recommendation.aiGenerated, false);
  assert.match(failed.recommendation.warnings.join(" "), /Jev decision failed/);

  const incomplete = await createRecommendation(state, { runs: 3 }, async (_state, strategies, _outcomes, _criteria, _target, ids) => {
    const reply = validReply(state, ids[0], strategies, ids);
    delete reply.selection.confidence;
    return reply;
  });
  assert.equal(incomplete.recommendation.decisionSource, "fallback");
  assert.equal(incomplete.recommendation.jev, null);
});

test("storm example selects a feasible critical-cargo strategy and beats the baseline", async () => {
  const state = scenario();
  const result = await createRecommendation(state, { runs: 40, seed: 42, horizonHours: 36 }, async (_state, strategies, _outcomes, _criteria, _target, ids) => {
    const criticalFirstId = strategies.find((item) => item.scheduling === "critical-first" && ids.includes(item.id))?.id ?? ids[0];
    return validReply(state, criticalFirstId, strategies, ids);
  });
  assert.ok(result.strategies.some((strategy) => strategy.id === result.recommendation.selectedStrategyId));
  assert.equal(result.recommendation.decisionSource, "jev");
  assert.equal(result.recommendation.aiGenerated, true);
  assert.equal(result.recommendation.jev.model, "test-jev");
  assert.deepEqual(result.evaluatedStrategies.find((item) => item.strategy.id === result.recommendation.selectedStrategyId).outcome, result.recommendation.baselineComparison.selected);
  assert.ok(result.recommendation.baselineComparison.selected.mean.criticalCargoOnTimePercent > result.recommendation.baselineComparison.baseline.mean.criticalCargoOnTimePercent);
  assert.equal(result.recommendation.estimatedOutcomes.probabilityOfMeetingTarget, 0.95);
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
  const plan = recoveryPlanForStrategy(strategies[1]);
  assert.deepEqual(copyRecoveryPlan(plan), plan);
  assert.equal(sameRecoveryPlan(plan, recoveryPlanForStrategy(strategies[1])), true);
  assert.equal(sameRecoveryPlan(plan, recoveryPlanForStrategy(strategies[0])), false);

  const controller = new AbortController();
  assert.equal(isLatestScenarioRequest(2, 2, controller, controller), true);
  assert.equal(isLatestScenarioRequest(1, 2, controller, controller), false);
  controller.abort();
  assert.equal(isLatestScenarioRequest(2, 2, controller, controller), false);
});

test("dense fog recommendation and plan evaluation use the same horizon, seed, and baseline", async () => {
  const fog = configureScenarioState(scenario(), SCENARIOS.find((item) => item.id === "fog"), 35);
  const options = { runs: 8, seed: 42, horizonHours: 36 };
  const result = await createRecommendation(fog, options, async (_state, strategies, _outcomes, _criteria, _target, ids) => validReply(fog, strategies.find((item) => ids.includes(item.id) && Object.keys(item.stagingWindowsByVessel).length)?.id ?? ids[0], strategies, ids));
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

test("parameterized plans are validated and use the same seeded baseline simulation", async () => {
  const state = cargoOperationsState();
  const options = { runs: 5, seed: 9, horizonHours: 24 };
  const candidate = generateStrategies(state, options.horizonHours).find((item) => item.stagingWindowsByVessel["vessel-b"]);
  const plan = recoveryPlanForStrategy(candidate);
  const response = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan }),
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.strategy.scheduling, plan.scheduling);
  assert.deepEqual(result.strategy.stagingWindowsByVessel, plan.stagingWindowsByVessel);
  assert.equal(result.outcome.runs, options.runs);
  assert.equal(result.outcome.seed, options.seed);
  assert.equal(result.outcome.horizonHours, options.horizonHours);
  assert.deepEqual(result.baseline, simulateStrategy(state, generateStrategies(state)[0], options));

  const malformed = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan: { ...plan, unsupportedAction: true } }),
  }));
  assert.equal(malformed.status, 400);
  const infeasible = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan: { ...plan, assignments: { ...plan.assignments, "vessel-b": "unknown-port" } } }),
  }));
  assert.equal(infeasible.status, 422);
  assert.match((await infeasible.json()).error, /not feasible/);
  const mismatchedCriteria = await postSimulation(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options, plan, decision: { objective: plan.objective === "balanced" ? "minimize-delay" : "balanced" } }),
  }));
  assert.equal(mismatchedCriteria.status, 400);
  assert.match((await mismatchedCriteria.json()).error, /must match/);
});

test("adaptive disruption replans from the live T+10 checkpoint and preserves cargo and berth progress", async () => {
  const state = cargoOperationsState();
  state.ships[0].cargo[1].deadline = "2026-10-17T08:00:00.000Z";
  state.ports[0].activeDisruptions = [{ id: "storm-60", description: "Storm capacity reduction", severity: 0.6, startHour: 0, durationHours: 18 }];
  const options = { ...cargoOperationsOptions, runs: 3, horizonHours: 36 };
  const initial = generateStrategies(state, options.horizonHours).find((item) => item.id === "baseline-arrival-order");
  const saved = { key: process.env.TYPESAFE_API_KEY, mock: process.env.JEV_MOCK, nodeEnv: process.env.NODE_ENV };
  delete process.env.TYPESAFE_API_KEY;
  process.env.JEV_MOCK = "true";
  process.env.NODE_ENV = "test";
  try {
    const response = await postSimulation(new Request("http://localhost/api/simulate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, options, strategyId: initial.id, adaptive: { atHour: 10, severity: 0.4, durationHours: 12, description: "Unexpected crane failure" } }),
    }));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.adaptive.atHour, 10);
    assert.equal(result.adaptive.event.durationHours, 12);
    assert.equal(result.adaptive.recommendation.decisionSource, "mock");
    assert.equal(result.adaptive.decisionQuality.originalChoice.source, "mock");
    assert.equal(result.adaptive.decisionQuality.status, "accepted");
    assert.notEqual(result.adaptive.decisionQuality.appliedStrategy.strategyId, "continue-current-plan");
    assert.deepEqual(result.adaptive.decisionQuality.comparison.proposedPlan.actions, result.adaptive.availableStrategies.find((item) => item.id === result.adaptive.decisionQuality.originalChoice.strategyId).actions);
    assert.ok(result.adaptive.decisionQuality.comparison.proposedPlan.remainingCriticalCargoOnTimePercent > result.adaptive.decisionQuality.comparison.continueCurrentPlan.remainingCriticalCargoOnTimePercent);
    assert.ok(result.adaptive.availableStrategies.some((item) => item.id === result.adaptive.recommendation.selectedStrategyId));
    const continueCandidate = result.adaptive.availableStrategies.find((item) => item.id === "continue-current-plan");
    assert.ok(continueCandidate, "continuing the existing plan is included for Jev");
    assert.equal(result.adaptive.recommendation.decisionAudit.candidates.find((item) => item.strategyId === continueCandidate.id).selectionEligible, true);
    assert.deepEqual(result.adaptive.decisionQuality.checkpoint.snapshot, result.adaptive.replay.snapshots.find((item) => item.simulationHour === 10));
    assert.equal(result.adaptive.decisionQuality.comparison.continueCurrentPlan.outcome.runs, 1);
    assert.equal(result.adaptive.decisionQuality.comparison.proposedPlan.outcome.runs, 1);
    assert.equal(result.adaptive.decisionQuality.comparison.continueCurrentPlan.feasible, true);
    assert.equal(result.adaptive.decisionQuality.comparison.proposedPlan.feasible, true);
    assert.notDeepEqual(result.adaptive.initialPlanWithoutNewDisruption.mean, result.adaptive.initialPlan.mean, "the crane event's effect is reported separately from the revised strategy");
    assert.equal(result.adaptive.outcome.horizonHours, 36);
    assert.equal(result.adaptive.outcome.runs, 3);
    assert.equal(result.adaptive.replay.snapshots.at(-1).simulationHour, 36);
    assert.deepEqual(
      result.adaptive.replay.snapshots.find((item) => item.simulationHour === 10),
      result.replay.snapshots.find((item) => item.simulationHour === 10),
      "the adaptive replay carries the exact checkpoint from the initial plan",
    );
    const atTen = result.adaptive.replay.snapshots.find((item) => item.simulationHour === 10);
    assert.deepEqual(atTen.ports[0].activeDisruptions.map((item) => item.id), ["storm-60", "adaptive-event-10"]);
    assert.equal(atTen.ports[0].capacityContainersPerHour, 0.24);
    const atSeventeen = result.adaptive.replay.snapshots.find((item) => item.simulationHour === 17);
    assert.deepEqual(atSeventeen.ports[0].activeDisruptions.map((item) => item.id), ["storm-60", "adaptive-event-10"]);
    const atEighteen = result.adaptive.replay.snapshots.find((item) => item.simulationHour === 18);
    assert.deepEqual(atEighteen.ports[0].activeDisruptions.map((item) => item.id), ["adaptive-event-10"]);
    assert.equal(atEighteen.ports[0].capacityContainersPerHour, 0.6);
    const atTwentyTwo = result.adaptive.replay.snapshots.find((item) => item.simulationHour === 22);
    assert.deepEqual(atTwentyTwo.ports[0].activeDisruptions, []);
    assert.equal(atTwentyTwo.ports[0].capacityContainersPerHour, 1);
    assert.ok(atTen.ports[0].berthAssignments.some((item) => item.vesselId === "vessel-a"));
    assert.ok(atTen.ports[0].waitingVesselIds.includes("vessel-b"));
    const partialBatch = atTen.cargoBatches.find((item) => item.batchId === "retail-batch");
    assert.ok(partialBatch.containersUnloaded > 0 && partialBatch.containersRemaining > 0);
    for (let index = 1; index < result.adaptive.replay.snapshots.length; index++) {
      const previous = result.adaptive.replay.snapshots[index - 1];
      const current = result.adaptive.replay.snapshots[index];
      for (const batch of previous.cargoBatches) {
        assert.ok(current.cargoBatches.find((item) => item.batchId === batch.batchId).containersUnloaded >= batch.containersUnloaded);
        if (batch.status === "completed") assert.equal(current.cargoBatches.find((item) => item.batchId === batch.batchId).containersUnloaded, batch.containers);
      }
      assert.ok(current.ports[0].berthAssignments.length <= state.ports[0].availableBerths);
      assert.equal(new Set(current.ports[0].berthAssignments.map((item) => item.berthId)).size, current.ports[0].berthAssignments.length);
    }
    assert.deepEqual(result.adaptive.decisionHistory.map((item) => item.hour), [0, 10]);
    assert.equal(result.adaptive.initialPlan.seed, result.adaptive.outcome.seed);
    assert.equal(result.adaptive.noIntervention.seed, result.adaptive.outcome.seed);
    assert.equal(result.adaptive.noIntervention.runs, result.adaptive.outcome.runs);
    assert.equal(result.adaptive.initialPlan.runs, result.adaptive.outcome.runs);
    assert.equal(result.adaptive.noIntervention.horizonHours, result.adaptive.initialPlan.horizonHours);
    assert.equal(result.adaptive.initialPlanWithoutNewDisruption.seed, result.adaptive.initialPlan.seed);

    const repeatResponse = await postSimulation(new Request("http://localhost/api/simulate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, options, strategyId: initial.id, adaptive: { atHour: 10, severity: 0.4, durationHours: 12, description: "Unexpected crane failure" } }),
    }));
    const repeat = await repeatResponse.json();
    assert.deepEqual(repeat.adaptive.outcome, result.adaptive.outcome);
    assert.deepEqual(repeat.adaptive.replay, result.adaptive.replay);

    const invalid = await postSimulation(new Request("http://localhost/api/simulate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, options, strategyId: initial.id, adaptive: { atHour: 10, severity: 1.2, durationHours: 26, description: "bad event" } }),
    }));
    assert.equal(invalid.status, 400);
  } finally {
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved.key;
    if (saved.mock === undefined) delete process.env.JEV_MOCK;
    else process.env.JEV_MOCK = saved.mock;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
});

test("adaptive quality accepts improvements, rejects dominated outcomes, and keeps the current plan for equivalent outcomes", () => {
  const outcome = (critical, delay, cost, processed = 10, targetProbability = 0.5, delayedVessels = 0) => ({
    mean: { criticalCargoOnTimePercent: critical, averageCargoDelayHours: delay, totalContainersProcessed: processed, delayedVessels, estimatedDisruptionCost: cost },
    probabilityOfMeetingTarget: targetProbability,
  });
  const criteria = { objective: "balanced" };
  const improved = assessAdaptivePlanQuality(outcome(80, 4, 800), outcome(60, 8, 1000), criteria, 50);
  assert.equal(improved.applyProposed, true);
  assert.equal(improved.status, "accepted");

  const dominated = assessAdaptivePlanQuality(outcome(50, 12, 1200, 10, 0.4), outcome(60, 8, 1000, 11, 0.6), criteria, 40);
  assert.equal(dominated.applyProposed, false);
  assert.equal(dominated.status, "rejected-dominated");

  const equivalent = assessAdaptivePlanQuality(outcome(60, 8, 1000), outcome(60, 8, 1000), criteria, 50);
  assert.equal(equivalent.applyProposed, false);
  assert.equal(equivalent.status, "equivalent");

  const violatesTarget = assessAdaptivePlanQuality(outcome(40, 4, 800), outcome(60, 8, 1000), criteria, 50);
  assert.equal(violatesTarget.applyProposed, false);
  assert.equal(violatesTarget.status, "rejected-constraints");
  assert.match(violatesTarget.explanation, /mandatory constraints/);

  const violatesCost = assessAdaptivePlanQuality(outcome(60, 4, 1200), outcome(55, 8, 1000), { ...criteria, maximumDisruptionCost: 1100 }, 50);
  assert.equal(violatesCost.applyProposed, false);
  assert.equal(violatesCost.status, "rejected-constraints");

  const processedGain = assessAdaptivePlanQuality(outcome(60, 8, 1000, 9), outcome(60, 8, 1000, 10), criteria, 50);
  assert.equal(processedGain.applyProposed, false);
  assert.equal(processedGain.status, "rejected-dominated");
  const proposalProcessesMore = assessAdaptivePlanQuality(outcome(60, 8, 1000, 11), outcome(60, 8, 1000, 10), criteria, 50);
  assert.equal(proposalProcessesMore.applyProposed, true);
  assert.equal(proposalProcessesMore.status, "accepted");
  const probabilityImproves = assessAdaptivePlanQuality(outcome(60, 8, 1000, 10, 0.8), outcome(60, 8, 1000, 10, 0.5), criteria, 50);
  assert.equal(probabilityImproves.applyProposed, true);
});

test("adaptive Jev keeps the current plan when a zero-capacity proposal has equivalent outcomes", async () => {
  const state = scenario();
  state.ports[0].activeDisruptions = [];
  state.ports[0].currentCapacityContainersPerDay = 0;
  state.ports[0].availableBerths = 1;
  state.ports[0].unloadingResources = 0;
  state.weather = [];
  const strategy = generateStrategies(state, 24)[0];
  const saved = { key: process.env.TYPESAFE_API_KEY, mock: process.env.JEV_MOCK, nodeEnv: process.env.NODE_ENV };
  delete process.env.TYPESAFE_API_KEY;
  process.env.JEV_MOCK = "true";
  process.env.NODE_ENV = "test";
  try {
    const response = await postSimulation(new Request("http://localhost/api/simulate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state,
        options: { runs: 2, seed: 42, horizonHours: 24, criticalCargoOnTimeTargetPercent: 0, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, weatherSeverityVariation: 0, equipmentFailureProbability: 0 },
        strategyId: strategy.id,
        adaptive: { atHour: 10, severity: 0.5, durationHours: 6, description: "Unexpected crane failure" },
      }),
    }));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.adaptive.recommendation.decisionSource, "mock");
    assert.equal(result.adaptive.decisionQuality.status, "equivalent");
    assert.notEqual(result.adaptive.decisionQuality.originalChoice.strategyId, "continue-current-plan");
    assert.equal(result.adaptive.decisionQuality.appliedStrategy.strategyId, "continue-current-plan");
    assert.equal(result.adaptive.outcome.mean.totalContainersProcessed, 0);
    assert.deepEqual(result.adaptive.decisionQuality.checkpoint.snapshot, result.adaptive.replay.snapshots.find((item) => item.simulationHour === 10));
  } finally {
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved.key;
    if (saved.mock === undefined) delete process.env.JEV_MOCK;
    else process.env.JEV_MOCK = saved.mock;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
});

test("initial recommendation and adaptive evaluation use the same future disruption inputs", async () => {
  const state = cargoOperationsState();
  state.ports[0].activeDisruptions = [{ id: "storm-18", description: "Storm capacity reduction", severity: 0.6, startHour: 0, durationHours: 18 }];
  const craneFailure = { id: "adaptive-event-10", description: "Unexpected crane failure", severity: 0.4, startHour: 10, durationHours: 12 };
  const recommendationState = {
    ...state,
    ports: state.ports.map((port) => ({ ...port, activeDisruptions: [...port.activeDisruptions, craneFailure] })),
  };
  const options = { ...cargoOperationsOptions, runs: 2, horizonHours: 36 };
  const saved = { key: process.env.TYPESAFE_API_KEY, mock: process.env.JEV_MOCK, nodeEnv: process.env.NODE_ENV };
  delete process.env.TYPESAFE_API_KEY;
  process.env.JEV_MOCK = "true";
  process.env.NODE_ENV = "test";
  try {
    const recommendationResponse = await postRecommendation(new Request("http://localhost/api/recommendation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: recommendationState, options, decision: { objective: "balanced" } }),
    }));
    const recommendation = await recommendationResponse.json();
    assert.equal(recommendationResponse.status, 200, JSON.stringify(recommendation));
    assert.equal(recommendation.recommendation.decisionSource, "mock");
    const selected = recommendation.availableStrategies.find((item) => item.id === recommendation.recommendation.selectedStrategyId);
    const plan = recoveryPlanForStrategy(selected);
    const simulationResponse = await postSimulation(new Request("http://localhost/api/simulate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state, options, decision: { objective: plan.objective }, strategyId: selected.id,
        adaptive: { atHour: 10, severity: 0.4, durationHours: 12, description: "Unexpected crane failure" },
      }),
    }));
    const simulation = await simulationResponse.json();
    assert.equal(simulationResponse.status, 200, JSON.stringify(simulation));
    assert.deepEqual(simulation.adaptive.initialPlan.mean, recommendation.recommendation.estimatedOutcomes.mean);
    assert.deepEqual(simulation.adaptive.noIntervention.mean, recommendation.recommendation.baselineComparison.baseline.mean);
  } finally {
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved.key;
    if (saved.mock === undefined) delete process.env.JEV_MOCK;
    else process.env.JEV_MOCK = saved.mock;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
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
  const basePlan = recoveryPlanForStrategy(baseline);
  const staged = generateStrategyForPlan(state, { ...basePlan, stagingWindowsByVessel: { [state.ships[0].vesselId]: { startHour: 0, durationHours: 12 } } }, 72);
  assert.ok(staged);
  const baselineOutcome = simulateStrategy(state, baseline, { runs: 20, seed: 42, horizonHours: 72 });
  const staggerOutcome = simulateStrategy(state, staged, { runs: 20, seed: 42, horizonHours: 72 });
  assert.ok(staggerOutcome.mean.averageCargoDelayHours > baselineOutcome.mean.averageCargoDelayHours);
  assert.ok(staggerOutcome.mean.totalContainersProcessed < baselineOutcome.mean.totalContainersProcessed);
});

test("scenario and strategy API routes expose the example and reject bad input", async () => {
  const response = await getScenario();
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.provenance.weather, "synthetic");

  const list = await postStrategies(new Request("http://localhost/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, options: { runs: 5, criticalCargoOnTimeTargetPercent: 65 }, decision: { objective: "minimize-cost", maximumDisruptionCost: 25_000 } }) }));
  const listed = await list.json();
  assert.equal(list.status, 200);
  assert.ok(listed.strategies.length >= 4);
  assert.ok(listed.strategies.every((strategy) => isRecoveryPlan(recoveryPlanForStrategy(strategy))));
  assert.ok(listed.strategies.every((strategy) => strategy.objective === "minimize-cost" && strategy.minimumCriticalCargoOnTimePercent === 65 && strategy.maximumDisruptionCost === 25_000));
  const simulation = await postSimulation(new Request("http://localhost/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, strategyId: listed.strategies[0].id, options: { runs: 5 } }) }));
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

test("recommendation route validates operator objectives and cost limits", async () => {
  const state = scenario();
  const invalidObjective = await postRecommendation(new Request("http://localhost/api/recommendation", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, decision: { objective: "random" } }),
  }));
  const invalidCost = await postRecommendation(new Request("http://localhost/api/recommendation", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, decision: { objective: "minimize-cost", maximumDisruptionCost: -1 } }),
  }));
  const invalidRerouteCost = await postStrategies(new Request("http://localhost/api/strategies", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: { ...state, ports: state.ports.map((port) => ({ ...port, rerouteCostPerContainer: -1 })) } }),
  }));
  assert.equal(invalidObjective.status, 400);
  assert.equal(invalidCost.status, 400);
  assert.equal(invalidRerouteCost.status, 400);
});
