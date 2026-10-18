import type { CargoBatchSnapshot, DecisionCriteria, OperationalSnapshot, OutcomeMetrics, RecoveryPlan, RecoveryStrategy, SchedulingPolicy, Ship, SimulationOptions, SimulationReplay, SimulationState, SimulationSummary, StrategyAction } from "./types.ts";

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

function arrivalPriority(state: SimulationState, left: Ship, right: Ship): number {
  return Date.parse(left.estimatedArrival) - Date.parse(right.estimatedArrival) || state.ships.indexOf(left) - state.ships.indexOf(right);
}

function criticalPriority(state: SimulationState, left: Ship, right: Ship): number {
  const criticalVolume = (ship: Ship) => ship.cargo.reduce((sum, cargo) => sum + (cargo.essential ? cargo.containers : 0), 0);
  const deadline = (ship: Ship) => Math.min(...ship.cargo.filter((cargo) => cargo.essential).map((cargo) => Date.parse(cargo.deadline)), Infinity);
  const deadlineDifference = deadline(left) - deadline(right);
  if (deadlineDifference) return deadlineDifference;
  const volumeDifference = criticalVolume(right) - criticalVolume(left);
  if (volumeDifference) return volumeDifference;
  return arrivalPriority(state, left, right);
}

function deadlineSlackHours(state: SimulationState, ship: Ship, portId: string): number {
  const port = state.ports.find((item) => item.portId === portId);
  const throughput = Math.max(0.01, (port?.currentCapacityContainersPerDay ?? 0) / 24);
  const arrivalHour = Math.max(0, (Date.parse(ship.estimatedArrival) - Date.parse(state.startAt)) / 3_600_000);
  return Math.min(...ship.cargo.map((cargo) => (Date.parse(cargo.deadline) - Date.parse(state.startAt)) / 3_600_000
    - arrivalHour - cargo.containers / throughput), Infinity);
}

function orderFor(state: SimulationState, scheduling: SchedulingPolicy, assignments: Record<string, string>): Ship[] {
  const comparator = scheduling === "arrival-order" ? (left: Ship, right: Ship) => arrivalPriority(state, left, right)
    : scheduling === "critical-first" ? (left: Ship, right: Ship) => criticalPriority(state, left, right)
      : scheduling === "balanced" ? (left: Ship, right: Ship) => {
        const urgency = (ship: Ship) => deadlineSlackHours(state, ship, assignments[ship.vesselId]) - (hasCriticalCargo(ship) ? 12 : 0);
        return urgency(left) - urgency(right) || arrivalPriority(state, left, right);
      }
        : (left: Ship, right: Ship) => deadlineSlackHours(state, left, assignments[left.vesselId]) - deadlineSlackHours(state, right, assignments[right.vesselId])
          || Number(hasCriticalCargo(right)) - Number(hasCriticalCargo(left)) || arrivalPriority(state, left, right);
  return [...state.ships].sort(comparator);
}

function planSignature(plan: RecoveryPlan): string {
  const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify([
    plan.scheduling, sorted(plan.stagingWindowsByVessel), sorted(plan.cargoPrioritiesByBatch), plan.reserveBerthForCriticalCargo,
    plan.criticalCapacityReservation, sorted(plan.assignments),
  ]);
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16).padStart(8, "0");
}

function makeStrategy(state: SimulationState, plan: RecoveryPlan, name: string, summary: string, id = `plan-${hash(planSignature(plan))}`): RecoveryStrategy {
  const orderedShips = orderFor(state, plan.scheduling, plan.assignments);
  const actions: StrategyAction[] = [];
  if (plan.scheduling !== "arrival-order") {
    actions.push({ type: "prioritize", vesselIds: orderedShips.filter(hasCriticalCargo).map((ship) => ship.vesselId), reason: `${plan.scheduling} vessel and cargo scheduling.` });
  }
  if (plan.reserveBerthForCriticalCargo) for (const port of state.ports) {
    if (state.ships.some((ship) => plan.assignments[ship.vesselId] === port.portId && hasCriticalCargo(ship))) actions.push({ type: "allocate-resources", portId: port.portId, concurrentVessels: Math.max(0, Math.min(port.availableBerths, port.unloadingResources) - 1) });
  }
  if (plan.criticalCapacityReservation) actions.push({ type: "reserve-throughput", criticalPercent: plan.criticalCapacityReservation.percent, startHour: plan.criticalCapacityReservation.startHour, endHour: plan.criticalCapacityReservation.endHour });
  for (const [cargoId, priority] of Object.entries(plan.cargoPrioritiesByBatch).sort(([left], [right]) => left.localeCompare(right))) actions.push({ type: "cargo-priority", cargoId, priority });
  for (const ship of orderedShips) {
    const portId = plan.assignments[ship.vesselId];
    actions.push({ type: "schedule", vesselId: ship.vesselId, portId });
    const staging = plan.stagingWindowsByVessel[ship.vesselId];
    if (staging) actions.push({ type: "delay", vesselId: ship.vesselId, startHour: staging.startHour, hours: staging.durationHours, reason: "Hold at the arrival point during the configured staging window." });
    if (portId !== ship.destinationPortId) actions.push({ type: "reroute", vesselId: ship.vesselId, fromPortId: ship.destinationPortId, toPortId: portId });
  }
  return { ...plan, id, name, summary, actions };
}

