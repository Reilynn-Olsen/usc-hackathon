import { assertReplayBudget, assertSimulationBudget, DEFAULT_SIMULATION_OPTIONS, generateStrategies, generateStrategyForPlan, isRecoveryPlan, remainingStateAtCheckpoint, SimulationBudgetError, simulateAdaptiveStrategyWithReplay, simulateFromCheckpoint, simulateStrategyWithReplay, simulateToCheckpoint } from "../../../lib/harbormind/simulation.ts";
import { readDecisionCriteria, readHarnessRequest } from "../../../lib/harbormind/http.ts";
import { assessAdaptivePlanQuality, createRecommendation, validateStrategySelection } from "../../../lib/harbormind/decision.ts";
import type { PortDisruption, SimulationReplay } from "../../../lib/harbormind/types.ts";

export async function POST(request: Request) {
  const parsed = await readHarnessRequest(request);
  if (!parsed.value) return parsed.response!;
  const { state, options, body } = parsed.value;
  const hasPlan = Object.hasOwn(body, "plan");
  const hasStrategyId = Object.hasOwn(body, "strategyId");
  if (hasPlan === hasStrategyId) return Response.json({ error: "Provide exactly one of plan or strategyId." }, { status: 400 });
  const plan = hasPlan && isRecoveryPlan(body.plan) ? body.plan : undefined;
  if (hasPlan && !plan) return Response.json({ error: "plan must contain supported scheduling, staging, cargo priority, capacity, assignment, and objective fields." }, { status: 400 });
  const defaultDecision = {
    objective: plan?.objective ?? "balanced",
    ...(plan?.maximumDisruptionCost === null || plan?.maximumDisruptionCost === undefined ? {} : { maximumDisruptionCost: plan.maximumDisruptionCost }),
  };
  const { criteria: decision, error: decisionError } = readDecisionCriteria(body.decision, defaultDecision);
  if (!decision) return Response.json({ error: decisionError }, { status: 400 });
  if (plan && (decision.objective !== plan.objective || decision.maximumDisruptionCost !== (plan.maximumDisruptionCost ?? undefined))) {
    return Response.json({ error: "decision criteria must match the objective and cost ceiling in plan." }, { status: 400 });
  }
  const simulationOptions = { ...DEFAULT_SIMULATION_OPTIONS, ...options, ...(plan ? { criticalCargoOnTimeTargetPercent: plan.minimumCriticalCargoOnTimePercent } : {}) };
  const adaptiveInput = body.adaptive;
  if (adaptiveInput !== undefined && (!adaptiveInput || typeof adaptiveInput !== "object" || Array.isArray(adaptiveInput))) {
    return Response.json({ error: "adaptive must define a timed disruption event." }, { status: 400 });
  }
  let eventState = state;
  let adaptiveEvent: { atHour: number; disruption: PortDisruption; portId: string } | null = null;
  if (adaptiveInput !== undefined) {
    const event = adaptiveInput as Record<string, unknown>;
    if (Object.keys(event).some((key) => !["atHour", "severity", "durationHours", "description", "portId"].includes(key))
      || typeof event.atHour !== "number" || !Number.isInteger(event.atHour) || event.atHour <= 0 || event.atHour >= simulationOptions.horizonHours || event.atHour % simulationOptions.timeStepHours !== 0
      || typeof event.severity !== "number" || !Number.isFinite(event.severity) || event.severity <= 0 || event.severity > 1
      || typeof event.durationHours !== "number" || !Number.isInteger(event.durationHours) || event.durationHours < 1 || event.atHour + event.durationHours > simulationOptions.horizonHours
      || typeof event.description !== "string" || !event.description.trim() || event.description.length > 120
      || (event.portId !== undefined && (typeof event.portId !== "string" || !state.ports.some((port) => port.portId === event.portId)))) {
      return Response.json({ error: "adaptive must contain a valid event hour, severity, duration, short description, and optional modeled portId." }, { status: 400 });
    }
    const atHour = event.atHour;
    const disruption: PortDisruption = {
      id: `adaptive-event-${atHour}`,
      description: event.description.trim(),
      severity: event.severity,
      startHour: atHour,
      durationHours: event.durationHours,
    };
    const portId = typeof event.portId === "string" ? event.portId : state.ports[0].portId;
    eventState = {
      ...state,
      ports: state.ports.map((port) => ({ ...port, activeDisruptions: port.portId === portId ? [...port.activeDisruptions, disruption] : port.activeDisruptions })),
    };
    adaptiveEvent = { atHour, disruption, portId };
  }
  const strategies = generateStrategies(eventState, simulationOptions.horizonHours, decision, simulationOptions.criticalCargoOnTimeTargetPercent);
  const strategy = plan
    ? generateStrategyForPlan(state, plan, simulationOptions.horizonHours)
    : validateStrategySelection(body.strategyId, strategies);
  if (!strategy) return Response.json({ error: hasPlan ? "The recovery plan is not feasible for this simulation state." : "strategyId must identify a feasible strategy for this simulation state." }, { status: 422 });
  const baseline = strategies.find((item) => item.id === "baseline-arrival-order")!;
  try {
    assertSimulationBudget(state, simulationOptions, strategy.id === baseline.id ? 1 : 2);
    assertReplayBudget(state, simulationOptions, strategy.id === baseline.id ? 1 : 2);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Simulation request is too large." }, { status: 400 });
  }
  if (adaptiveEvent) {
    try {
      assertSimulationBudget(state, simulationOptions, 4);
      assertReplayBudget(state, simulationOptions, 4);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Adaptive simulation request is too large." }, { status: 400 });
    }
    const { atHour, disruption, portId: affectedPortId } = adaptiveEvent;
    const adaptiveOptions = { ...simulationOptions, criticalCargoOnTimeTargetPercent: plan?.minimumCriticalCargoOnTimePercent ?? simulationOptions.criticalCargoOnTimeTargetPercent };
    const noIntervention = simulateStrategyWithReplay(eventState, baseline, adaptiveOptions);
    const initialPlan = strategy.id === baseline.id ? noIntervention : simulateStrategyWithReplay(eventState, strategy, adaptiveOptions);
    const initialPlanWithoutNewDisruption = simulateStrategyWithReplay(state, strategy, adaptiveOptions);
    const checkpoint = simulateToCheckpoint(eventState, strategy, adaptiveOptions, atHour);
    const replanningState = remainingStateAtCheckpoint(eventState, checkpoint);
    if (!replanningState.ships.length) return Response.json({ error: "No remaining cargo or eligible vessels are available at the replanning hour." }, { status: 422 });
    const remainingOptions = { ...adaptiveOptions, runs: 1, horizonHours: adaptiveOptions.horizonHours - atHour };
    const remainingCriticalContainers = checkpoint.jobs.reduce((sum, job) => sum + job.cargo.reduce((cargoSum, item) => cargoSum + (item.cargo.essential ? item.cargo.containers - item.containersUnloaded : 0), 0), 0);
    const remainingCriticalOnTimePercent = (replay: SimulationReplay) => {
      if (remainingCriticalContainers === 0) return 100;
      let deliveredOnTime = 0;
      for (let index = 1; index < replay.snapshots.length; index++) {
        const previous = replay.snapshots[index - 1];
        const current = replay.snapshots[index];
        if (current.simulationHour <= checkpoint.hour) continue;
        for (const batch of current.cargoBatches) {
          if (batch.criticality !== "critical") continue;
          const prior = previous.cargoBatches.find((item) => item.batchId === batch.batchId);
          const newlyUnloaded = batch.containersUnloaded - (prior?.containersUnloaded ?? 0);
          const deadlineHour = (Date.parse(batch.deadline) - Date.parse(state.startAt)) / 3_600_000;
          if (newlyUnloaded > 0 && current.simulationHour <= deadlineHour) deliveredOnTime += newlyUnloaded;
        }
      }
      return Math.round(10000 * deliveredOnTime / remainingCriticalContainers) / 100;
    };
    const remainingVesselIds = new Set(replanningState.ships.map((ship) => ship.vesselId));
    const remainingCargoIds = new Set(replanningState.ships.flatMap((ship) => ship.cargo.map((cargo) => cargo.cargoId)));
    const continueId = "continue-current-plan";
    const continueCurrentPlan: typeof strategy = {
      ...strategy,
      id: continueId,
      name: "Continue current recovery plan",
      summary: "Keep the current schedule, staging, cargo priorities, reservations, and assignments for remaining operations.",
      assignments: Object.fromEntries(replanningState.ships.map((ship) => [ship.vesselId, strategy.assignments[ship.vesselId]])),
      stagingWindowsByVessel: Object.fromEntries(Object.entries(strategy.stagingWindowsByVessel).filter(([id]) => remainingVesselIds.has(id))),
      cargoPrioritiesByBatch: Object.fromEntries(Object.entries(strategy.cargoPrioritiesByBatch).filter(([id]) => remainingCargoIds.has(id))),
      actions: strategy.actions
        .filter((action) => "vesselId" in action ? remainingVesselIds.has(action.vesselId)
          : action.type === "cargo-priority" ? remainingCargoIds.has(action.cargoId)
            : action.type === "prioritize" ? action.vesselIds.some((id) => remainingVesselIds.has(id)) : true)
        .map((action) => action.type === "prioritize" ? { ...action, vesselIds: action.vesselIds.filter((id) => remainingVesselIds.has(id)) } : action),
    };
    let recommendation: Awaited<ReturnType<typeof createRecommendation>>;
    const exactRemainingDelivery = new Map<string, number>();
    try {
      recommendation = await createRecommendation(
        replanningState,
        remainingOptions,
        undefined,
        decision,
        (candidates) => {
          assertSimulationBudget(state, { ...adaptiveOptions, runs: 1 }, candidates.length);
          return new Map(candidates.map((candidate) => {
            const evaluation = candidate.id === continueId
              ? simulateFromCheckpoint(eventState, strategy, adaptiveOptions, checkpoint, true)
              : simulateFromCheckpoint(eventState, candidate, adaptiveOptions, checkpoint);
            exactRemainingDelivery.set(candidate.id, remainingCriticalOnTimePercent(evaluation.replay));
            return [candidate.id, evaluation.summary] as const;
          }));
        },
        [continueCurrentPlan],
        true,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not evaluate the adaptive plan.";
      return Response.json({ error: message }, { status: error instanceof SimulationBudgetError ? 400 : message.startsWith("No feasible recovery strategy") ? 422 : 500 });
    }
    const appliedRecommendationStrategy = recommendation.strategies.find((item) => item.id === recommendation.recommendation.selectedStrategyId);
    const jevStrategy = recommendation.strategies.find((item) => item.id === recommendation.recommendation.jev?.selection.strategyId) ?? appliedRecommendationStrategy;
    if (!jevStrategy) return Response.json({ error: "Jev did not select a validated replanning candidate." }, { status: 502 });
    const jevOutcome = recommendation.evaluatedStrategies.find((item) => item.strategy.id === jevStrategy.id)?.outcome;
    if (!jevOutcome) return Response.json({ error: "Jev's selected replanning candidate has no checkpoint evaluation." }, { status: 500 });
    const continuationOutcome = recommendation.evaluatedStrategies.find((item) => item.strategy.id === continueId)?.outcome;
    const continueRemainingDelivery = exactRemainingDelivery.get(continueId);
    const proposedRemainingDelivery = exactRemainingDelivery.get(jevStrategy.id);
    if (!continuationOutcome || continueRemainingDelivery === undefined || proposedRemainingDelivery === undefined) return Response.json({ error: "The current and selected recovery plans could not be compared from the checkpoint." }, { status: 500 });
    const continueWasSelected = jevStrategy.id === continueId;
    const rawQuality = continueWasSelected
      ? { applyProposed: false, status: "continuation-selected" as const, explanation: "Jev selected continuing the current plan; no operational parameters were changed." }
      : assessAdaptivePlanQuality(jevOutcome, continuationOutcome, decision, adaptiveOptions.criticalCargoOnTimeTargetPercent);
    const overridden = !continueWasSelected && !rawQuality.applyProposed;
    const appliedStrategy = rawQuality.applyProposed ? jevStrategy : continueCurrentPlan;
    const adaptiveRunStrategy = rawQuality.applyProposed ? jevStrategy : strategy;
    const adaptivePlan = simulateAdaptiveStrategyWithReplay(eventState, strategy, adaptiveRunStrategy, adaptiveOptions, atHour, checkpoint, !rawQuality.applyProposed);
    const meetsConstraints = (outcome: typeof continuationOutcome) => outcome.mean.criticalCargoOnTimePercent >= adaptiveOptions.criticalCargoOnTimeTargetPercent
      && (decision.maximumDisruptionCost === undefined || outcome.mean.estimatedDisruptionCost !== null && outcome.mean.estimatedDisruptionCost <= decision.maximumDisruptionCost);
    const decisionQuality = {
      originalChoice: { strategyId: jevStrategy.id, strategyName: jevStrategy.name, source: recommendation.recommendation.decisionSource },
      appliedStrategy: { strategyId: appliedStrategy.id, strategyName: appliedStrategy.name },
      overridden,
      status: rawQuality.status,
      explanation: rawQuality.explanation,
      checkpoint: { hour: checkpoint.hour, snapshot: checkpoint.snapshots?.find((snapshot) => snapshot.simulationHour === checkpoint.hour) ?? null },
      comparison: {
        continueCurrentPlan: { strategyId: continueId, strategyName: continueCurrentPlan.name, actions: continueCurrentPlan.actions, outcome: continuationOutcome, remainingCriticalCargoOnTimePercent: continueRemainingDelivery, feasible: true, meetsMandatoryConstraints: meetsConstraints(continuationOutcome) },
        proposedPlan: { strategyId: jevStrategy.id, strategyName: jevStrategy.name, actions: jevStrategy.actions, outcome: jevOutcome, remainingCriticalCargoOnTimePercent: proposedRemainingDelivery, feasible: true, meetsMandatoryConstraints: meetsConstraints(jevOutcome) },
      },
    };
    const changedParameters = [
      ...(strategy.scheduling !== adaptiveRunStrategy.scheduling ? [`Scheduling: ${strategy.scheduling} → ${adaptiveRunStrategy.scheduling}`] : []),
      ...[...new Set([...Object.keys(strategy.stagingWindowsByVessel), ...Object.keys(adaptiveRunStrategy.stagingWindowsByVessel)])].filter((id) => JSON.stringify(strategy.stagingWindowsByVessel[id] ?? null) !== JSON.stringify(adaptiveRunStrategy.stagingWindowsByVessel[id] ?? null)).map((id) => {
        const window = adaptiveRunStrategy.stagingWindowsByVessel[id];
        return window ? `Stage ${id} from T+${atHour + window.startHour}h for ${window.durationHours}h` : `Remove future staging for ${id}`;
      }),
      ...[...new Set([...Object.keys(strategy.cargoPrioritiesByBatch), ...Object.keys(adaptiveRunStrategy.cargoPrioritiesByBatch)])].filter((id) => strategy.cargoPrioritiesByBatch[id] !== adaptiveRunStrategy.cargoPrioritiesByBatch[id]).map((id) => `Cargo batch ${id} priority ${adaptiveRunStrategy.cargoPrioritiesByBatch[id] ?? "reset to default"}`),
      ...Object.entries(adaptiveRunStrategy.assignments).filter(([id, portId]) => strategy.assignments[id] !== portId).map(([id, portId]) => `Assign ${id} to ${portId}`),
      ...(strategy.reserveBerthForCriticalCargo !== adaptiveRunStrategy.reserveBerthForCriticalCargo ? [adaptiveRunStrategy.reserveBerthForCriticalCargo ? "Reserve a berth for critical cargo" : "Release the critical-cargo berth reservation"] : []),
      ...(JSON.stringify(adaptiveRunStrategy.criticalCapacityReservation) !== JSON.stringify(strategy.criticalCapacityReservation) ? [adaptiveRunStrategy.criticalCapacityReservation ? `Reserve ${adaptiveRunStrategy.criticalCapacityReservation.percent}% critical throughput during the replanning window` : "Remove the critical-throughput reservation"] : []),
    ];
    const decisionHistory = [
      { hour: 0, strategyId: strategy.id, strategyName: strategy.name, decisionSource: "initial" as const, changedParameters: strategy.actions.map((action) => action.type), measuredOutcome: initialPlan.summary.mean },
      { hour: atHour, strategyId: appliedStrategy.id, strategyName: appliedStrategy.name, decisionSource: overridden ? "system-safeguard" : recommendation.recommendation.decisionSource, changedParameters, measuredOutcome: adaptivePlan.summary.mean },
    ];
    return Response.json({
      scenarioId: state.scenarioId,
      strategyId: strategy.id,
      strategy,
      outcome: initialPlan.summary,
      baseline: noIntervention.summary,
      replay: initialPlan.replay,
      baselineReplay: noIntervention.replay,
      criticalCargoOnTimeChangePercent: Math.round((initialPlan.summary.mean.criticalCargoOnTimePercent - noIntervention.summary.mean.criticalCargoOnTimePercent) * 100) / 100,
      adaptive: {
        atHour,
        event: { ...disruption, portId: affectedPortId },
        noIntervention: noIntervention.summary,
        initialPlan: initialPlan.summary,
        initialPlanWithoutNewDisruption: initialPlanWithoutNewDisruption.summary,
        outcome: adaptivePlan.summary,
        replay: adaptivePlan.replay,
        recommendation: recommendation.recommendation,
        decisionQuality,
        availableStrategies: recommendation.strategies,
        evaluatedStrategies: recommendation.evaluatedStrategies,
        decisionHistory,
      },
      dataProvenance: state.provenance,
      humanApprovalRequired: true,
    });
  }
  const baselineResult = simulateStrategyWithReplay(state, baseline, simulationOptions);
  const selectedResult = strategy.id === baseline.id ? baselineResult : simulateStrategyWithReplay(state, strategy, simulationOptions);
  const { summary: outcome, replay } = selectedResult;
  const baselineOutcome = baselineResult.summary;
  return Response.json({
    scenarioId: state.scenarioId,
    strategyId: strategy.id,
    strategy,
    outcome,
    baseline: baselineOutcome,
    replay,
    baselineReplay: baselineResult.replay,
    criticalCargoOnTimeChangePercent: Math.round((outcome.mean.criticalCargoOnTimePercent - baselineOutcome.mean.criticalCargoOnTimePercent) * 100) / 100,
    dataProvenance: state.provenance,
    humanApprovalRequired: true,
  });
}
