import type { CargoBatchSnapshot, OperationalSnapshot, OutcomeMetrics, RecoveryPlanSelection, RecoveryStrategy, Ship, SimulationOptions, SimulationReplay, SimulationState, SimulationSummary, StrategyAction } from "./types.ts";

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  runs: 40,
  seed: 42,
  horizonHours: 72,
  timeStepHours: 1,
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
  const cargoBatchCount = state.ships.reduce((sum, ship) => sum + ship.cargo.length, 0);
  const steps = Math.ceil(options.horizonHours / options.timeStepHours);
  const estimatedWork = ((state.ships.length * state.ports.length + cargoBatchCount + state.ships.length + state.ports.length) * steps
    + state.ports.length * options.horizonHours) * options.runs * strategyCount;
  if (estimatedWork > MAX_SIMULATION_WORK) throw new SimulationBudgetError("Simulation request is too large; reduce runs, horizonHours, or the number of ships and cargo batches.");
}

const MAX_REPLAY_CELLS = 100_000;
export function assertReplayBudget(state: SimulationState, options: SimulationOptions, replayCount = 1): void {
  const cargoBatchCount = state.ships.reduce((sum, ship) => sum + ship.cargo.length, 0);
  const cells = replayCount * (state.ships.length + cargoBatchCount + state.ports.length) * (Math.ceil(options.horizonHours / options.timeStepHours) + 1);
  if (cells > MAX_REPLAY_CELLS) throw new SimulationBudgetError("Replay output is too large; reduce horizonHours or the number of cargo batches.");
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
    candidates.push(makeStrategy(state, { id: "dedicated-critical-capacity", name: "Reserve capacity for critical cargo", summary: "Reserve one berth and unloading resource for essential cargo; downstream landside capacity is not modeled.", scheduling: "critical-first", resourceMode: "dedicated-priority", holdNonessentialHours: 0, assignments }));
  }
  if (state.ships.some(isNonessential)) {
    candidates.push(makeStrategy(state, { id: "stage-lower-priority", name: "Temporarily stage lower-priority ships", summary: "Hold nonessential ships for 8 hours while essential cargo moves first.", scheduling: "critical-first", resourceMode: "available", holdNonessentialHours: 8, assignments }));
  }
  const baseCount = candidates.length;
  const rerouteCandidates = state.ships.filter(isNonessential).flatMap((ship) => ship.eligibleAlternativePortIds.map((portId) => ({ ship, portId })));
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

export function generateStrategyForPlan(state: SimulationState, plan: RecoveryPlanSelection, horizonHours = DEFAULT_SIMULATION_OPTIONS.horizonHours): RecoveryStrategy | undefined {
  const hasCriticalDemand = state.ships.some(hasCriticalCargo);
  const hasLowerPriorityShips = state.ships.some(isNonessential);
  const canReserveCapacity = state.ports.some((port) => Math.min(port.availableBerths, port.unloadingResources) > 1 && state.ships.some((ship) => ship.destinationPortId === port.portId && hasCriticalCargo(ship)));
  if ((plan.prioritizeCriticalCargo && !hasCriticalDemand)
    || (plan.staggerLowerPriorityVessels && !hasLowerPriorityShips)
    || (plan.reserveCapacityForCriticalCargo && (!canReserveCapacity || !plan.prioritizeCriticalCargo))) return undefined;

  const defaultAssignments = Object.fromEntries(state.ships.map((ship) => [ship.vesselId, ship.destinationPortId]));
  const assignments = plan.divertStandardShipment
    ? state.ships.filter(isNonessential).flatMap((ship) => ship.eligibleAlternativePortIds.map((portId) => ({ ship, portId })))
    : [{ ship: undefined, portId: undefined }];
  for (const diversion of assignments) {
    const nextAssignments = diversion.ship && diversion.portId ? { ...defaultAssignments, [diversion.ship.vesselId]: diversion.portId } : defaultAssignments;
    const strategy = makeStrategy(state, {
      id: `custom-${Number(plan.prioritizeCriticalCargo)}${Number(plan.staggerLowerPriorityVessels)}${Number(plan.reserveCapacityForCriticalCargo)}${Number(plan.divertStandardShipment)}${diversion.ship ? `-${diversion.ship.vesselId}-${diversion.portId}` : ""}`,
      name: plan.divertStandardShipment ? `Divert ${diversion.ship?.vesselId ?? "standard cargo"}` : "Custom recovery plan",
      summary: [
        plan.prioritizeCriticalCargo && "schedule essential cargo first",
        plan.staggerLowerPriorityVessels && "hold lower-priority vessels for 8 hours",
        plan.reserveCapacityForCriticalCargo && "reserve one berth and unloading resource for essential cargo; downstream landside capacity is not modeled",
        diversion.ship && `reroute ${diversion.ship.vesselId} to ${diversion.portId}`,
      ].filter(Boolean).join("; ") || "Process vessels in estimated arrival order using available unloading resources.",
      scheduling: plan.prioritizeCriticalCargo ? "critical-first" : "arrival-order",
      resourceMode: plan.reserveCapacityForCriticalCargo ? "dedicated-priority" : "available",
      holdNonessentialHours: plan.staggerLowerPriorityVessels ? 8 : 0,
      assignments: nextAssignments,
    });
    if (isFeasible(state, strategy, horizonHours)) return strategy;
  }
  return undefined;
}

