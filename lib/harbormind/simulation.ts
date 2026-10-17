import type { OutcomeMetrics, RecoveryStrategy, Ship, SimulationOptions, SimulationState, SimulationSummary, StrategyAction } from "./types.ts";

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  runs: 40,
  seed: 42,
  horizonHours: 72,
  maxArrivalDelayHours: 4,
  weatherSeverityVariation: 0.15,
  capacityReductionVariation: 0.15,
  unloadingTimeVariation: 0.2,
  equipmentFailureProbability: 0.1,
  criticalCargoOnTimeTargetPercent: 80,
};

const MAX_SIMULATION_WORK = 25_000_000;
export class SimulationBudgetError extends Error {}

export function assertSimulationBudget(state: SimulationState, options: SimulationOptions, strategyCount: number): void {
  const estimatedWork = state.ships.length * Math.ceil(options.horizonHours * 4) * options.runs * strategyCount;
  if (estimatedWork > MAX_SIMULATION_WORK) throw new SimulationBudgetError("Simulation request is too large; reduce runs, horizonHours, or the number of ships.");
}

const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const containersFor = (ship: Ship) => ship.cargo.reduce((sum, cargo) => sum + cargo.containers, 0);
const hasCriticalCargo = (ship: Ship) => ship.cargo.some((cargo) => cargo.essential);
const isNonessential = (ship: Ship) => ship.cargo.every((cargo) => !cargo.essential);

function criticalPriority(state: SimulationState, left: Ship, right: Ship): number {
  const criticalVolume = (ship: Ship) => ship.cargo.reduce((sum, cargo) => sum + (cargo.essential ? cargo.containers : 0), 0);
  const deadline = (ship: Ship) => Math.min(...ship.cargo.filter((cargo) => cargo.essential).map((cargo) => Date.parse(cargo.deadline)), Infinity);
  const deadlineDifference = deadline(left) - deadline(right);
  if (deadlineDifference) return deadlineDifference;
  const volumeDifference = criticalVolume(right) - criticalVolume(left);
  if (volumeDifference) return volumeDifference;
  return Date.parse(left.estimatedArrival) - Date.parse(right.estimatedArrival) || state.ships.indexOf(left) - state.ships.indexOf(right);
}

function orderFor(state: SimulationState, scheduling: RecoveryStrategy["scheduling"]): Ship[] {
  return [...state.ships].sort(scheduling === "arrival-order"
    ? (left, right) => Date.parse(left.estimatedArrival) - Date.parse(right.estimatedArrival) || state.ships.indexOf(left) - state.ships.indexOf(right)
    : (left, right) => criticalPriority(state, left, right));
}

function orderedIds(state: SimulationState, scheduling: RecoveryStrategy["scheduling"]): string[] {
  return orderFor(state, scheduling).map((ship) => ship.vesselId);
}

function makeStrategy(
  state: SimulationState,
  input: Omit<RecoveryStrategy, "actions">,
): RecoveryStrategy {
  const order = orderedIds(state, input.scheduling);
  const actions: StrategyAction[] = [];
  if (input.scheduling === "critical-first") {
    actions.push({ type: "prioritize", vesselIds: order.filter((id) => hasCriticalCargo(state.ships.find((ship) => ship.vesselId === id)!)), reason: "Move essential cargo with the earliest deadlines ahead of nonessential freight." });
  }
  for (const port of state.ports) if (input.resourceMode === "dedicated-priority" && Math.min(port.availableBerths, port.unloadingResources) > 1 && state.ships.some((ship) => input.assignments[ship.vesselId] === port.portId && hasCriticalCargo(ship))) {
    actions.push({ type: "allocate-resources", portId: port.portId, concurrentVessels: 1 });
  }
  for (const ship of orderFor(state, input.scheduling)) {
    const portId = input.assignments[ship.vesselId];
    actions.push({ type: "schedule", vesselId: ship.vesselId, portId });
    if (input.holdNonessentialHours > 0 && isNonessential(ship)) actions.push({ type: "delay", vesselId: ship.vesselId, hours: input.holdNonessentialHours, reason: "Release constrained unloading capacity for essential cargo." });
    if (portId !== ship.destinationPortId) actions.push({ type: "reroute", vesselId: ship.vesselId, fromPortId: ship.destinationPortId, toPortId: portId });
  }
  return { ...input, actions };
}

