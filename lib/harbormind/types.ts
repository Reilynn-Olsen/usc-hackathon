export type DataSource = "live" | "cached" | "synthetic";
export type ProvenanceSource = DataSource | "mixed";

export interface Cargo {
  cargoId: string;
  category: string;
  containers: number;
  essential: boolean;
  deadline: string;
  delayCostPerContainerHour?: number;
  specialHandling: string[];
  source: DataSource;
}

export interface PortDisruption {
  id: string;
  description: string;
  severity: number;
  startHour: number;
  durationHours: number;
}

export interface Port {
  portId: string;
  location: { name: string; latitude: number; longitude: number };
  normalCapacityContainersPerDay: number;
  currentCapacityContainersPerDay: number;
  availableBerths: number;
  unloadingResources: number;
  rerouteCostPerContainer?: number;
  queueShipIds: string[];
  activeDisruptions: PortDisruption[];
  supportedHandling: string[];
  source: DataSource;
}

export interface Ship {
  vesselId: string;
  mmsi?: string;
  position: { latitude: number; longitude: number };
  heading: number;
  speedKnots: number;
  estimatedArrival: string;
  destinationPortId: string;
  eligibleAlternativePortIds: string[];
  cargo: Cargo[];
  positionSource: DataSource;
  operationsSource: DataSource;
}

export interface SimulationState {
  scenarioId: string;
  startAt: string;
  ports: Port[];
  ships: Ship[];
  weather: {
    portId: string;
    forecasts: Array<{
      at: string;
      windSpeedKph: number;
      windGustKph: number;
      waveHeightM: number;
      precipitationMm: number;
    }>;
    alerts: Array<{ id: string; description: string; severity: number }>;
    source: DataSource;
    alertsSource: DataSource | "unavailable";
  }[];
  provenance: {
    ports: ProvenanceSource;
    shipPositions: ProvenanceSource;
    shipEtaAndCargo: ProvenanceSource;
    weather: ProvenanceSource | "unavailable";
    weatherAlerts: ProvenanceSource | "unavailable";
  };
}

export type OptimizationObjective = "critical-delivery" | "minimize-delay" | "minimize-cost" | "balanced";

export interface DecisionCriteria {
  objective: OptimizationObjective;
  maximumDisruptionCost?: number;
}

export type SchedulingPolicy = "arrival-order" | "critical-first" | "deadline-risk-first" | "balanced";

export interface VesselStagingWindow {
  startHour: number;
  durationHours: 2 | 4 | 8 | 12;
}

export type CargoPriority = 1 | 2 | 3;

export interface CriticalCapacityReservation {
  percent: number;
  startHour: number;
  endHour: number;
}

export interface RecoveryPlan {
  scheduling: SchedulingPolicy;
  stagingWindowsByVessel: Record<string, VesselStagingWindow>;
  cargoPrioritiesByBatch: Record<string, CargoPriority>;
  reserveBerthForCriticalCargo: boolean;
  criticalCapacityReservation: CriticalCapacityReservation | null;
  assignments: Record<string, string>;
  objective: OptimizationObjective;
  minimumCriticalCargoOnTimePercent: number;
  maximumDisruptionCost: number | null;
}

export type StrategyAction =
  | { type: "schedule"; vesselId: string; portId: string }
  | { type: "prioritize"; vesselIds: string[]; reason: string }
  | { type: "delay"; vesselId: string; startHour: number; hours: number; reason: string }
  | { type: "allocate-resources"; portId: string; concurrentVessels: number }
  | { type: "reserve-throughput"; criticalPercent: number; startHour: number; endHour: number }
  | { type: "cargo-priority"; cargoId: string; priority: number }
  | { type: "reroute"; vesselId: string; fromPortId: string; toPortId: string };

export interface RecoveryStrategy extends RecoveryPlan {
  id: string;
  name: string;
  summary: string;
  actions: StrategyAction[];
}