function isFeasible(state: SimulationState, plan: RecoveryPlan, horizonHours: number): boolean {
  const shipIds = new Set(state.ships.map((ship) => ship.vesselId));
  const cargoIds = new Set(state.ships.flatMap((ship) => ship.cargo.map((cargo) => cargo.cargoId)));
  if (Object.keys(plan.assignments).length !== state.ships.length || state.ships.some((ship) => !Object.hasOwn(plan.assignments, ship.vesselId))) return false;
  if (Object.keys(plan.stagingWindowsByVessel).some((id) => !shipIds.has(id)) || Object.entries(plan.stagingWindowsByVessel).some(([vesselId, window]) => {
    const ship = state.ships.find((item) => item.vesselId === vesselId);
    return !ship?.cargo.length || !window || !Number.isInteger(window.startHour) || window.startHour < 0
      || ![2, 4, 8, 12].includes(window.durationHours) || window.startHour + window.durationHours > horizonHours;
  })) return false;
  if (Object.keys(plan.cargoPrioritiesByBatch).some((id) => !cargoIds.has(id))
    || Object.values(plan.cargoPrioritiesByBatch).some((priority) => !Number.isInteger(priority) || priority < 1 || priority > 3)) return false;
  if (plan.criticalCapacityReservation && (!Number.isInteger(plan.criticalCapacityReservation.percent)
    || plan.criticalCapacityReservation.percent <= 0 || plan.criticalCapacityReservation.percent >= 100
    || !Number.isInteger(plan.criticalCapacityReservation.startHour) || plan.criticalCapacityReservation.startHour < 0
    || !Number.isInteger(plan.criticalCapacityReservation.endHour) || plan.criticalCapacityReservation.endHour <= plan.criticalCapacityReservation.startHour
    || plan.criticalCapacityReservation.endHour > horizonHours || !state.ships.some(hasCriticalCargo) || !state.ships.some(isNonessential))) return false;
  if (typeof plan.reserveBerthForCriticalCargo !== "boolean"
    || (plan.reserveBerthForCriticalCargo && !state.ports.some((port) => Math.min(port.availableBerths, port.unloadingResources) > 1
      && state.ships.some((ship) => plan.assignments[ship.vesselId] === port.portId && hasCriticalCargo(ship))))) return false;
  if (!["arrival-order", "critical-first", "deadline-risk-first", "balanced"].includes(plan.scheduling)
    || !["critical-delivery", "minimize-delay", "minimize-cost", "balanced"].includes(plan.objective)
    || !Number.isFinite(plan.minimumCriticalCargoOnTimePercent) || plan.minimumCriticalCargoOnTimePercent < 0 || plan.minimumCriticalCargoOnTimePercent > 100
    || (plan.maximumDisruptionCost !== null && (!Number.isFinite(plan.maximumDisruptionCost) || plan.maximumDisruptionCost < 0))) return false;
  const portLoads = new Map<string, number>();
  for (const ship of state.ships) {
    const targetId = plan.assignments[ship.vesselId];
    const target = state.ports.find((port) => port.portId === targetId);
    if (!target) return false;
    if (targetId !== ship.destinationPortId && (hasCriticalCargo(ship) || !ship.eligibleAlternativePortIds.includes(targetId))) return false;
    if (targetId !== ship.destinationPortId && (target.currentCapacityContainersPerDay <= 0 || target.availableBerths < 1 || target.unloadingResources < 1)) return false;
    if (ship.cargo.some((cargo) => cargo.specialHandling.some((need) => !target.supportedHandling.includes(need)))) return false;
    portLoads.set(targetId, (portLoads.get(targetId) ?? 0) + containersFor(ship));
  }
  // Only add a reroute when the receiving port can process the modeled queue inside the simulation horizon.
  for (const [portId, load] of portLoads) {
    const port = state.ports.find((item) => item.portId === portId)!;
    const hasReroute = state.ships.some((ship) => ship.destinationPortId !== plan.assignments[ship.vesselId] && plan.assignments[ship.vesselId] === portId);
    if (hasReroute && load > port.currentCapacityContainersPerDay * horizonHours / 24) return false;
  }
  return true;
}