interface CargoJob {
  cargo: Ship["cargo"][number];
  manifestIndex: number;
  containersUnloaded: number;
  completedAtHour: number | null;
}

interface VesselJob {
  ship: Ship;
  portId: string;
  arrivalHour: number;
  eligibleHour: number;
  status: "scheduled" | "waiting" | "berthed" | "departed";
  berthId: string | null;
  berthAtHour: number | null;
  departureHour: number | null;
  cargo: CargoJob[];
}

interface Trial {
  metrics: OutcomeMetrics;
  snapshots?: OperationalSnapshot[];
}

interface PortFactors {
  capacityFactor: number;
  unloadingFactor: number;
  weatherVariation: number;
  availableUnloadingResources: number;
  capacityCredit: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function weatherSeverityAt(state: SimulationState, portId: string, atHour: number): number {
  const forecast = state.weather.find((item) => item.portId === portId);
  if (!forecast) return 0;
  const atMs = Date.parse(state.startAt) + atHour * 3_600_000;
  const point = forecast.forecasts.reduce<typeof forecast.forecasts[number] | undefined>((closest, next) => {
    if (!closest) return next;
    return Math.abs(Date.parse(next.at) - atMs) < Math.abs(Date.parse(closest.at) - atMs) ? next : closest;
  }, undefined);
  const alertSeverity = Math.max(0, ...forecast.alerts.map((alert) => alert.severity));
  const forecastSeverity = point ? Math.max(
    clamp((point.windGustKph - 30) / 80, 0, 1), clamp(point.waveHeightM / 6, 0, 1), clamp(point.precipitationMm / 30, 0, 1),
  ) : 0;
  return Math.max(alertSeverity, forecastSeverity);
}

function hasRemainingCargo(job: VesselJob): boolean {
  return job.cargo.some((item) => item.containersUnloaded < item.cargo.containers);
}

function hasRemainingCriticalCargo(job: VesselJob): boolean {
  return job.cargo.some((item) => item.cargo.essential && item.containersUnloaded < item.cargo.containers);
}

function cargoSnapshot(job: VesselJob, unloadingVesselIds: Set<string>): CargoBatchSnapshot[] {
  return job.cargo.map((item) => {
    const containersRemaining = item.cargo.containers - item.containersUnloaded;
    return {
      batchId: item.cargo.cargoId,
      vesselId: job.ship.vesselId,
      category: item.cargo.category,
      criticality: item.cargo.essential ? "critical" : "standard",
      deadline: item.cargo.deadline,
      specialHandling: item.cargo.specialHandling,
      containers: item.cargo.containers,
      containersUnloaded: item.containersUnloaded,
      containersRemaining,
      status: containersRemaining === 0 ? "completed" : job.status === "scheduled" ? "not-arrived" : unloadingVesselIds.has(job.ship.vesselId) ? "unloading" : "waiting",
    };
  });
}

function simulateRun(
  state: SimulationState,
  strategy: RecoveryStrategy,
  options: SimulationOptions,
  random: () => number,
  captureReplay = false,
): Trial {
  const startMs = Date.parse(state.startAt);
  const order = orderedIds(state, strategy.scheduling);
  const orderIndex = new Map(order.map((vesselId, index) => [vesselId, index]));
  const jobs: VesselJob[] = state.ships.map((ship) => {
    const arrivalHour = Math.max(0, (Date.parse(ship.estimatedArrival) - startMs) / 3_600_000 + random() * options.maxArrivalDelayHours);
    return {
      ship,
      portId: strategy.assignments[ship.vesselId],
      arrivalHour,
      eligibleHour: arrivalHour + (isNonessential(ship) ? strategy.holdNonessentialHours : 0),
      status: "scheduled",
      berthId: null,
      berthAtHour: null,
      departureHour: null,
      cargo: ship.cargo.map((cargo, manifestIndex) => ({ cargo, manifestIndex, containersUnloaded: 0, completedAtHour: null })),
    };
  });
  const portFactors = new Map<string, PortFactors>(state.ports.map((port): [string, PortFactors] => {
    const capacityFactor = 1 - random() * options.capacityReductionVariation;
    const unloadingFactor = 1 + random() * options.unloadingTimeVariation;
    const weatherVariation = (random() * 2 - 1) * options.weatherSeverityVariation;
    const resourceFailure = random() < options.equipmentFailureProbability;
    const availableUnloadingResources = Math.max(0, port.unloadingResources - (resourceFailure ? 1 : 0));
    return [port.portId, { capacityFactor, unloadingFactor, weatherVariation, availableUnloadingResources, capacityCredit: 0 }];
  }));
  const allCargo = jobs.flatMap((job) => job.cargo);
  const criticalContainerCount = allCargo.reduce((sum, item) => sum + (item.cargo.essential ? item.cargo.containers : 0), 0);
  const totalCargoContainers = allCargo.reduce((sum, item) => sum + item.cargo.containers, 0);
  const hasCompleteCostInputs = allCargo.length > 0 && allCargo.every((item) => item.cargo.delayCostPerContainerHour !== undefined);
  let totalProcessed = 0;
  let nominalCapacity = 0;
  let criticalOnTimeContainers = 0;
  let delayContainerHours = 0;
  let estimatedDelayCost = 0;
  const snapshots: OperationalSnapshot[] | undefined = captureReplay ? [] : undefined;
  const totalStepCount = Math.ceil(options.horizonHours / options.timeStepHours);

  const activeDisruptionsAt = (port: SimulationState["ports"][number], hour: number) => port.activeDisruptions
    .filter((disruption) => disruption.startHour <= hour && hour < disruption.startHour + disruption.durationHours);

  const effectiveCapacityPerHour = (portId: string, hour: number) => {
    const port = state.ports.find((item) => item.portId === portId)!;
    const factors = portFactors.get(portId)!;
    const weather = clamp(weatherSeverityAt(state, portId, hour) * (1 + factors.weatherVariation), 0, 1);
    const remainingCapacity = activeDisruptionsAt(port, hour).reduce((remaining, disruption) => remaining * (1 - disruption.severity), 1);
    return port.currentCapacityContainersPerDay / 24 * clamp(remainingCapacity, 0, 1) * (1 - weather * 0.18) * factors.capacityFactor / factors.unloadingFactor;
  };

  const captureSnapshot = (hour: number, unloadedByPort: Map<string, number>, unloadingVesselIds: Set<string>) => {
    if (!snapshots) return;
    const cargoBatches = jobs.flatMap((job) => cargoSnapshot(job, unloadingVesselIds));
    snapshots.push({
      simulationHour: round(hour),
      ports: state.ports.map((port) => ({
        portId: port.portId,
        capacityContainersPerHour: round(effectiveCapacityPerHour(port.portId, hour)),
        activeDisruptions: activeDisruptionsAt(port, hour),
        waitingVesselIds: jobs.filter((job) => job.portId === port.portId && job.status === "waiting").map((job) => job.ship.vesselId),
        berthAssignments: jobs.filter((job) => job.portId === port.portId && job.status === "berthed" && job.berthId).map((job) => ({ berthId: job.berthId!, vesselId: job.ship.vesselId })),
        containersUnloadedThisStep: unloadedByPort.get(port.portId) ?? 0,
      })),
      vessels: jobs.map((job) => ({
        vesselId: job.ship.vesselId,
        portId: job.portId,
        status: job.status,
        arrivalHour: round(job.arrivalHour),
        berthId: job.berthId,
        berthAtHour: job.berthAtHour === null ? null : round(job.berthAtHour),
        departureHour: job.departureHour === null ? null : round(job.departureHour),
      })),
      cargoBatches,
      completedCargoBatchIds: cargoBatches.filter((item) => item.status === "completed").map((item) => item.batchId),
      cargoAtRisk: cargoBatches.filter((item) => item.containersRemaining > 0).map((item) => ({
        batchId: item.batchId,
        vesselId: item.vesselId,
        containersRemaining: item.containersRemaining,
        deadlinePassed: Date.parse(item.deadline) <= startMs + hour * 3_600_000,
      })),
    });
  };

  const updateArrivals = (hour: number) => {
    for (const job of jobs) if (job.status === "scheduled" && job.arrivalHour <= hour) job.status = "waiting";
  };

  updateArrivals(0);
  captureSnapshot(0, new Map(), new Set());

  for (let stepIndex = 0; stepIndex < totalStepCount; stepIndex++) {
    const startHour = stepIndex * options.timeStepHours;
    const endHour = Math.min(options.horizonHours, startHour + options.timeStepHours);
    const elapsedHours = endHour - startHour;
    updateArrivals(startHour);
    const unloadedByPort = new Map<string, number>();
    const unloadingVesselIds = new Set<string>();

    for (const port of state.ports) {
      const factors = portFactors.get(port.portId)!;
      const intervalCapacity = Array.from({ length: elapsedHours }, (_, hour) => effectiveCapacityPerHour(port.portId, startHour + hour))
        .reduce((sum, capacity) => sum + capacity, 0);
      const hourlyCapacity = elapsedHours ? intervalCapacity / elapsedHours : 0;
      nominalCapacity += intervalCapacity;
      const portJobs = jobs.filter((job) => job.portId === port.portId);
      const freeBerthIds = Array.from({ length: Math.max(0, port.availableBerths) }, (_, index) => `${port.portId}-berth-${index + 1}`)
        .filter((berthId) => !portJobs.some((job) => job.berthId === berthId));
      const criticalPending = strategy.resourceMode === "dedicated-priority" && portJobs.some((job) => job.status !== "departed" && hasRemainingCriticalCargo(job));
      const criticalAlreadyBerthed = portJobs.some((job) => job.status === "berthed" && hasRemainingCriticalCargo(job));
      const reserveCriticalBerth = criticalPending && !criticalAlreadyBerthed;
      const noncriticalBerthLimit = reserveCriticalBerth ? Math.max(0, port.availableBerths - 1) : port.availableBerths;
      let noncriticalBerthed = portJobs.filter((job) => job.status === "berthed" && !hasRemainingCriticalCargo(job)).length;
      const waiting = portJobs.filter((job) => job.status === "waiting" && job.eligibleHour <= startHour)
        .sort((left, right) => orderIndex.get(left.ship.vesselId)! - orderIndex.get(right.ship.vesselId)!);
      for (const job of waiting) {
        if (!freeBerthIds.length) break;
        const critical = hasRemainingCriticalCargo(job);
        if (!critical && noncriticalBerthed >= noncriticalBerthLimit) continue;
        job.status = "berthed";
        job.berthId = freeBerthIds.shift()!;
        job.berthAtHour = startHour;
        if (!critical) noncriticalBerthed++;
      }

      const berthed = portJobs.filter((job) => job.status === "berthed" && hasRemainingCargo(job))
        .sort((left, right) => orderIndex.get(left.ship.vesselId)! - orderIndex.get(right.ship.vesselId)!);
      const criticalBerthed = berthed.filter(hasRemainingCriticalCargo);
      const unloadingSlots = Math.min(factors.availableUnloadingResources, port.availableBerths);
      const unloading = unloadingSlots > 0 && strategy.resourceMode === "dedicated-priority" && criticalBerthed.length
        ? [...criticalBerthed.slice(0, 1), ...berthed.filter((job) => job !== criticalBerthed[0]).slice(0, Math.max(0, unloadingSlots - 1))]
        : berthed.slice(0, unloadingSlots);

      const cargoQueue = unloading.flatMap((job) => job.cargo.filter((item) => item.containersUnloaded < item.cargo.containers).map((item) => ({ job, item })));
      cargoQueue.sort((left, right) => {
        if (strategy.scheduling === "critical-first") {
          const criticality = Number(right.item.cargo.essential) - Number(left.item.cargo.essential);
          if (criticality) return criticality;
          const deadline = Date.parse(left.item.cargo.deadline) - Date.parse(right.item.cargo.deadline);
          if (deadline) return deadline;
        }
        return orderIndex.get(left.job.ship.vesselId)! - orderIndex.get(right.job.ship.vesselId)!
          || left.item.manifestIndex - right.item.manifestIndex;
      });

      const capacityCredit = factors.capacityCredit + hourlyCapacity * elapsedHours;
      let availableContainers = Math.floor(capacityCredit);
      factors.capacityCredit = capacityCredit - availableContainers;
      if (!unloading.length) availableContainers = 0;
      let processedThisStep = 0;
      for (const { job, item } of cargoQueue) {
        const containersUnloaded = Math.min(availableContainers, item.cargo.containers - item.containersUnloaded);
        if (containersUnloaded > 0) {
          item.containersUnloaded += containersUnloaded;
          availableContainers -= containersUnloaded;
          processedThisStep += containersUnloaded;
          unloadingVesselIds.add(job.ship.vesselId);
          const deadlineHour = (Date.parse(item.cargo.deadline) - startMs) / 3_600_000;
          const delayHours = Math.max(0, endHour - deadlineHour);
          delayContainerHours += containersUnloaded * delayHours;
          if (item.cargo.essential && endHour <= deadlineHour) criticalOnTimeContainers += containersUnloaded;
          if (hasCompleteCostInputs) estimatedDelayCost += containersUnloaded * delayHours * (item.cargo.delayCostPerContainerHour ?? 0);
          if (item.containersUnloaded === item.cargo.containers) item.completedAtHour = endHour;
        }
        if (availableContainers === 0) break;
      }
      unloadedByPort.set(port.portId, processedThisStep);
      totalProcessed += processedThisStep;

      for (const job of portJobs) if (job.status === "berthed" && !hasRemainingCargo(job)) {
        job.status = "departed";
        job.departureHour = endHour;
        job.berthId = null;
      }

      // Capacity that exceeded demand is discarded; only a fractional container carries forward.
      if (!unloading.length) factors.capacityCredit %= 1;
    }

    updateArrivals(endHour);
    captureSnapshot(endHour, unloadedByPort, unloadingVesselIds);
  }

  const delayedVessels = jobs.filter((job) => job.arrivalHour <= options.horizonHours
    && (job.berthAtHour === null ? options.horizonHours > job.arrivalHour : job.berthAtHour > job.arrivalHour + 0.25)).length;
  for (const item of allCargo) {
    const remaining = item.cargo.containers - item.containersUnloaded;
    const deadlineHour = (Date.parse(item.cargo.deadline) - startMs) / 3_600_000;
    const delayHours = Math.max(0, options.horizonHours - deadlineHour);
    delayContainerHours += remaining * delayHours;
    if (hasCompleteCostInputs) estimatedDelayCost += remaining * delayHours * (item.cargo.delayCostPerContainerHour ?? 0);
  }
  return {
    metrics: {
      criticalCargoOnTimePercent: criticalContainerCount ? 100 * criticalOnTimeContainers / criticalContainerCount : 100,
      averageCargoDelayHours: totalCargoContainers ? delayContainerHours / totalCargoContainers : 0,
      totalContainersProcessed: totalProcessed,
      portUtilizationPercent: nominalCapacity ? Math.min(100, 100 * totalProcessed / nominalCapacity) : 0,
      delayedVessels,
      estimatedDelayCost: hasCompleteCostInputs ? estimatedDelayCost : null,
    },
    ...(snapshots ? { snapshots } : {}),
  };
}

function summarizeTrials(trials: Trial[], options: SimulationOptions): SimulationSummary {
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
    timeStepHours: options.timeStepHours,
  };
}

export function simulateStrategy(state: SimulationState, strategy: RecoveryStrategy, partialOptions: Partial<SimulationOptions> = {}): SimulationSummary {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const random = seededRandom(options.seed);
  const trials = Array.from({ length: options.runs }, () => simulateRun(state, strategy, options, random));
  return summarizeTrials(trials, options);
}

export function simulateStrategyWithReplay(state: SimulationState, strategy: RecoveryStrategy, partialOptions: Partial<SimulationOptions> = {}): { summary: SimulationSummary; replay: SimulationReplay } {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const random = seededRandom(options.seed);
  const trials = Array.from({ length: options.runs }, (_, index) => simulateRun(state, strategy, options, random, index === 0));
  return {
    summary: summarizeTrials(trials, options),
    replay: { seed: options.seed, sampleRunIndex: 0, timeStepHours: options.timeStepHours, snapshots: trials[0].snapshots ?? [] },
  };
}