export interface SimulationOptions {
  runs: number;
  seed: number;
  horizonHours: number;
  timeStepHours: number;
  criticalCargoOnTimeTargetPercent: number;
  maxArrivalDelayHours: number;
  weatherSeverityVariation: number;
  capacityReductionVariation: number;
  unloadingTimeVariation: number;
  equipmentFailureProbability: number;
}

export interface OutcomeMetrics {
  criticalCargoOnTimePercent: number;
  averageCargoDelayHours: number;
  totalContainersProcessed: number;
  portUtilizationPercent: number;
  delayedVessels: number;
  estimatedDelayCost: number | null;
  estimatedInterventionCost: number | null;
  estimatedDisruptionCost: number | null;
}

export interface SimulationSummary {
  mean: OutcomeMetrics;
  targetCriticalCargoOnTimePercent: number;
  probabilityOfMeetingTarget: number;
  runs: number;
  seed: number;
  horizonHours: number;
  timeStepHours: number;
}

export interface CargoBatchSnapshot {
  batchId: string;
  vesselId: string;
  category: string;
  criticality: "critical" | "standard";
  deadline: string;
  specialHandling: string[];
  containers: number;
  containersUnloaded: number;
  containersRemaining: number;
  status: "not-arrived" | "waiting" | "unloading" | "completed";
}

export interface OperationalSnapshot {
  simulationHour: number;
  ports: Array<{
    portId: string;
    capacityContainersPerHour: number;
    activeDisruptions: Port["activeDisruptions"];
    waitingVesselIds: string[];
    berthAssignments: Array<{ berthId: string; vesselId: string }>;
    containersUnloadedThisStep: number;
  }>;
  vessels: Array<{
    vesselId: string;
    portId: string;
    status: "scheduled" | "waiting" | "berthed" | "departed";
    arrivalHour: number;
    berthId: string | null;
    berthAtHour: number | null;
    departureHour: number | null;
  }>;
  cargoBatches: CargoBatchSnapshot[];
  completedCargoBatchIds: string[];
  cargoAtRisk: Array<{ batchId: string; vesselId: string; containersRemaining: number; deadlinePassed: boolean }>;
}

export interface SimulationReplay {
  seed: number;
  sampleRunIndex: number;
  timeStepHours: number;
  snapshots: OperationalSnapshot[];
}

export interface JevSelection {
  strategyId: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevAssessment {
  model: string;
  selection: JevSelection;
  cargoUrgency: {
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
    legend: Record<string, string>;
  };
  operationalRisk: {
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
    legend: Record<string, string>;
  };
  humanReviewProbability: number;
  timeCriticalProbability: number;
}

export interface Recommendation {
  scenarioId: string;
  generatedAt: string;
  selectedStrategyId: string;
  recommendationSummary: string;
  decisionExplanation: string;
  actions: StrategyAction[];
  affectedShips: string[];
  affectedCargo: string[];
  estimatedOutcomes: SimulationSummary;
  baselineComparison: {
    baselineStrategyId: string;
    baseline: SimulationSummary;
    selected: SimulationSummary;
    criticalCargoOnTimeChangePercent: number;
  };
  jev: JevAssessment | null;
  aiGenerated: boolean;
  decisionSource: "jev" | "mock" | "fallback";
  fallbackReason?: string;
  simulatedOutcomeLikelihoods: {
    probabilityOfMeetingTarget: number;
    runs: number;
    seed: number;
  };
  riskIndicators: string[];
  humanReviewRecommended: boolean;
  humanApprovalRequired: true;
  dataProvenance: SimulationState["provenance"];
  warnings: string[];
  decisionAudit: {
    objective: OptimizationObjective;
    minimumCriticalCargoOnTimePercent: number;
    maximumDisruptionCost: number | null;
    selectedStrategyId: string;
    fallback: boolean;
    candidates: Array<{
      strategyId: string;
      name: string;
      plan: RecoveryPlan;
      actions: StrategyAction[];
      metrics: OutcomeMetrics;
      probabilityOfMeetingTarget: number;
      meetsConstraints: boolean;
      selectionEligible: boolean;
    }>;
  };
}