function isFeasible(state: SimulationState, strategy: RecoveryStrategy, horizonHours: number): boolean {
  if (Object.keys(strategy.assignments).length !== state.ships.length) return false;
  const portLoads = new Map<string, number>();
  for (const ship of state.ships) {
    const targetId = strategy.assignments[ship.vesselId];
    const target = state.ports.find((port) => port.portId === targetId);
    if (!target) return false;
    if (targetId !== ship.destinationPortId && !ship.eligibleAlternativePortIds.includes(targetId)) return false;
    if (targetId !== ship.destinationPortId && (target.currentCapacityContainersPerDay <= 0 || target.availableBerths < 1 || target.unloadingResources < 1)) return false;
    if (ship.cargo.some((cargo) => cargo.specialHandling.some((need) => !target.supportedHandling.includes(need)))) return false;
    portLoads.set(targetId, (portLoads.get(targetId) ?? 0) + containersFor(ship));
  }
  // Only add a reroute when the receiving port can process the modeled queue inside the simulation horizon.
  for (const [portId, load] of portLoads) {
    const port = state.ports.find((item) => item.portId === portId)!;
    const hasReroute = state.ships.some((ship) => ship.destinationPortId !== strategy.assignments[ship.vesselId] && strategy.assignments[ship.vesselId] === portId);
    if (hasReroute && load > port.currentCapacityContainersPerDay * horizonHours / 24) return false;
  }
  return true;
}

export function generateStrategies(state: SimulationState, horizonHours = DEFAULT_SIMULATION_OPTIONS.horizonHours): RecoveryStrategy[] {
  const assignments = Object.fromEntries(state.ships.map((ship) => [ship.vesselId, ship.destinationPortId]));
  const candidates = [
    makeStrategy(state, { id: "baseline-arrival-order", name: "Normal arrival order", summary: "Process vessels in estimated arrival order using available unloading resources.", scheduling: "arrival-order", resourceMode: "available", holdNonessentialHours: 0, assignments }),
    makeStrategy(state, { id: "critical-cargo-first", name: "Prioritize critical cargo", summary: "Schedule ships carrying essential cargo first, ordered by earliest critical deadline and then cargo volume.", scheduling: "critical-first", resourceMode: "available", holdNonessentialHours: 0, assignments }),
  ];
  if (state.ports.some((port) => Math.min(port.availableBerths, port.unloadingResources) > 1)) {
    candidates.push(makeStrategy(state, { id: "dedicated-critical-capacity", name: "Reserve capacity for critical cargo", summary: "Process the critical-first queue with one active vessel so it receives the port's available throughput.", scheduling: "critical-first", resourceMode: "dedicated-priority", holdNonessentialHours: 0, assignments }));
  }
  if (state.ships.some(isNonessential)) {
    candidates.push(makeStrategy(state, { id: "stage-lower-priority", name: "Temporarily stage lower-priority ships", summary: "Hold nonessential ships for 8 hours while essential cargo moves first.", scheduling: "critical-first", resourceMode: "available", holdNonessentialHours: 8, assignments }));
  }
  const baseCount = candidates.length;
  const rerouteCandidates = state.ships.flatMap((ship) => ship.eligibleAlternativePortIds.map((portId) => ({ ship, portId })));
  let feasibleReroutes = 0;
  for (const { ship, portId } of rerouteCandidates) {
    const rerouteAssignments = { ...assignments, [ship.vesselId]: portId };
    const reroute = makeStrategy(state, {
      id: `reroute-${ship.vesselId}-${portId}`,
      name: `Reroute ${ship.vesselId} to ${portId}`,
      summary: `Move ${ship.vesselId} to its explicitly modeled alternative port and retain critical-first scheduling.`,
      scheduling: "critical-first", resourceMode: "available", holdNonessentialHours: 0, assignments: rerouteAssignments,
    });
    if (!isFeasible(state, reroute, horizonHours)) continue;
    candidates.push(reroute);
    feasibleReroutes++;
    // shortcut: show the first 20 feasible reroutes; batch additional candidates when scenarios exceed this limit.
    if (feasibleReroutes === 20) break;
  }
  return candidates.slice(0, baseCount).filter((candidate) => isFeasible(state, candidate, horizonHours)).concat(candidates.slice(baseCount));
}