export function isRecoveryPlan(value: unknown): value is RecoveryPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  const keys = ["scheduling", "stagingWindowsByVessel", "cargoPrioritiesByBatch", "reserveBerthForCriticalCargo", "criticalCapacityReservation", "assignments", "objective", "minimumCriticalCargoOnTimePercent", "maximumDisruptionCost"];
  if (Object.keys(plan).length !== keys.length || keys.some((key) => !Object.hasOwn(plan, key))) return false;
  if (!plan.stagingWindowsByVessel || typeof plan.stagingWindowsByVessel !== "object" || Array.isArray(plan.stagingWindowsByVessel)
    || !plan.cargoPrioritiesByBatch || typeof plan.cargoPrioritiesByBatch !== "object" || Array.isArray(plan.cargoPrioritiesByBatch)
    || !plan.assignments || typeof plan.assignments !== "object" || Array.isArray(plan.assignments)
    || typeof plan.reserveBerthForCriticalCargo !== "boolean" || typeof plan.minimumCriticalCargoOnTimePercent !== "number"
    || !Number.isFinite(plan.minimumCriticalCargoOnTimePercent) || plan.minimumCriticalCargoOnTimePercent < 0 || plan.minimumCriticalCargoOnTimePercent > 100
    || (plan.maximumDisruptionCost !== null && (typeof plan.maximumDisruptionCost !== "number" || !Number.isFinite(plan.maximumDisruptionCost) || plan.maximumDisruptionCost < 0))) return false;
  if (Object.values(plan.stagingWindowsByVessel as Record<string, unknown>).some((window) => !window || typeof window !== "object" || Array.isArray(window)
    || Object.keys(window).length !== 2 || !Number.isInteger((window as Record<string, unknown>).startHour) || Number((window as Record<string, unknown>).startHour) < 0
    || ![2, 4, 8, 12].includes((window as Record<string, unknown>).durationHours as number))) return false;
  if (Object.values(plan.cargoPrioritiesByBatch as Record<string, unknown>).some((priority) => typeof priority !== "number" || !Number.isInteger(priority) || priority < 1 || priority > 3)) return false;
  if (Object.values(plan.assignments as Record<string, unknown>).some((portId) => typeof portId !== "string" || !portId)) return false;
  if (plan.criticalCapacityReservation !== null) {
    const reservation = plan.criticalCapacityReservation;
    if (!reservation || typeof reservation !== "object" || Array.isArray(reservation) || Object.keys(reservation).length !== 3
      || Object.values(reservation).some((item) => typeof item !== "number" || !Number.isFinite(item))
      || !Number.isInteger((reservation as Record<string, number>).percent) || (reservation as Record<string, number>).percent <= 0 || (reservation as Record<string, number>).percent >= 100
      || !Number.isInteger((reservation as Record<string, number>).startHour) || (reservation as Record<string, number>).startHour < 0
      || !Number.isInteger((reservation as Record<string, number>).endHour) || (reservation as Record<string, number>).endHour <= (reservation as Record<string, number>).startHour) return false;
  }
  return ["arrival-order", "critical-first", "deadline-risk-first", "balanced"].includes(plan.scheduling as SchedulingPolicy)
    && ["critical-delivery", "minimize-delay", "minimize-cost", "balanced"].includes(plan.objective as DecisionCriteria["objective"]);
}

