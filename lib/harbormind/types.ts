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

export interface Port {
  portId: string;
  location: { name: string; latitude: number; longitude: number };
  normalCapacityContainersPerDay: number;
  currentCapacityContainersPerDay: number;
  availableBerths: number;
  unloadingResources: number;
  queueShipIds: string[];
  activeDisruptions: Array<{ id: string; description: string; severity: number }>;
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
    weather: ProvenanceSource;
    weatherAlerts: ProvenanceSource | "unavailable";
  };
}

export type StrategyAction =
  | { type: "schedule"; vesselId: string; portId: string }
  | { type: "prioritize"; vesselIds: string[]; reason: string }
  | { type: "delay"; vesselId: string; hours: number; reason: string }
  | { type: "allocate-resources"; portId: string; concurrentVessels: number }
  | { type: "reroute"; vesselId: string; fromPortId: string; toPortId: string };

export interface RecoveryStrategy {
  id: string;
  name: string;
  summary: string;
  scheduling: "arrival-order" | "critical-first";
  resourceMode: "available" | "dedicated-priority";
  holdNonessentialHours: number;
  assignments: Record<string, string>;
  actions: StrategyAction[];
}

export interface SimulationOptions {
  runs: number;
  seed: number;
  horizonHours: number;
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
}

export interface SimulationSummary {
  mean: OutcomeMetrics;
  targetCriticalCargoOnTimePercent: number;
  probabilityOfMeetingTarget: number;
  runs: number;
  seed: number;
  horizonHours: number;
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
}