interface Trial {
  metrics: OutcomeMetrics;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function weatherSeverity(state: SimulationState, portId: string): number {
  const forecast = state.weather.find((item) => item.portId === portId);
  if (!forecast) return 0;
  const alertSeverity = Math.max(0, ...forecast.alerts.map((alert) => alert.severity));
  const forecastSeverity = Math.max(0, ...forecast.forecasts.map((point) => Math.max(
    clamp((point.windGustKph - 30) / 80, 0, 1), clamp(point.waveHeightM / 6, 0, 1), clamp(point.precipitationMm / 30, 0, 1),
  )));
  return Math.max(alertSeverity, forecastSeverity);
}

function simulateRun(state: SimulationState, strategy: RecoveryStrategy, options: SimulationOptions, random: () => number): Trial {
  const startMs = Date.parse(state.startAt);
  const arrivalDelays = new Map(state.ships.map((ship) => [ship.vesselId, random() * options.maxArrivalDelayHours]));
  const portFactors = new Map(state.ports.map((port) => {
    const weather = clamp(weatherSeverity(state, port.portId) * (1 + (random() * 2 - 1) * options.weatherSeverityVariation), 0, 1);
    const capacity = 1 - random() * options.capacityReductionVariation;
    const unloading = 1 + random() * options.unloadingTimeVariation;
    const baseResources = Math.min(port.availableBerths, port.unloadingResources);
    const resourceFailure = random() < options.equipmentFailureProbability;
    const availableResources = Math.max(0, baseResources - (resourceFailure ? 1 : 0));
    return [port.portId, { weatherFactor: 1 - weather * 0.18, capacityFactor: capacity, unloadingFactor: unloading, availableResources }] as const;
  }));
  const order = orderedIds(state, strategy.scheduling);
  const jobs = state.ships.map((ship) => ({
    ship,
    portId: strategy.assignments[ship.vesselId],
    remaining: containersFor(ship),
    arrivalHour: (Date.parse(ship.estimatedArrival) - startMs) / 3_600_000 + arrivalDelays.get(ship.vesselId)!,
    holdUntil: isNonessential(ship) ? strategy.holdNonessentialHours : 0,
    startedAt: null as number | null,
    completedAt: null as number | null,
    capacityCredit: 0,
  }));
  let totalProcessed = 0;

  for (const port of state.ports) {
    const portJobs = jobs.filter((job) => job.portId === port.portId).sort((left, right) => order.indexOf(left.ship.vesselId) - order.indexOf(right.ship.vesselId));
    const factor = portFactors.get(port.portId)!;
    const hasCriticalDemand = portJobs.some((job) => hasCriticalCargo(job.ship));
    const strategySlots = strategy.resourceMode === "dedicated-priority" && hasCriticalDemand ? 1 : factor.availableResources;
    const slots = Math.min(strategySlots, factor.availableResources);
    const hourlyCapacity = port.currentCapacityContainersPerDay / 24 * factor.weatherFactor * factor.capacityFactor / factor.unloadingFactor;
    const step = 0.25;
    for (let time = 0; time < options.horizonHours && portJobs.some((job) => job.remaining > 0); time += step) {
      if (slots < 1 || hourlyCapacity <= 0) break;
      const active = portJobs.filter((job) => job.remaining > 0 && job.startedAt !== null);
      const ready = portJobs.filter((job) => job.remaining > 0 && job.startedAt === null && job.arrivalHour <= time && job.holdUntil <= time);
      for (const job of ready.slice(0, Math.max(0, slots - active.length))) job.startedAt = time;
      const running = portJobs.filter((job) => job.remaining > 0 && job.startedAt !== null).slice(0, slots);
      if (!running.length) continue;
      const perVesselCapacity = hourlyCapacity * step / running.length;
      for (const job of running) {
        job.capacityCredit += perVesselCapacity;
        const processed = Math.min(job.remaining, Math.floor(job.capacityCredit));
        if (processed <= 0) continue;
        job.capacityCredit -= processed;
        job.remaining -= processed;
        totalProcessed += processed;
        if (job.remaining <= 0) job.completedAt = time + step;
      }
    }
  }

  const allCargo = jobs.flatMap((job) => job.ship.cargo.map((cargo) => ({ cargo, completedAt: job.completedAt })));
  const criticalCargo = allCargo.filter((item) => item.cargo.essential);
  const criticalContainers = criticalCargo.reduce((sum, item) => sum + item.cargo.containers, 0);
  const criticalOnTime = criticalCargo.reduce((sum, item) => sum + (item.completedAt !== null && item.completedAt * 3_600_000 + startMs <= Date.parse(item.cargo.deadline) ? item.cargo.containers : 0), 0);
  const criticalCargoOnTimePercent = criticalContainers ? 100 * criticalOnTime / criticalContainers : 100;
  const averageCargoDelayHours = allCargo.length ? allCargo.reduce((sum, item) => {
    const deadlineHour = (Date.parse(item.cargo.deadline) - startMs) / 3_600_000;
    const deliveryHour = item.completedAt ?? options.horizonHours;
    return sum + Math.max(0, deliveryHour - deadlineHour) * item.cargo.containers;
  }, 0) / allCargo.reduce((sum, item) => sum + item.cargo.containers, 0) : 0;
  const delayedVessels = jobs.filter((job) => job.arrivalHour <= options.horizonHours && (job.startedAt === null || job.startedAt > job.arrivalHour + 0.25)).length;
  const hasCompleteCostInputs = allCargo.length > 0 && allCargo.every((item) => item.cargo.delayCostPerContainerHour !== undefined);
  const estimatedDelayCost = hasCompleteCostInputs ? allCargo.reduce((sum, item) => {
    const deadlineHour = (Date.parse(item.cargo.deadline) - startMs) / 3_600_000;
    const delay = Math.max(0, (item.completedAt ?? options.horizonHours) - deadlineHour);
    return sum + delay * item.cargo.containers * (item.cargo.delayCostPerContainerHour ?? 0);
  }, 0) : null;
  const nominalCapacity = state.ports.reduce((sum, port) => sum + port.currentCapacityContainersPerDay * options.horizonHours / 24, 0);

  return { metrics: {
    criticalCargoOnTimePercent,
    averageCargoDelayHours,
    totalContainersProcessed: totalProcessed,
    portUtilizationPercent: nominalCapacity ? Math.min(100, 100 * totalProcessed / nominalCapacity) : 0,
    delayedVessels,
    estimatedDelayCost,
  } };
}

export function simulateStrategy(state: SimulationState, strategy: RecoveryStrategy, partialOptions: Partial<SimulationOptions> = {}): SimulationSummary {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const random = seededRandom(options.seed);
  const trials = Array.from({ length: options.runs }, () => simulateRun(state, strategy, options, random));
  const metricKeys: (keyof OutcomeMetrics)[] = ["criticalCargoOnTimePercent", "averageCargoDelayHours", "totalContainersProcessed", "portUtilizationPercent", "delayedVessels", "estimatedDelayCost"];
  const mean = Object.fromEntries(metricKeys.map((key) => {
    const values = trials.map((trial) => trial.metrics[key]).filter((value): value is number => value !== null);
    return [key, values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null];
  })) as unknown as OutcomeMetrics;
  const metTarget = trials.filter((trial) => trial.metrics.criticalCargoOnTimePercent >= options.criticalCargoOnTimeTargetPercent).length;
  return {
    mean,
    targetCriticalCargoOnTimePercent: options.criticalCargoOnTimeTargetPercent,
    probabilityOfMeetingTarget: round(metTarget / trials.length),
    runs: options.runs,
    seed: options.seed,
    horizonHours: options.horizonHours,
  };
}