export function generateStrategies(
  state: SimulationState,
  horizonHours = DEFAULT_SIMULATION_OPTIONS.horizonHours,
  criteria: DecisionCriteria = { objective: "balanced" },
  minimumCriticalCargoOnTimePercent = DEFAULT_SIMULATION_OPTIONS.criticalCargoOnTimeTargetPercent,
): RecoveryStrategy[] {
  const assignments = Object.fromEntries(state.ships.map((ship) => [ship.vesselId, ship.destinationPortId]));
  const base: RecoveryPlan = {
    scheduling: "arrival-order", stagingWindowsByVessel: {}, cargoPrioritiesByBatch: {}, reserveBerthForCriticalCargo: false,
    criticalCapacityReservation: null, assignments, objective: criteria.objective, minimumCriticalCargoOnTimePercent,
    maximumDisruptionCost: criteria.maximumDisruptionCost ?? null,
  };
  const baseline = makeStrategy(state, base, "Normal arrival order", "Use estimated arrival order with the modeled port's available berths and throughput.", "baseline-arrival-order");
  const definitions: Array<{ name: string; summary: string; plan: RecoveryPlan }>[] = [];
  const addFamily = (family: Array<{ name: string; summary: string; plan: RecoveryPlan }>, plan: RecoveryPlan, name: string, summary: string) => {
    const candidate = makeStrategy(state, plan, name, summary);
    if (isFeasible(state, plan, horizonHours) && planSignature(candidate) !== planSignature(baseline)) family.push({ name, summary, plan });
  };

  const policies: Array<{ name: string; summary: string; scheduling: SchedulingPolicy }> = [
    { name: "Critical cargo first", summary: "Schedule essential cargo by earliest deadline, with vessel priority adjusted for its critical volume.", scheduling: "critical-first" },
    { name: "Deadline risk first", summary: "Schedule the cargo with the least estimated deadline slack first.", scheduling: "deadline-risk-first" },
    { name: "Balanced scheduling", summary: "Balance essential-cargo urgency against deadline slack and vessel arrival order.", scheduling: "balanced" },
  ];
  const policyFamily: Array<{ name: string; summary: string; plan: RecoveryPlan }> = [];
  for (const policy of policies) addFamily(policyFamily, { ...base, scheduling: policy.scheduling }, policy.name, policy.summary);
  definitions.push(policyFamily);

  const stagingFamily: Array<{ name: string; summary: string; plan: RecoveryPlan }> = [];
  // shortcut: cap eligible vessels, cargo batches, and unique disruption windows at eight; expand with a larger candidate budget.
  const disruptionWindows = [...new Map(
    state.ports.flatMap((port) => port.activeDisruptions
      .filter((disruption) => disruption.severity > 0 && disruption.durationHours > 0)
      .map(({ startHour, durationHours }) => ({ startHour, endHour: Math.min(horizonHours, startHour + durationHours) })))
      .filter((window) => window.startHour < horizonHours && window.endHour > 0)
      .sort((left, right) => left.startHour - right.startHour || left.endHour - right.endHour)
      .map((window) => [JSON.stringify(window), window] as const),
  ).values()].slice(0, 8);
  const stagingShips = orderFor(state, "deadline-risk-first", assignments).filter((item) => isNonessential(item) && item.cargo.length > 0).slice(0, 8);
  for (const durationHours of [2, 4, 8, 12] as const) {
    for (const ship of stagingShips) {
      const starts = new Set([0, ...disruptionWindows.map((window) => Math.max(0, Math.min(horizonHours - durationHours, window.endHour - durationHours)))]);
      for (const startHour of starts) {
        const stagingWindowsByVessel = { [ship.vesselId]: { startHour, durationHours } };
        addFamily(stagingFamily, { ...base, scheduling: "critical-first", stagingWindowsByVessel }, `Stage ${ship.vesselId} for ${durationHours}h`, `Hold ${ship.vesselId} for ${durationHours} hours from T+${startHour}h, then use critical-first scheduling.`);
      }
    }
  }
  definitions.push(stagingFamily);

  const throughputFamily: Array<{ name: string; summary: string; plan: RecoveryPlan }> = [];
  if (state.ships.some(hasCriticalCargo) && state.ships.some(isNonessential)) {
    const windows = [{ startHour: 0, endHour: horizonHours }, ...disruptionWindows.map((window) => ({ startHour: window.startHour, endHour: Math.min(horizonHours, window.endHour) }))];
    const uniqueWindows = [...new Map(windows.filter((window) => window.endHour > window.startHour).map((window) => [JSON.stringify(window), window])).values()];
    for (const window of uniqueWindows) for (const percent of [25, 50, 75]) {
      const reservation = { percent, ...window };
      addFamily(throughputFamily, { ...base, scheduling: "deadline-risk-first", criticalCapacityReservation: reservation }, `${percent}% critical throughput reservation`, `Reserve ${percent}% of port throughput for critical cargo from T+${window.startHour}h to T+${window.endHour}h.`);
    }
  }
  definitions.push(throughputFamily);

  const priorityFamily: Array<{ name: string; summary: string; plan: RecoveryPlan }> = [];
  const priorityBatches = state.ships.flatMap((ship) => ship.cargo.filter((batch) => !batch.essential).map((batch) => ({ ship, batch })))
    .sort((left, right) => Date.parse(left.batch.deadline) - Date.parse(right.batch.deadline) || arrivalPriority(state, left.ship, right.ship))
    .slice(0, 8);
  for (const { batch: cargo } of priorityBatches) {
    for (const priority of [1, 2, 3] as const) {
      const cargoPrioritiesByBatch = { [cargo.cargoId]: priority };
      addFamily(priorityFamily, { ...base, scheduling: "balanced", cargoPrioritiesByBatch }, `Raise ${cargo.cargoId} priority to ${priority}`, `Move cargo batch ${cargo.cargoId} ahead using priority level ${priority} (higher values unload first).`);
    }
  }
  definitions.push(priorityFamily);

  const rerouteFamily: Array<{ name: string; summary: string; plan: RecoveryPlan }> = [];
  const rerouteShips = orderFor(state, "deadline-risk-first", assignments).filter((item) => isNonessential(item) && item.cargo.length > 0).slice(0, 8);
  for (const ship of rerouteShips) for (const portId of ship.eligibleAlternativePortIds) {
    const plan = { ...base, scheduling: "deadline-risk-first" as const, assignments: { ...assignments, [ship.vesselId]: portId } };
    addFamily(rerouteFamily, plan, `Reroute ${ship.vesselId} to ${portId}`, `Assign ${ship.vesselId} to its modeled alternative port and schedule by deadline risk.`);
  }
  definitions.push(rerouteFamily);

  const combinedFamily: Array<{ name: string; summary: string; plan: RecoveryPlan }> = [];
  const stageSeeds = stagingFamily.slice(0, 4);
  for (const item of stageSeeds) addFamily(combinedFamily, { ...item.plan, reserveBerthForCriticalCargo: true }, `${item.name} with a protected berth`, `${item.summary} Keep one eligible berth for a vessel carrying critical cargo.`);
  for (const item of rerouteFamily.slice(0, 4)) addFamily(combinedFamily, { ...item.plan, scheduling: "critical-first" }, `${item.name} with critical-first scheduling`, `${item.summary} Schedule essential cargo first at each port.`);
  for (const item of throughputFamily.slice(0, 3)) {
    const priorityCargo = state.ships.flatMap((ship) => ship.cargo).find((cargo) => !cargo.essential);
    addFamily(combinedFamily, { ...item.plan, scheduling: "balanced", ...(priorityCargo ? { cargoPrioritiesByBatch: { [priorityCargo.cargoId]: 2 } } : {}) }, `${item.name} with balanced scheduling`, `${item.summary} Balance deadline risk and vessel arrival order.`);
  }
  definitions.push(combinedFamily);

  // Round-robin strategy families so staging or priorities cannot crowd reroutes and combined plans out of the evaluation budget.
  const candidates = [baseline];
  const signatures = new Set([planSignature(baseline)]);
  for (let index = 0; candidates.length < 40; index++) {
    let found = false;
    for (const family of definitions) {
      const item = family[index];
      if (!item) continue;
      found = true;
      const signature = planSignature(item.plan);
      if (!signatures.has(signature)) {
        signatures.add(signature);
        candidates.push(makeStrategy(state, item.plan, item.name, item.summary));
        if (candidates.length === 40) break;
      }
    }
    if (!found) break;
  }
  return candidates;
}

