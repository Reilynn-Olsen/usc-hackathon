export type Tab = "overview" | "simulations" | "about";
export type CargoType = "Medical supplies" | "Food & perishables" | "Industrial goods" | "Consumer goods" | "Energy equipment";
export type Priority = "Critical" | "High" | "Standard";
export type Ship = {
  id: string;
  name: string;
  callSign: string;
  cargo: CargoType;
  containers: number;
  priority: Priority;
  eta: string;
  status: string;
  progress: number;
  color: string;
  route: [number, number][];
};

export const SHIPS: Ship[] = [
  { id: "PM-104", name: "Pacific Meridian", callSign: "WDM4821", cargo: "Medical supplies", containers: 1240, priority: "Critical", eta: "04:20", status: "Approaching berth", progress: 0.76, color: "#62e1d1", route: [[-63,-30],[-44,-27],[-22,-20],[4,-15],[26,-16]] },
  { id: "BH-208", name: "Blue Horizon", callSign: "VRJD7", cargo: "Food & perishables", containers: 2180, priority: "High", eta: "06:45", status: "Inbound", progress: 0.54, color: "#f5ba65", route: [[-65,23],[-44,18],[-17,13],[6,5],[27,2]] },
  { id: "NL-312", name: "Northern Light", callSign: "KLP9084", cargo: "Consumer goods", containers: 3420, priority: "Standard", eta: "09:15", status: "Inbound", progress: 0.30, color: "#7d9cc7", route: [[-67,-1],[-42,0],[-14,1],[8,10],[27,13]] },
  { id: "OS-087", name: "Ocean Sentinel", callSign: "WPH6110", cargo: "Energy equipment", containers: 960, priority: "High", eta: "05:30", status: "At anchorage", progress: 0.86, color: "#8ba5e8", route: [[-61,-43],[-35,-36],[-12,-29],[11,-22],[27,-25]] },
  { id: "AT-521", name: "Atlas Trader", callSign: "MKG4012", cargo: "Industrial goods", containers: 2870, priority: "Standard", eta: "11:05", status: "Inbound", progress: 0.19, color: "#87a5c4", route: [[-69,40],[-48,31],[-24,23],[3,21],[26,24]] },
  { id: "SC-640", name: "Seaway Crest", callSign: "C6TW2", cargo: "Food & perishables", containers: 1650, priority: "High", eta: "07:50", status: "Inbound", progress: 0.42, color: "#f5ba65", route: [[-69,-52],[-50,-41],[-28,-35],[-3,-35],[26,-35]] },
];

export type ScenarioId = "storm" | "fog" | "wind" | "outage";
export type Scenario = {
  id: ScenarioId;
  label: string;
  kicker: string;
  description: string;
  impact: string;
  intensity: number;
  zone: { x: number; z: number; radius: number; color: string };
  icon: "storm" | "fog" | "wind" | "outage";
};

export const SCENARIOS: Scenario[] = [
  { id: "storm", label: "Coastal storm", kicker: "SEVERE WEATHER", description: "A fast-moving storm restricts unloading and creates a high-risk approach corridor.", impact: "60% terminal capacity loss", intensity: 60, zone: { x: -4, z: -13, radius: 24, color: "#e8a458" }, icon: "storm" },
  { id: "fog", label: "Dense marine fog", kicker: "VISIBILITY EVENT", description: "Reduced visibility slows channel transit and forces longer vessel separation.", impact: "35% capacity loss", intensity: 35, zone: { x: -17, z: 6, radius: 27, color: "#93b4da" }, icon: "fog" },
  { id: "wind", label: "Extreme crosswinds", kicker: "WIND ADVISORY", description: "Strong gusts suspend crane operations across exposed container terminals.", impact: "45% capacity loss", intensity: 45, zone: { x: 17, z: -7, radius: 19, color: "#e8a458" }, icon: "wind" },
  { id: "outage", label: "Terminal equipment failure", kicker: "INFRASTRUCTURE", description: "A yard-crane and gate system failure reduces unloading and landside throughput.", impact: "50% capacity loss", intensity: 50, zone: { x: 30, z: 4, radius: 12, color: "#e4777a" }, icon: "outage" },
];

export type ActionId = "critical" | "stagger" | "trucks" | "divert";
export type Action = { id: ActionId; name: string; detail: string; benefit: string; recommended: boolean };
export const ACTIONS: Action[] = [
  { id: "critical", name: "Prioritize critical cargo", detail: "Assign the next open berth to medical and perishable shipments.", benefit: "Protects priority deadlines", recommended: true },
  { id: "stagger", name: "Stagger vessel arrivals", detail: "Hold standard-priority ships offshore to reduce queuing at the channel.", benefit: "Reduces berth congestion", recommended: true },
  { id: "trucks", name: "Reserve landside capacity", detail: "Protect available truck and terminal slots for time-sensitive containers.", benefit: "Faster cargo release", recommended: true },
  { id: "divert", name: "Divert a standard shipment", detail: "Test a diversion to another terminal with extra transit and handling costs.", benefit: "Frees one docking window", recommended: false },
];

export type ActionState = Record<ActionId, boolean>;
export const EMPTY_ACTIONS: ActionState = { critical: false, stagger: false, trucks: false, divert: false };
export const RECOMMENDED_ACTIONS: ActionState = { critical: true, stagger: true, trucks: true, divert: false };

export type Outcome = {
  criticalOnTime: number;
  averageDelay: number;
  cargoAtRisk: number;
  operatingCost: number;
  recoveredHours: number;
};

/** A small, deterministic *illustrative* model, not real port forecasts or Jev output. */
export function estimateOutcome(scenarioId: ScenarioId, capacityLoss: number, duration: number, actions: ActionState): Outcome {
  const drag = (capacityLoss / 100) * (0.66 + duration / 36);
  const disruption = scenarioId === "storm" ? 1.12 : scenarioId === "fog" ? 0.76 : scenarioId === "wind" ? 0.9 : 1.03;
  const baseOnTime = 94 - drag * 55 * disruption;
  const baseDelay = 0.8 + drag * 11.2 * disruption;
  const gain = (actions.critical ? 12 : 0) + (actions.stagger ? 7 : 0) + (actions.trucks ? 6 : 0) + (actions.divert ? 3 : 0);
  const delayGain = (actions.critical ? 1.0 : 0) + (actions.stagger ? 2.2 : 0) + (actions.trucks ? 1.0 : 0) + (actions.divert ? 0.75 : 0);
  const extraCost = (actions.critical ? 14 : 0) + (actions.stagger ? 9 : 0) + (actions.trucks ? 18 : 0) + (actions.divert ? 74 : 0);
  const onTime = Math.min(98, Math.max(18, baseOnTime + gain * (0.65 + drag * 0.55)));
  const delay = Math.max(0.7, baseDelay - delayGain * (0.55 + drag * 0.4));
  const risk = Math.max(35, Math.round(1920 * drag * disruption - gain * 24));
  const cost = Math.round(42 + (drag * 160 * disruption) + extraCost);
  return {
    criticalOnTime: Math.round(onTime),
    averageDelay: Number(delay.toFixed(1)),
    cargoAtRisk: risk,
    operatingCost: cost,
    recoveredHours: Math.max(0, Number((baseDelay - delay).toFixed(1))),
  };
}
