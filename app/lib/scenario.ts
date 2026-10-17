import type { RecoveryPlanSelection, RecoveryStrategy, SimulationState } from "../../lib/harbormind/types.ts";
import type { ActionId, ActionState, Scenario, ScenarioId } from "./data.ts";

export function configureScenarioState(state: SimulationState, scenario: Scenario, capacityLoss: number): SimulationState {
  const isStorm = scenario.id === "storm";
  return {
    ...state,
    scenarioId: scenario.id,
    ports: state.ports.map((port) => ({
      ...port,
      currentCapacityContainersPerDay: port.normalCapacityContainersPerDay * (1 - capacityLoss / 100),
      activeDisruptions: [{ id: `${scenario.id}-capacity-loss`, description: `${scenario.label}: ${scenario.description}`, severity: capacityLoss / 100 }],
    })),
    ...(isStorm ? {} : {
      weather: [],
      provenance: { ...state.provenance, weather: "unavailable" as const, weatherAlerts: "unavailable" as const },
    }),
  };
}

export function actionSelectionForStrategy(strategy: RecoveryStrategy): ActionState {
  return {
    critical: strategy.scheduling === "critical-first",
    stagger: strategy.holdNonessentialHours > 0,
    trucks: strategy.resourceMode === "dedicated-priority",
    divert: strategy.actions.some((action) => action.type === "reroute"),
  };
}

export function planSelectionForActions(actions: ActionState): RecoveryPlanSelection {
  return {
    prioritizeCriticalCargo: actions.critical,
    staggerLowerPriorityVessels: actions.stagger,
    reserveCapacityForCriticalCargo: actions.trucks,
    divertStandardShipment: actions.divert,
  };
}

export function toggleAction(actions: ActionState, id: ActionId, checked: boolean): ActionState {
  const next = { ...actions, [id]: checked };
  if (id === "trucks" && checked) next.critical = true;
  if (id === "critical" && !checked) next.trucks = false;
  return next;
}

export function availableActionsForStrategies(strategies: RecoveryStrategy[]): ActionState {
  return {
    critical: strategies.some((strategy) => strategy.scheduling === "critical-first"),
    stagger: strategies.some((strategy) => strategy.holdNonessentialHours > 0),
    trucks: strategies.some((strategy) => strategy.resourceMode === "dedicated-priority"),
    divert: strategies.some((strategy) => strategy.actions.some((action) => action.type === "reroute")),
  };
}

export function scenarioSignature(id: ScenarioId, capacityLoss: number, duration: number): string {
  return `${id}:${capacityLoss}:${duration}`;
}

export function isLatestScenarioRequest(id: number, latestId: number, controller: AbortController, activeController: AbortController | null): boolean {
  return id === latestId && controller === activeController && !controller.signal.aborted;
}