export function generateStrategyForPlan(state: SimulationState, value: unknown, horizonHours = DEFAULT_SIMULATION_OPTIONS.horizonHours): RecoveryStrategy | undefined {
  if (!isRecoveryPlan(value) || !isFeasible(state, value, horizonHours)) return undefined;
  const plan = value;
  const namedAssignments = Object.entries(plan.assignments).filter(([vesselId, portId]) => state.ships.find((ship) => ship.vesselId === vesselId)?.destinationPortId !== portId);
  const name = namedAssignments.length ? namedAssignments.map(([vesselId, portId]) => `Reroute ${vesselId} to ${portId}`).join(" · ") : "Custom recovery plan";
  const changes = [
    plan.scheduling !== "arrival-order" && `${plan.scheduling} scheduling`,
    ...Object.entries(plan.stagingWindowsByVessel).map(([vesselId, window]) => `stage ${vesselId} ${window.durationHours}h from T+${window.startHour}h`),
    ...Object.keys(plan.cargoPrioritiesByBatch).map((cargoId) => `raise ${cargoId} priority`),
    plan.reserveBerthForCriticalCargo && "reserve a berth for critical cargo",
    plan.criticalCapacityReservation && `reserve ${plan.criticalCapacityReservation.percent}% throughput during T+${plan.criticalCapacityReservation.startHour}–${plan.criticalCapacityReservation.endHour}h`,
    ...namedAssignments.map(([vesselId, portId]) => `reroute ${vesselId} to ${portId}`),
  ].filter(Boolean);
  return makeStrategy(state, plan, name, changes.join("; ") || "Process vessels in estimated arrival order with available port capacity.");
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
  checkpoint?: SimulationCheckpoint;
}

interface PortFactors {
  capacityFactor: number;
  unloadingFactor: number;
  weatherVariation: number;
  availableUnloadingResources: number;
  capacityCredit: number;
}

