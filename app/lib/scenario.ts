import type { OperationalSnapshot, RecoveryPlan, RecoveryStrategy, SimulationReplay, SimulationState } from "../../lib/harbormind/types.ts";
import type { Scenario, ScenarioId } from "./data.ts";

export function configureScenarioState(state: SimulationState, scenario: Scenario, capacityLoss: number, durationHours = 18): SimulationState {
  const isStorm = scenario.id === "storm";
  return {
    ...state,
    scenarioId: scenario.id,
    ports: state.ports.map((port) => ({
      ...port,
      activeDisruptions: [{ id: `${scenario.id}-capacity-loss`, description: `${scenario.label}: ${scenario.description}`, severity: capacityLoss / 100, startHour: 0, durationHours }],
    })),
    ...(isStorm ? {} : {
      weather: [],
      provenance: { ...state.provenance, weather: "unavailable" as const, weatherAlerts: "unavailable" as const },
    }),
  };
}

export function replayForMode(mode: "baseline" | "recovery", baseline?: SimulationReplay, recovery?: SimulationReplay): SimulationReplay | null {
  return mode === "baseline" ? baseline ?? null : recovery ?? null;
}

export function snapshotAtHour(replay: SimulationReplay | null | undefined, hour: number): OperationalSnapshot | null {
  const snapshots = replay?.snapshots;
  if (!snapshots?.length) return null;
  let selected = snapshots[0];
  for (const snapshot of snapshots) {
    if (snapshot.simulationHour > hour) break;
    selected = snapshot;
  }
  return selected;
}

export function recoveryPlanForStrategy(strategy: RecoveryStrategy): RecoveryPlan {
  return {
    scheduling: strategy.scheduling,
    stagingWindowsByVessel: { ...strategy.stagingWindowsByVessel },
    cargoPrioritiesByBatch: { ...strategy.cargoPrioritiesByBatch },
    reserveBerthForCriticalCargo: strategy.reserveBerthForCriticalCargo,
    criticalCapacityReservation: strategy.criticalCapacityReservation ? { ...strategy.criticalCapacityReservation } : null,
    assignments: { ...strategy.assignments },
    objective: strategy.objective,
    minimumCriticalCargoOnTimePercent: strategy.minimumCriticalCargoOnTimePercent,
    maximumDisruptionCost: strategy.maximumDisruptionCost,
  };
}

export function copyRecoveryPlan(plan: RecoveryPlan): RecoveryPlan {
  return {
    ...plan,
    stagingWindowsByVessel: Object.fromEntries(Object.entries(plan.stagingWindowsByVessel).map(([id, window]) => [id, { ...window }])),
    cargoPrioritiesByBatch: { ...plan.cargoPrioritiesByBatch },
    criticalCapacityReservation: plan.criticalCapacityReservation ? { ...plan.criticalCapacityReservation } : null,
    assignments: { ...plan.assignments },
  };
}

export function sameRecoveryPlan(left: RecoveryPlan | null, right: RecoveryPlan | null): boolean {
  if (!left || !right) return left === right;
  const sorted = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const signature = (plan: RecoveryPlan) => JSON.stringify([
    plan.scheduling, sorted(plan.stagingWindowsByVessel), sorted(plan.cargoPrioritiesByBatch), plan.reserveBerthForCriticalCargo,
    plan.criticalCapacityReservation, sorted(plan.assignments), plan.objective, plan.minimumCriticalCargoOnTimePercent, plan.maximumDisruptionCost,
  ]);
  return signature(left) === signature(right);
}

export function scenarioSignature(id: ScenarioId, capacityLoss: number, duration: number): string {
  return `${id}:${capacityLoss}:${duration}`;
}

export function isLatestScenarioRequest(id: number, latestId: number, controller: AbortController, activeController: AbortController | null): boolean {
  return id === latestId && controller === activeController && !controller.signal.aborted;
}
