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
export type Action = { id: ActionId; name: string; detail: string; benefit: string };
export const ACTIONS: Action[] = [
  { id: "critical", name: "Prioritize critical cargo", detail: "Schedule ships with essential cargo ahead of other vessels.", benefit: "Uses explicit cargo deadlines" },
  { id: "stagger", name: "Stagger vessel arrivals", detail: "Hold lower-priority vessels for eight hours while essential cargo moves first.", benefit: "Uses modeled vessel arrival holds" },
  { id: "trucks", name: "Reserve unloading capacity", detail: "Limit concurrent unloading so essential cargo can use a dedicated position.", benefit: "Uses modeled berths and unloading resources" },
  { id: "divert", name: "Divert a standard shipment", detail: "Reroute an eligible nonessential vessel to a modeled alternative port.", benefit: "Only offered for feasible alternative ports" },
];

export type ActionState = Record<ActionId, boolean>;
export const EMPTY_ACTIONS: ActionState = { critical: false, stagger: false, trucks: false, divert: false };