export interface SimulationCheckpoint {
  hour: number;
  nextStepIndex: number;
  jobs: VesselJob[];
  portFactors: Map<string, PortFactors>;
  totalProcessed: number;
  nominalCapacity: number;
  criticalOnTimeContainers: number;
  delayContainerHours: number;
  estimatedDelayCost: number;
  snapshots?: OperationalSnapshot[];
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
  stopAtHour?: number,
  resume?: SimulationCheckpoint,
  continueCurrentPlan = false,
): Trial {
  const startMs = Date.parse(state.startAt);
  const activeStrategy = resume && !continueCurrentPlan ? {
    ...strategy,
    stagingWindowsByVessel: Object.fromEntries(Object.entries(strategy.stagingWindowsByVessel).map(([id, window]) => [id, { ...window, startHour: window.startHour + resume.hour }])),
    criticalCapacityReservation: strategy.criticalCapacityReservation ? {
      ...strategy.criticalCapacityReservation,
      startHour: strategy.criticalCapacityReservation.startHour + resume.hour,
      endHour: strategy.criticalCapacityReservation.endHour + resume.hour,
    } : null,
  } : strategy;
  const order = resume
    ? activeStrategy.actions.filter((action) => action.type === "schedule").map((action) => action.vesselId)
    : orderFor(state, activeStrategy.scheduling, activeStrategy.assignments).map((ship) => ship.vesselId);
  const orderIndex = new Map(order.map((vesselId, index) => [vesselId, index]));
  const jobs: VesselJob[] = resume ? resume.jobs.map((job) => ({ ...job, cargo: job.cargo.map((item) => ({ ...item })) })) : state.ships.map((ship) => {
    const arrivalHour = Math.max(0, (Date.parse(ship.estimatedArrival) - startMs) / 3_600_000 + random() * options.maxArrivalDelayHours);
    const staging = activeStrategy.stagingWindowsByVessel[ship.vesselId];
    return {
      ship,
      portId: strategy.assignments[ship.vesselId],
      arrivalHour,
      eligibleHour: staging ? Math.max(arrivalHour, staging.startHour) + staging.durationHours : arrivalHour,
      status: "scheduled",
      berthId: null,
      berthAtHour: null,
      departureHour: null,
      cargo: ship.cargo.map((cargo, manifestIndex) => ({ cargo, manifestIndex, containersUnloaded: 0, completedAtHour: null })),
    };
  });
  const portFactors = resume ? new Map([...resume.portFactors].map(([id, factors]) => [id, { ...factors }])) : new Map<string, PortFactors>(state.ports.map((port): [string, PortFactors] => {
    const capacityFactor = 1 - random() * options.capacityReductionVariation;
    const unloadingFactor = 1 + random() * options.unloadingTimeVariation;
    const weatherVariation = (random() * 2 - 1) * options.weatherSeverityVariation;
    const resourceFailure = random() < options.equipmentFailureProbability;
    const availableUnloadingResources = Math.max(0, port.unloadingResources - (resourceFailure ? 1 : 0));
    return [port.portId, { capacityFactor, unloadingFactor, weatherVariation, availableUnloadingResources, capacityCredit: 0 }];
  }));
  if (resume) for (const job of jobs) {
    if (job.status === "departed" || job.berthId) continue;
    if (activeStrategy.assignments[job.ship.vesselId]) job.portId = activeStrategy.assignments[job.ship.vesselId];
    const staging = activeStrategy.stagingWindowsByVessel[job.ship.vesselId];
    if (!continueCurrentPlan) job.eligibleHour = staging ? Math.max(job.arrivalHour, staging.startHour) + staging.durationHours : job.arrivalHour;
  }
  const allCargo = jobs.flatMap((job) => job.cargo);
  const criticalContainerCount = allCargo.reduce((sum, item) => sum + (item.cargo.essential ? item.cargo.containers : 0), 0);
  const totalCargoContainers = allCargo.reduce((sum, item) => sum + item.cargo.containers, 0);
  const hasCompleteCostInputs = allCargo.length > 0 && allCargo.every((item) => item.cargo.delayCostPerContainerHour !== undefined);
  const reroutedJobs = jobs.filter((job) => job.portId !== job.ship.destinationPortId);
  const hasCompleteRerouteCostInputs = reroutedJobs.every((job) => state.ports.find((port) => port.portId === job.portId)?.rerouteCostPerContainer !== undefined);
  const estimatedInterventionCost = hasCompleteRerouteCostInputs
    ? reroutedJobs.reduce((sum, job) => sum + containersFor(job.ship) * state.ports.find((port) => port.portId === job.portId)!.rerouteCostPerContainer!, 0)
    : null;
  let totalProcessed = resume?.totalProcessed ?? 0;
  let nominalCapacity = resume?.nominalCapacity ?? 0;
  let criticalOnTimeContainers = resume?.criticalOnTimeContainers ?? 0;
  let delayContainerHours = resume?.delayContainerHours ?? 0;
  let estimatedDelayCost = resume?.estimatedDelayCost ?? 0;
  const snapshots: OperationalSnapshot[] | undefined = captureReplay || resume?.snapshots ? [...(resume?.snapshots ?? [])] : undefined;
  const totalStepCount = Math.ceil(options.horizonHours / options.timeStepHours);

  const activeDisruptionsAt = (port: SimulationState["ports"][number], hour: number) => port.activeDisruptions
    .filter((disruption) => disruption.startHour <= hour && hour < disruption.startHour + disruption.durationHours);

  const closedBerthsAt = (port: SimulationState["ports"][number], hour: number) => new Set(
    activeDisruptionsAt(port, hour).filter((disruption) => disruption.severity > 0).flatMap((disruption) => disruption.closedBerthIds ?? []),
  );
  const clearClosedBerths = (hour: number) => {
    for (const port of state.ports) {
      const closed = closedBerthsAt(port, hour);
      for (const job of jobs) if (job.portId === port.portId && job.berthId && closed.has(job.berthId)) {
        job.status = "waiting";
        job.berthId = null;
        job.berthAtHour = null;
      }
    }
  };

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

  if (!resume) {
    updateArrivals(0);
    captureSnapshot(0, new Map(), new Set());
  }

  for (let stepIndex = resume?.nextStepIndex ?? 0; stepIndex < totalStepCount; stepIndex++) {
    const startHour = stepIndex * options.timeStepHours;
    const endHour = Math.min(options.horizonHours, startHour + options.timeStepHours);
    const elapsedHours = endHour - startHour;
    updateArrivals(startHour);
    clearClosedBerths(startHour);
    const unloadedByPort = new Map<string, number>();
    const unloadingVesselIds = new Set<string>();

    for (const port of state.ports) {
      const factors = portFactors.get(port.portId)!;
      const intervalCapacity = Array.from({ length: elapsedHours }, (_, hour) => effectiveCapacityPerHour(port.portId, startHour + hour))
        .reduce((sum, capacity) => sum + capacity, 0);
      const hourlyCapacity = elapsedHours ? intervalCapacity / elapsedHours : 0;
      nominalCapacity += intervalCapacity;
      const portJobs = jobs.filter((job) => job.portId === port.portId);
      const closedBerths = closedBerthsAt(port, startHour);
      const openBerthCount = Math.max(0, port.availableBerths - closedBerths.size);
      const freeBerthIds = Array.from({ length: Math.max(0, port.availableBerths) }, (_, index) => `${port.portId}-berth-${index + 1}`)
        .filter((berthId) => !closedBerths.has(berthId) && !portJobs.some((job) => job.berthId === berthId));
      const criticalPending = activeStrategy.reserveBerthForCriticalCargo && portJobs.some((job) => job.status !== "departed" && hasRemainingCriticalCargo(job));
      const criticalAlreadyBerthed = portJobs.some((job) => job.status === "berthed" && hasRemainingCriticalCargo(job));
      const reserveCriticalBerth = criticalPending && !criticalAlreadyBerthed;
      const noncriticalBerthLimit = reserveCriticalBerth ? Math.max(0, openBerthCount - 1) : openBerthCount;
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
      const unloadingSlots = Math.min(factors.availableUnloadingResources, openBerthCount);
      const unloading = unloadingSlots > 0 && activeStrategy.reserveBerthForCriticalCargo && criticalBerthed.length
        ? [...criticalBerthed.slice(0, 1), ...berthed.filter((job) => job !== criticalBerthed[0]).slice(0, Math.max(0, unloadingSlots - 1))]
        : berthed.slice(0, unloadingSlots);

      const cargoQueue = unloading.flatMap((job) => job.cargo.filter((item) => item.containersUnloaded < item.cargo.containers).map((item) => ({ job, item })));
      cargoQueue.sort((left, right) => {
        const explicitPriority = (activeStrategy.cargoPrioritiesByBatch[right.item.cargo.cargoId] ?? 0) - (activeStrategy.cargoPrioritiesByBatch[left.item.cargo.cargoId] ?? 0);
        if (explicitPriority) return explicitPriority;
        if (activeStrategy.scheduling === "critical-first") {
          const criticality = Number(right.item.cargo.essential) - Number(left.item.cargo.essential);
          if (criticality) return criticality;
          const deadline = Date.parse(left.item.cargo.deadline) - Date.parse(right.item.cargo.deadline);
          if (deadline) return deadline;
        } else if (activeStrategy.scheduling === "deadline-risk-first" || activeStrategy.scheduling === "balanced") {
          const slack = (entry: typeof left) => (Date.parse(entry.item.cargo.deadline) - startMs) / 3_600_000
            - entry.job.arrivalHour - entry.item.cargo.containers / Math.max(0.01, hourlyCapacity);
          const risk = (entry: typeof left) => slack(entry) - (activeStrategy.scheduling === "balanced" && entry.item.cargo.essential ? 12 : 0);
          const slackDifference = risk(left) - risk(right);
          if (slackDifference) return slackDifference;
          const criticality = Number(right.item.cargo.essential) - Number(left.item.cargo.essential);
          if (criticality) return criticality;
        }
        return orderIndex.get(left.job.ship.vesselId)! - orderIndex.get(right.job.ship.vesselId)!
          || left.item.manifestIndex - right.item.manifestIndex;
      });

      const capacityCredit = factors.capacityCredit + hourlyCapacity * elapsedHours;
      let availableContainers = Math.floor(capacityCredit);
      factors.capacityCredit = capacityCredit - availableContainers;
      if (!unloading.length) availableContainers = 0;
      let processedThisStep = 0;
      const processCargo = (queue: typeof cargoQueue, limit = availableContainers) => {
        let processed = 0;
        for (const { job, item } of queue) {
          const containersUnloaded = Math.min(availableContainers, limit - processed, item.cargo.containers - item.containersUnloaded);
          if (containersUnloaded <= 0) continue;
          item.containersUnloaded += containersUnloaded;
          availableContainers -= containersUnloaded;
          processed += containersUnloaded;
          unloadingVesselIds.add(job.ship.vesselId);
          const deadlineHour = (Date.parse(item.cargo.deadline) - startMs) / 3_600_000;
          const delayHours = Math.max(0, endHour - deadlineHour);
          delayContainerHours += containersUnloaded * delayHours;
          if (item.cargo.essential && endHour <= deadlineHour) criticalOnTimeContainers += containersUnloaded;
          if (hasCompleteCostInputs) estimatedDelayCost += containersUnloaded * delayHours * (item.cargo.delayCostPerContainerHour ?? 0);
          if (item.containersUnloaded === item.cargo.containers) item.completedAtHour = endHour;
          if (availableContainers === 0 || processed === limit) break;
        }
        return processed;
      };
      const criticalQueue = cargoQueue.filter(({ item }) => item.cargo.essential);
      const standardQueue = cargoQueue.filter(({ item }) => !item.cargo.essential);
      const reservationWindow = activeStrategy.criticalCapacityReservation;
      const reservationHours = reservationWindow
        ? Math.max(0, Math.min(endHour, reservationWindow.endHour) - Math.max(startHour, reservationWindow.startHour)) : 0;
      const reservation = reservationWindow && reservationHours > 0 && elapsedHours && criticalQueue.length && standardQueue.length
        ? Math.floor(availableContainers * reservationWindow.percent / 100 * reservationHours / elapsedHours) : 0;
      if (reservation > 0) {
        processedThisStep += processCargo(criticalQueue, reservation);
        processedThisStep += processCargo(standardQueue);
        processedThisStep += processCargo(criticalQueue);
      } else {
        processedThisStep = processCargo(cargoQueue);
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
    clearClosedBerths(endHour);
    captureSnapshot(endHour, unloadedByPort, unloadingVesselIds);
    if (stopAtHour !== undefined && endHour >= stopAtHour) return {
      metrics: {
        criticalCargoOnTimePercent: criticalContainerCount ? 100 * criticalOnTimeContainers / criticalContainerCount : 100,
        averageCargoDelayHours: totalCargoContainers ? delayContainerHours / totalCargoContainers : 0,
        totalContainersProcessed: totalProcessed,
        portUtilizationPercent: nominalCapacity ? Math.min(100, 100 * totalProcessed / nominalCapacity) : 0,
        delayedVessels: 0,
        estimatedDelayCost: hasCompleteCostInputs ? estimatedDelayCost : null,
        estimatedInterventionCost,
        estimatedDisruptionCost: hasCompleteCostInputs && estimatedInterventionCost !== null ? estimatedDelayCost + estimatedInterventionCost : null,
      },
      ...(snapshots ? { snapshots } : {}),
      checkpoint: {
        hour: endHour,
        nextStepIndex: stepIndex + 1,
        jobs: jobs.map((job) => ({ ...job, cargo: job.cargo.map((item) => ({ ...item })) })),
        portFactors: new Map([...portFactors].map(([id, factors]) => [id, { ...factors }])),
        totalProcessed,
        nominalCapacity,
        criticalOnTimeContainers,
        delayContainerHours,
        estimatedDelayCost,
        ...(snapshots ? { snapshots: [...snapshots] } : {}),
      },
    };
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
      estimatedInterventionCost,
      estimatedDisruptionCost: hasCompleteCostInputs && estimatedInterventionCost !== null ? estimatedDelayCost + estimatedInterventionCost : null,
    },
    ...(snapshots ? { snapshots } : {}),
  };
}

function summarizeTrials(trials: Trial[], options: SimulationOptions): SimulationSummary {
  const metricKeys: (keyof OutcomeMetrics)[] = ["criticalCargoOnTimePercent", "averageCargoDelayHours", "totalContainersProcessed", "portUtilizationPercent", "delayedVessels", "estimatedDelayCost", "estimatedInterventionCost", "estimatedDisruptionCost"];
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

export function simulateToCheckpoint(state: SimulationState, strategy: RecoveryStrategy, partialOptions: Partial<SimulationOptions>, hour: number): SimulationCheckpoint {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  if (!Number.isInteger(hour) || hour <= 0 || hour >= options.horizonHours || hour % options.timeStepHours !== 0) throw new Error("Replanning hour must be inside the horizon and align with the simulation time step.");
  const trial = simulateRun(state, strategy, options, seededRandom(options.seed), true, hour);
  if (!trial.checkpoint) throw new Error("Simulation did not reach the replanning checkpoint.");
  return trial.checkpoint;
}

export function remainingStateAtCheckpoint(state: SimulationState, checkpoint: SimulationCheckpoint): SimulationState {
  const startAt = new Date(Date.parse(state.startAt) + checkpoint.hour * 3_600_000).toISOString();
  const jobs = checkpoint.jobs.filter((job) => job.status !== "departed" && hasRemainingCargo(job));
  return {
    ...state,
    scenarioId: `${state.scenarioId}-replan-${checkpoint.hour}`,
    startAt,
    ports: state.ports.map((port) => ({
      ...port,
      availableBerths: Math.max(0, port.availableBerths - jobs.filter((job) => job.portId === port.portId && job.status === "berthed").length),
      unloadingResources: Math.max(0, port.unloadingResources - jobs.filter((job) => job.portId === port.portId && job.status === "berthed").length),
      queueShipIds: jobs.filter((job) => job.portId === port.portId).map((job) => job.ship.vesselId),
      activeDisruptions: port.activeDisruptions.flatMap((disruption) => {
        const endHour = disruption.startHour + disruption.durationHours;
        if (endHour <= checkpoint.hour) return [];
        const activeStart = Math.max(checkpoint.hour, disruption.startHour);
        return [{ ...disruption, startHour: activeStart - checkpoint.hour, durationHours: endHour - activeStart }];
      }),
    })),
    ships: jobs.map((job) => ({
      ...job.ship,
      destinationPortId: job.portId,
      estimatedArrival: job.status === "scheduled"
        ? new Date(Date.parse(state.startAt) + Math.max(checkpoint.hour, job.arrivalHour) * 3_600_000).toISOString()
        : startAt,
      eligibleAlternativePortIds: job.status === "scheduled" && job.portId === job.ship.destinationPortId
        ? job.ship.eligibleAlternativePortIds.filter((id) => id !== job.portId) : [],
      cargo: job.cargo.filter((item) => item.containersUnloaded < item.cargo.containers).map((item) => ({
        ...item.cargo,
        containers: item.cargo.containers - item.containersUnloaded,
      })),
    })),
    weather: state.weather.map((weather) => ({
      ...weather,
      forecasts: weather.forecasts.filter((point) => Date.parse(point.at) >= Date.parse(startAt)),
    })),
  };
}

export function simulateFromCheckpoint(state: SimulationState, strategy: RecoveryStrategy, partialOptions: Partial<SimulationOptions>, checkpoint: SimulationCheckpoint, continueCurrentPlan = false): { summary: SimulationSummary; replay: SimulationReplay } {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const trial = simulateRun(state, strategy, options, seededRandom(options.seed), true, undefined, checkpoint, continueCurrentPlan);
  const summary = summarizeTrials([trial], { ...options, runs: 1 });
  return {
    summary,
    replay: { seed: options.seed, sampleRunIndex: 0, timeStepHours: options.timeStepHours, snapshots: trial.snapshots ?? [] },
  };
}

export function simulateAdaptiveStrategyWithReplay(
  state: SimulationState,
  initialStrategy: RecoveryStrategy,
  adaptiveStrategy: RecoveryStrategy,
  partialOptions: Partial<SimulationOptions>,
  replanHour: number,
  firstCheckpoint?: SimulationCheckpoint,
  continueCurrentPlan = false,
): { summary: SimulationSummary; replay: SimulationReplay } {
  const options = { ...DEFAULT_SIMULATION_OPTIONS, ...partialOptions };
  const random = seededRandom(options.seed);
  if (firstCheckpoint) for (let draw = 0; draw < state.ships.length + state.ports.length * 4; draw++) random();
  const trials = Array.from({ length: options.runs }, (_, index) => {
    const checkpoint = index === 0 && firstCheckpoint ? firstCheckpoint : simulateRun(state, initialStrategy, options, random, index === 0, replanHour).checkpoint;
    if (!checkpoint) throw new Error("Simulation did not reach the replanning checkpoint.");
    return simulateRun(state, adaptiveStrategy, options, random, index === 0, undefined, checkpoint, continueCurrentPlan);
  });
  return {
    summary: summarizeTrials(trials, options),
    replay: { seed: options.seed, sampleRunIndex: 0, timeStepHours: options.timeStepHours, snapshots: trials[0].snapshots ?? [] },
  };
}
