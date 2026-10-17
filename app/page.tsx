"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import PortMap3D, { type MapCommand } from "./components/PortMap3D";
import RecoveryPlanner from "./components/RecoveryPlanner";
import { SCENARIOS, SHIPS, type ScenarioId, type Tab } from "./lib/data";
import { Icon } from "./lib/icons";
import type { OperationalSnapshot, OptimizationObjective, Recommendation, RecoveryPlan, RecoveryStrategy, SimulationOptions, SimulationReplay, SimulationState, SimulationSummary } from "../lib/harbormind/types.ts";
import { applyOpenMeteoForecast } from "../lib/harbormind/adapters.ts";
import { configureScenarioState, copyRecoveryPlan, isLatestScenarioRequest, recoveryPlanForStrategy, replayForMode, sameRecoveryPlan, scenarioSignature, snapshotAtHour } from "./lib/scenario";

type EvaluatedStrategy = { strategy: RecoveryStrategy; outcome: SimulationSummary; affectedShips: string[]; affectedCargo: string[] };
type RecommendationPayload = { recommendation: Recommendation; availableStrategies: RecoveryStrategy[]; evaluatedStrategies: EvaluatedStrategy[] };
type AdaptiveCandidateComparison = { strategyId: string; strategyName: string; actions: RecoveryStrategy["actions"]; outcome: SimulationSummary; remainingCriticalCargoOnTimePercent: number; feasible: boolean; meetsMandatoryConstraints: boolean };
type AdaptivePayload = { atHour: number; event: { id: string; description: string; severity: number; startHour: number; durationHours: number; portId: string }; noIntervention: SimulationSummary; initialPlan: SimulationSummary; initialPlanWithoutNewDisruption: SimulationSummary; outcome: SimulationSummary; replay: SimulationReplay; recommendation: Recommendation; decisionQuality: { originalChoice: { strategyId: string; strategyName: string; source: "jev" | "mock" | "fallback" }; appliedStrategy: { strategyId: string; strategyName: string }; overridden: boolean; status: string; explanation: string; checkpoint: { hour: number; snapshot: OperationalSnapshot | null }; comparison: { continueCurrentPlan: AdaptiveCandidateComparison; proposedPlan: AdaptiveCandidateComparison } }; availableStrategies: RecoveryStrategy[]; evaluatedStrategies: EvaluatedStrategy[]; decisionHistory: Array<{ hour: number; strategyId: string; strategyName: string; decisionSource: string; changedParameters: string[]; measuredOutcome: SimulationSummary["mean"] }> };
type SimulationPayload = { strategyId: string; outcome: SimulationSummary; baseline: SimulationSummary; strategy: RecoveryStrategy; replay: SimulationReplay; baselineReplay?: SimulationReplay; adaptive?: AdaptivePayload };
type ScenarioRun = { state: SimulationState; options: Partial<SimulationOptions>; signature: string; payload: RecommendationPayload; simulation: SimulationPayload };
type PlanSnapshot = { plan: RecoveryPlan; strategyId: string; outcome: SimulationSummary; replay: SimulationReplay };

const SIMULATION_HORIZON_HOURS = 36;

async function responseJson<T>(response: Response): Promise<T> {
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error(`Server returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { month: "short", day: "2-digit" };
const number = (value: number) => value.toLocaleString("en-US");

function Metric({ title, value, detail, icon, tone = "normal" }: { title: string; value: string; detail: string; icon: "ship" | "shield" | "box" | "clock"; tone?: "normal" | "warning" | "success" }) {
  return <div className="metric-card"><div className="metric-card__top"><span>{title}</span><span className="metric-icon"><Icon name={icon} size={17}/></span></div><div className="metric-card__value">{value}</div><div className={`metric-card__detail metric-card__detail--${tone}`}><span className="metric-dot"/>{detail}</div></div>;
}

function MapToolbox({ onCommand, onPort }: { onCommand: (kind: MapCommand["kind"]) => void; onPort?: boolean }) {
  return <div className="map-toolbox">
    <button title="Zoom in" aria-label="Zoom in" onClick={() => onCommand("zoomIn")}><Icon name="plus" size={17}/></button>
    <button title="Zoom out" aria-label="Zoom out" onClick={() => onCommand("zoomOut")}><Icon name="minus" size={17}/></button>
    <span className="map-toolbox__divider" />
    <button title={onPort ? "Focus port" : "Reset view"} aria-label={onPort ? "Focus port" : "Reset view"} onClick={() => onCommand(onPort ? "focusPort" : "reset")}><Icon name={onPort ? "anchor" : "reset"} size={16}/></button>
  </div>;
}

function ResultStat({ name, value, sub, accent = false }: { name: string; value: string; sub?: string; accent?: boolean }) {
  return <div className={`result-stat ${accent ? "result-stat--accent" : ""}`}><div>{name}</div><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}

function Delta({ before, after, suffix = "%", prefix = "", invert = false }: { before: number; after: number; suffix?: string; prefix?: string; invert?: boolean }) {
  const diff = after - before;
  const good = invert ? diff < 0 : diff > 0;
  const relative = before ? diff / Math.abs(before) * 100 : null;
  return <span className={`outcome-delta ${diff === 0 ? "outcome-delta--flat" : good ? "outcome-delta--good" : "outcome-delta--bad"}`}>{diff > 0 ? "+" : ""}{prefix}{Number.isInteger(diff) ? diff : diff.toFixed(1)}{suffix}{relative === null ? "" : ` (${relative > 0 ? "+" : ""}${relative.toFixed(1)}%)`} vs. baseline</span>;
}

function metricChange(before: number, after: number, unit: string, lowerIsBetter = false): string {
  const difference = after - before;
  if (!difference) return `no change (0${unit})`;
  const improved = lowerIsBetter ? difference < 0 : difference > 0;
  return `${improved ? "improved" : "worsened"} by ${Math.abs(difference).toFixed(1)}${unit}`;
}

function ReplayOperations({ snapshot, state }: { snapshot: OperationalSnapshot | null; state: SimulationState }) {
  if (!snapshot) return <div className="replay-empty">Operational replay data is unavailable for this view.</div>;
  const isUnloading = (vesselId: string) => snapshot.cargoBatches.some((batch) => batch.vesselId === vesselId && batch.status === "unloading");
  const criticalRemaining = snapshot.cargoBatches.filter((batch) => batch.criticality === "critical").reduce((sum, batch) => sum + batch.containersRemaining, 0);
  const formatStatus = (status: OperationalSnapshot["vessels"][number]["status"], vesselId: string) => status === "departed" ? "Completed" : status === "waiting" ? "Waiting" : status === "berthed" ? isUnloading(vesselId) ? "Unloading" : "Docked" : "Scheduled";

  return <div className="replay-operations" aria-live="polite">
    <div className="replay-operations__summary"><strong>T+{snapshot.simulationHour}h operations</strong><span>{criticalRemaining.toLocaleString("en-US")} critical containers remaining</span></div>
    {snapshot.ports.map((portSnapshot) => {
      const port = state.ports.find((item) => item.portId === portSnapshot.portId);
      return <section className="replay-port" key={portSnapshot.portId}>
        <div className="replay-port__facts"><strong>{port?.location.name ?? portSnapshot.portId}</strong><span>{portSnapshot.capacityContainersPerHour.toFixed(2)} containers/hour · {portSnapshot.berthAssignments.length}/{port?.availableBerths ?? portSnapshot.berthAssignments.length} berths occupied</span></div>
        <div className="replay-berths">{portSnapshot.berthAssignments.length ? portSnapshot.berthAssignments.map(({ berthId, vesselId }) => <span key={berthId}>{berthId}: {vesselId}</span>) : <span>No occupied berths</span>}</div>
        <div className="replay-disruptions">{portSnapshot.activeDisruptions.length ? portSnapshot.activeDisruptions.map((item) => <span key={item.id}>{item.description} · {Math.round(item.severity * 100)}%</span>) : <span>No active disruptions</span>}</div>
      </section>;
    })}
    <div className="replay-vessels">{snapshot.vessels.map((vessel) => {
      const ship = state.ships.find((item) => item.vesselId === vessel.vesselId);
      const plannedArrival = ship ? (Date.parse(ship.estimatedArrival) - Date.parse(state.startAt)) / 3_600_000 : vessel.arrivalHour;
      const delayed = vessel.status !== "departed" && (vessel.arrivalHour > plannedArrival + 0.25 || (vessel.status === "waiting" && snapshot.simulationHour > vessel.arrivalHour + 0.25) || (vessel.berthAtHour !== null && vessel.berthAtHour > vessel.arrivalHour + 0.25));
      const batches = snapshot.cargoBatches.filter((batch) => batch.vesselId === vessel.vesselId);
      const carriesCriticalCargo = batches.some((batch) => batch.criticality === "critical");
      return <article className="replay-vessel" key={vessel.vesselId}>
        <div className="replay-vessel__heading"><Icon name="ship" size={13} className={`replay-vessel__icon ${carriesCriticalCargo ? "replay-vessel__icon--critical" : ""}`}/><strong>{vessel.vesselId}</strong><span className={`replay-state replay-state--${formatStatus(vessel.status, vessel.vesselId).toLowerCase()}`}>{formatStatus(vessel.status, vessel.vesselId)}</span>{delayed && <span className="replay-delayed">Delayed</span>}{vessel.berthId && <small>{vessel.berthId}</small>}</div>
        {batches.map((batch) => <div className="replay-cargo" key={batch.batchId}><span>{batch.criticality === "critical" ? "Critical" : "Standard"} · {batch.category}</span><strong>{batch.containersUnloaded}/{batch.containers} unloaded · {batch.containersRemaining} remaining</strong></div>)}
      </article>;
    })}</div>
  </div>;
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedShip, setSelectedShip] = useState("PM-104");
  const [mapCommand, setMapCommand] = useState<MapCommand>({ kind: "reset", nonce: 0 });
  const [now, setNow] = useState<Date | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scenarioId, setScenarioId] = useState<ScenarioId>("storm");
  const [capacityLoss, setCapacityLoss] = useState(60);
  const [duration, setDuration] = useState(18);
  const [optimizationObjective, setOptimizationObjective] = useState<OptimizationObjective>("balanced");
  const [minimumCriticalDeliveryTarget, setMinimumCriticalDeliveryTarget] = useState(80);
  const [maximumDisruptionCost, setMaximumDisruptionCost] = useState<number | null>(null);
  const [adaptiveEnabled, setAdaptiveEnabled] = useState(true);
  const [replanHour, setReplanHour] = useState(10);
  const [secondaryCapacityLoss, setSecondaryCapacityLoss] = useState(40);
  const [secondaryDurationHours, setSecondaryDurationHours] = useState(18);
  const [ran, setRan] = useState(false);
  const [busy, setBusy] = useState<"scenario" | "evaluation" | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [run, setRun] = useState<ScenarioRun | null>(null);
  const [evaluatedOutcome, setEvaluatedOutcome] = useState<SimulationSummary | null>(null);
  const [draftPlan, setDraftPlan] = useState<RecoveryPlan | null>(null);
  const [evaluatedPlan, setEvaluatedPlan] = useState<RecoveryPlan | null>(null);
  const [evaluatedStrategyId, setEvaluatedStrategyId] = useState<string | null>(null);
  const [history, setHistory] = useState<PlanSnapshot[]>([]);
  const [evaluationCount, setEvaluationCount] = useState(0);
  const [simulationHour, setSimulationHour] = useState(0);
  const [replayMode, setReplayMode] = useState<"baseline" | "recovery" | "adaptive">("baseline");
  const [evaluatedReplay, setEvaluatedReplay] = useState<SimulationReplay | null>(null);
  const [playing, setPlaying] = useState(false);
  const requestId = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  const invalidateRequest = () => {
    requestController.current?.abort();
    requestController.current = null;
    requestId.current += 1;
    setBusy(null);
  };

  const beginRequest = (kind: "scenario" | "evaluation") => {
    if (requestController.current) return null;
    const controller = new AbortController();
    requestController.current = controller;
    const id = ++requestId.current;
    setBusy(kind);
    setRequestError(null);
    return { controller, id };
  };

  const isCurrentRequest = (id: number, controller: AbortController) => isLatestScenarioRequest(id, requestId.current, controller, requestController.current);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(new Date()), 0);
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const horizonHours = run?.options.horizonHours ?? SIMULATION_HORIZON_HOURS;
  const craneFailureDurationChoices = [...new Set([1, 2, 4, 6, 8, 12, 18, 24, SIMULATION_HORIZON_HOURS - replanHour])]
    .filter((hours) => hours > 0 && hours <= SIMULATION_HORIZON_HOURS - replanHour)
    .sort((a, b) => a - b);

  useEffect(() => {
    if (!ran || !playing) return;
    const timer = window.setInterval(() => setSimulationHour((hour) => {
      if (hour >= horizonHours) { setPlaying(false); return hour; }
      return Math.min(horizonHours, hour + 1);
    }), 900);
    return () => window.clearInterval(timer);
  }, [ran, playing, horizonHours]);

  const selected = SHIPS.find((ship) => ship.id === selectedShip) ?? SHIPS[0];
  const scenario = SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0];
  const activeSignature = `${scenarioSignature(scenarioId, capacityLoss, duration)}:${optimizationObjective}:${minimumCriticalDeliveryTarget}:${maximumDisruptionCost ?? "none"}:${adaptiveEnabled}:${replanHour}:${secondaryCapacityLoss}:${secondaryDurationHours}`;
  const staleRun = Boolean(run && run.signature !== activeSignature);
  const baseline = run?.simulation.baseline ?? null;
  const recoveryOutcome = evaluatedOutcome ?? run?.simulation.outcome ?? null;
  const currentOutcome = replayMode === "adaptive" ? run?.simulation.adaptive?.outcome ?? recoveryOutcome : recoveryOutcome;
  const selectedOutcome = replayMode === "baseline" ? baseline! : replayMode === "adaptive" ? run?.simulation.adaptive?.outcome ?? recoveryOutcome! : recoveryOutcome!;
  const pendingChanges = Boolean(draftPlan && !sameRecoveryPlan(draftPlan, evaluatedPlan));
  const suggestedStrategy = run?.payload.recommendation && run.payload.availableStrategies.find((item) => item.id === run.payload.recommendation.selectedStrategyId);
  const totalContainers = run?.state.ships.flatMap((ship) => ship.cargo).reduce((sum, cargo) => sum + cargo.containers, 0) ?? 0;
  const recoveryReplay = evaluatedReplay ?? run?.simulation.replay;
  const activeReplay = replayMode === "adaptive" ? run?.simulation.adaptive?.replay ?? null : replayForMode(replayMode, run?.simulation.baselineReplay, recoveryReplay);
  const replaySnapshot = snapshotAtHour(activeReplay, simulationHour);
  const riskOutcome = selectedOutcome;
  const decisionSource = run?.payload.recommendation.decisionSource;
  const adaptive = run?.simulation.adaptive;
  const decisionStatus = busy === "scenario" ? "EVALUATING SCENARIO" : busy === "evaluation" ? "SIMULATING PLAN" : staleRun ? "SCENARIO CHANGED" : !run ? requestError ? "JEV UNAVAILABLE" : "JEV NOT EVALUATED" : decisionSource === "jev" ? "RECOMMENDATION AVAILABLE" : decisionSource === "mock" ? "LOCAL JEV MOCK" : "FALLBACK STRATEGY";
  const recoverySourceLabel = decisionSource === "jev" ? "JEV-SELECTED PLAN" : decisionSource === "mock" ? "LOCAL MOCK PLAN" : "DETERMINISTIC FALLBACK";
  const decisionCandidate = (strategyId: string) => run?.payload.recommendation.decisionAudit.candidates.find((item) => item.strategyId === strategyId);
  const containersAtRisk = (summary: SimulationSummary) => Math.max(0, totalContainers - Math.round(summary.mean.totalContainersProcessed));
  const outcomeCost = (summary: SimulationSummary) => summary.mean.estimatedDisruptionCost === null ? "Unavailable" : `$${number(summary.mean.estimatedDisruptionCost)}`;

  const issueMapCommand = (kind: MapCommand["kind"], shipId?: string) => setMapCommand((current) => ({ kind, shipId, nonce: current.nonce + 1 }));
  const jump = (destination: Tab) => { setTab(destination); setMobileMenu(false); issueMapCommand("reset"); };
  const chooseScenario = (id: ScenarioId) => {
    const item = SCENARIOS.find((scenario) => scenario.id === id)!;
    invalidateRequest();
    setScenarioId(id);
    setCapacityLoss(item.intensity);
    setRequestError(null);
  };
  const runScenario = async () => {
    const request = beginRequest("scenario");
    if (!request) return;
    const { controller, id } = request;
    try {
      const stateResponse = await fetch("/api/scenario", { cache: "no-store", signal: controller.signal });
      let state = configureScenarioState(await responseJson<SimulationState>(stateResponse), scenario, capacityLoss, duration);
      try {
        const weatherResponse = await fetch("/api/weather", { cache: "no-store", signal: AbortSignal.timeout(9_000) });
        if (weatherResponse.ok) state = applyOpenMeteoForecast(state, await weatherResponse.json(), state.ports[0]?.portId);
      } catch {
        if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
      }
      if (!isCurrentRequest(id, controller)) return;
      const options = { runs: 40, seed: 42, horizonHours: SIMULATION_HORIZON_HOURS, criticalCargoOnTimeTargetPercent: minimumCriticalDeliveryTarget };
      const adaptive = adaptiveEnabled ? { atHour: replanHour, severity: secondaryCapacityLoss / 100, durationHours: secondaryDurationHours, description: "Unexpected crane failure" } : undefined;
      const recommendationState = adaptive ? {
        ...state,
        ports: state.ports.map((port) => port.portId === state.ports[0].portId
          ? { ...port, activeDisruptions: [...port.activeDisruptions, { id: `adaptive-event-${adaptive.atHour}`, description: adaptive.description, severity: adaptive.severity, startHour: adaptive.atHour, durationHours: adaptive.durationHours }] }
          : port),
      } : state;
      const recommendationResponse = await fetch("/api/recommendation", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ state: recommendationState, options, decision: { objective: optimizationObjective, ...(maximumDisruptionCost === null ? {} : { maximumDisruptionCost }) } }),
      });
      const payload = await responseJson<RecommendationPayload>(recommendationResponse);
      if (!isCurrentRequest(id, controller)) return;
      const recommended = payload.availableStrategies.find((item) => item.id === payload.recommendation.selectedStrategyId);
      if (!recommended) throw new Error("Jev selected a strategy that is missing from the validated candidate set.");
      const simulationResponse = await fetch("/api/simulate", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ state, options, decision: { objective: optimizationObjective, ...(maximumDisruptionCost === null ? {} : { maximumDisruptionCost }) }, strategyId: recommended.id, ...(adaptive ? { adaptive } : {}) }),
      });
      const simulation = await responseJson<SimulationPayload>(simulationResponse);
      if (!isCurrentRequest(id, controller)) return;
      setRun({ state, options, signature: activeSignature, payload, simulation });
      setEvaluatedOutcome(null);
      setDraftPlan(null);
      setEvaluatedPlan(recommended ? recoveryPlanForStrategy(recommended) : null);
      setEvaluatedStrategyId(payload.recommendation.selectedStrategyId);
      setEvaluatedReplay(null);
      setReplayMode("recovery");
      setHistory([]);
      setEvaluationCount(0);
      setSimulationHour(0);
      setPlaying(false);
      setRan(true);
      setRequestError(null);
      issueMapCommand("reset");
    } catch (error) {
      if (isCurrentRequest(id, controller) && !(error instanceof DOMException && error.name === "AbortError")) setRequestError(error instanceof Error ? error.message : "Could not evaluate this scenario.");
    } finally {
      if (isCurrentRequest(id, controller)) {
        requestController.current = null;
        setBusy(null);
      }
    }
  };
  const evaluatePlan = async () => {
    if (!run || !draftPlan) return;
    const request = beginRequest("evaluation");
    if (!request) return;
    const { controller, id } = request;
    const exactStrategy = run.payload.availableStrategies.find((strategy) => sameRecoveryPlan(recoveryPlanForStrategy(strategy), draftPlan));
    try {
      const response = await fetch("/api/simulate", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({
          state: run.state, options: run.options,
          decision: { objective: draftPlan.objective, ...(draftPlan.maximumDisruptionCost === null ? {} : { maximumDisruptionCost: draftPlan.maximumDisruptionCost }) },
          ...(adaptiveEnabled ? { adaptive: { atHour: replanHour, severity: secondaryCapacityLoss / 100, durationHours: secondaryDurationHours, description: "Unexpected crane failure" } } : {}),
          ...(exactStrategy ? { strategyId: exactStrategy.id } : { plan: draftPlan }),
        }),
      });
      const result = await responseJson<SimulationPayload>(response);
      if (!isCurrentRequest(id, controller)) return;
      if (evaluatedPlan && evaluatedStrategyId && evaluatedOutcome && evaluatedReplay) setHistory((previous) => [...previous, { plan: copyRecoveryPlan(evaluatedPlan), strategyId: evaluatedStrategyId, outcome: evaluatedOutcome, replay: evaluatedReplay }]);
      if (result.adaptive) setRun((current) => current ? { ...current, simulation: { ...current.simulation, adaptive: result.adaptive } } : current);
      setDraftPlan(copyRecoveryPlan(result.strategy));
      setEvaluatedPlan(copyRecoveryPlan(result.strategy));
      setEvaluatedStrategyId(result.strategyId);
      setEvaluatedOutcome(result.adaptive?.outcome ?? result.outcome);
      setEvaluatedReplay(result.adaptive?.replay ?? result.replay);
      setReplayMode(result.adaptive ? "adaptive" : "recovery");
      setEvaluationCount((count) => count + 1);
      setSimulationHour(0);
      setPlaying(false);
      setRequestError(null);
    } catch (error) {
      if (isCurrentRequest(id, controller) && !(error instanceof DOMException && error.name === "AbortError")) setRequestError(error instanceof Error ? error.message : "Could not simulate this recovery plan.");
    } finally {
      if (isCurrentRequest(id, controller)) {
        requestController.current = null;
        setBusy(null);
      }
    }
  };
  const loadPlan = (strategy: RecoveryStrategy) => {
    setDraftPlan(recoveryPlanForStrategy(strategy));
    setRequestError(null);
  };
  const undoPlan = () => {
    if (!history.length) return;
    const previous = history[history.length - 1];
    setHistory((current) => current.slice(0, -1));
    setDraftPlan(copyRecoveryPlan(previous.plan));
    setEvaluatedPlan(copyRecoveryPlan(previous.plan));
    setEvaluatedStrategyId(previous.strategyId);
    setEvaluatedOutcome(previous.outcome);
    setEvaluatedReplay(previous.replay);
    setReplayMode("recovery");
    setEvaluationCount((count) => Math.max(0, count - 1));
  };
  const goBackToSetup = () => {
    invalidateRequest();
    setRan(false);
  };

  const formatDate = now ? now.toLocaleDateString("en-US", DAY_MONTH).toUpperCase() : "DEMO";
  const time = now ? now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--";

  return <div className="app-shell">
    <aside className={`sidebar ${mobileMenu ? "sidebar--open" : ""}`}>
      <button className="brand" onClick={() => jump("overview")} aria-label="HarborMind home"><span className="brand__mark"><Icon name="layers" size={22} strokeWidth={2}/></span><span className="brand__words"><strong>harbor<span>mind</span></strong><small>RESILIENCE PLATFORM</small></span></button>
      <div className="sidebar__section-label">WORKSPACE</div>
      <nav className="primary-nav" aria-label="Primary navigation">
        <button className={tab === "overview" ? "active" : ""} onClick={() => jump("overview")}><Icon name="grid" size={18}/><span>Command center</span><span className="nav-active-dot"/></button>
        <button className={tab === "simulations" ? "active" : ""} onClick={() => jump("simulations")}><Icon name="flask" size={18}/><span>Scenario lab</span><span className="nav-beta">BETA</span></button>
        <button className={tab === "about" ? "active" : ""} onClick={() => jump("about")}><Icon name="info" size={18}/><span>About project</span></button>
      </nav>
      <div className="sidebar__bottom">
        <div className="sidebar__port"><span className="sidebar__port-icon"><Icon name="anchor" size={19}/></span><div><small>ACTIVE PORT</small><strong>Los Angeles, CA</strong><span>33.74° N · 118.27° W</span></div><Icon name="chevron" size={16}/></div>
        <div className="environment"><span className="environment__pulse"/><span>DEMO ENVIRONMENT</span><span>v0.1</span></div>
      </div>
    </aside>

    <div className="app-main">
      <header className="topbar">
        <div className="topbar__left"><button aria-label="Open navigation" className="mobile-menu" onClick={() => setMobileMenu(!mobileMenu)}><Icon name="menu"/></button><span className="breadcrumb-start">OPERATIONS</span><Icon name="chevron" size={14}/><strong>{tab === "overview" ? "Command center" : tab === "simulations" ? "Scenario lab" : "About project"}</strong></div>
        <div className="topbar__right"><span className="topbar__local"><Icon name="clock" size={14}/> {formatDate} <span className="topbar__clock">{time} LOCAL</span></span><span className="topbar__divider"/><span className="system-status"><span/> SYSTEMS READY</span><span className="avatar">HM</span></div>
      </header>

      <div className="page-scroll">
        {tab === "overview" && <main className="content-area">
          <div className="page-heading"><div><div className="eyebrow">MARITIME OPERATIONS / OVERVIEW</div><h1>Command center<span className="heading-fullstop">.</span></h1><p>Live-style situational awareness for critical cargo movements.</p></div><button className="button button--outline heading-action" onClick={() => jump("simulations")}><Icon name="flask" size={17}/> Open scenario lab <Icon name="arrow" size={15}/></button></div>

          <div className="weather-banner"><span className="weather-banner__icon"><Icon name="alert" size={20}/></span><div className="weather-banner__body"><div><strong>Marine weather advisory</strong><span className="weather-banner__tag">MONITORING</span></div><p>Elevated coastal winds detected in the demo zone. Select a scenario to model operational impact.</p></div><button onClick={() => jump("simulations")}>Model disruption <Icon name="arrow" size={15}/></button></div>

          <div className="metrics-grid"><Metric title="Tracked vessels" value="06" detail="4 inbound · 2 at approach" icon="ship"/><Metric title="Critical shipments" value="01" detail="Medical cargo prioritized" icon="shield" tone="success"/><Metric title="Containers in transit" value="12,320" detail="Synthetic cargo manifest" icon="box"/><Metric title="Berth utilization" value="78%" detail="Approaching high capacity" icon="clock" tone="warning"/></div>

          <div className="main-grid">
            <section className="map-panel panel">
              <div className="panel-top"><div><div className="panel-kicker"><span className="live-dot"/> 3D MARITIME VIEW <span className="panel-kicker__divider">/</span> PACIFIC COAST</div><h2>Port traffic overview</h2></div><div className="panel-top__actions"><span className="small-data-label"><Icon name="layers" size={13}/> DEMO VESSELS</span><button className="mini-button" onClick={() => issueMapCommand("focusPort")}><Icon name="anchor" size={14}/> Focus port</button></div></div>
              <div className="map-stage"><PortMap3D selectedShip={selectedShip} onSelectShip={setSelectedShip} weather={{ x: -42, z: -34, radius: 17, color: "#dba75b" }} command={mapCommand}/><div className="map-top-left"><span className="map-tag"><Icon name="globe" size={13}/> LOS ANGELES HARBOR</span><div className="map-coords">33.7405° N, 118.2728° W</div></div><MapToolbox onCommand={issueMapCommand}/><div className="map-legend"><span><i className="legend-dot legend-dot--teal"/> Critical cargo</span><span><i className="legend-dot legend-dot--yellow"/> High priority</span><span><i className="legend-dot legend-dot--blue"/> Standard</span><span><i className="legend-line"/> Vessel route</span></div><span className="view-badge">PERSPECTIVE <b>·</b> 3D</span></div>
              <div className="map-panel__footer"><span><Icon name="info" size={14}/> Select a vessel or scroll to explore. Synthetic locations, routes, and cargo.</span><span><span className="live-dot"/> SCENE ACTIVE</span></div>
            </section>

            <aside className="details-column">
              <section className="panel vessel-card"><div className="side-panel-header"><div className="panel-kicker">VESSEL INSPECTOR</div><span className="tiny-outline">{selected.id}</span></div><div className="vessel-card__title"><div className="vessel-avatar"><Icon name="ship" size={27}/></div><div><h2>{selected.name}</h2><p>CALL SIGN {selected.callSign}</p></div></div><span className={`priority-pill priority-pill--${selected.priority.toLowerCase()}`}><span/>{selected.priority.toUpperCase()} PRIORITY</span><div className="vessel-progress-header"><span>Route completion</span><strong>{Math.round(selected.progress * 100)}%</strong></div><div className="progress-track"><span style={{ width: `${selected.progress * 100}%`, background: selected.color }}/></div><div className="vessel-data-grid"><div><small>CARGO TYPE</small><strong>{selected.cargo}</strong></div><div><small>CONTAINERS</small><strong>{number(selected.containers)} TEU</strong></div><div><small>EST. ARRIVAL</small><strong>{selected.eta} <em>PT</em></strong></div><div><small>STATUS</small><strong className="status-dot-text"><span/> {selected.status}</strong></div></div><button className="button button--subtle vessel-focus" onClick={() => issueMapCommand("focusShip", selected.id)}><Icon name="target" size={15}/> Focus on vessel <Icon name="arrow" size={14}/></button></section>
              <section className="panel activity-panel"><div className="side-panel-header"><div><div className="panel-kicker">OPERATIONS PULSE</div><h3>Port conditions</h3></div><span className="tiny-outline">DEMO</span></div><div className="conditions-row"><div className="conditions-row__icon conditions-row__icon--teal"><Icon name="anchor" size={17}/></div><div><strong>Dock availability</strong><span>3 of 5 berths occupied</span></div><span className="condition-indicator">NORMAL</span></div><div className="conditions-row"><div className="conditions-row__icon conditions-row__icon--amber"><Icon name="wind" size={17}/></div><div><strong>Coastal conditions</strong><span>Elevated wind watch</span></div><span className="condition-indicator condition-indicator--warn">WATCH</span></div><div className="conditions-row"><div className="conditions-row__icon conditions-row__icon--blue"><Icon name="route" size={17}/></div><div><strong>Shipping channel</strong><span>Moderate inbound flow</span></div><span className="condition-indicator">OPEN</span></div></section>
              <div className="intelligence-link"><span className="intelligence-link__star"><Icon name="sparkle" size={19}/></span><div><strong>Prepare before disruption.</strong><p>Run scenarios to compare recovery strategies.</p></div><button aria-label="Open scenario lab" onClick={() => jump("simulations")}><Icon name="arrow" size={18}/></button></div>
            </aside>
          </div>
          <footer className="content-footer"><span>HARBORMIND · DIGITAL TWIN PROTOTYPE</span><span>Illustrative data only · Not for operational navigation</span></footer>
        </main>}

        {tab === "simulations" && <main className="content-area scenario-area">
          <div className="page-heading"><div><div className="eyebrow">DISRUPTION PLANNING / WHAT-IF ENGINE</div><h1>Scenario lab<span className="heading-fullstop">.</span></h1><p>Stress-test port operations. Compare tradeoffs. Keep essential cargo moving.</p></div><span className="scenario-demo-pill"><Icon name="sparkle" size={15}/> {decisionStatus}</span></div>
          {requestError && <div className="scenario-message scenario-message--error" role="alert"><Icon name="alert" size={16}/><span>{requestError}</span></div>}
          {staleRun && <div className="scenario-message" role="status"><Icon name="info" size={16}/><span>Scenario settings changed. The previous recommendation and results are retained until the new scenario finishes.</span></div>}
          <div className="scenario-steps"><div className="scenario-step is-done"><span>01</span> Configure disruption</div><Icon name="chevron" size={15}/><div className={`scenario-step ${ran ? "is-done" : ""}`}><span>02</span> Run simulation</div><Icon name="chevron" size={15}/><div className={`scenario-step ${ran ? "is-done" : ""}`}><span>03</span> Explore recovery plan</div></div>
          {!ran ? <>
            <div className="section-title"><div><div className="eyebrow">STEP 01 / SELECT A DISRUPTION</div><h2>What should we simulate?</h2></div><span>Choose one of four modeled conditions</span></div>
            <div className="scenario-options">{SCENARIOS.map((item) => <button key={item.id} disabled={busy !== null} onClick={() => chooseScenario(item.id)} className={`scenario-option ${scenarioId === item.id ? "scenario-option--selected" : ""}`}><span className={`scenario-option__icon scenario-option__icon--${item.icon}`}><Icon name={item.icon} size={24}/></span><span className="scenario-option__heading"><strong>{item.label}</strong>{scenarioId === item.id && <span className="scenario-selected-check"><Icon name="check" size={13}/></span>}</span><span className="scenario-option__kicker">{item.kicker}</span><span className="scenario-option__desc">{item.description}</span><span className="scenario-option__impact"><Icon name="alert" size={14}/> {item.impact}</span></button>)}</div>
              <div className="scenario-config-grid"><section className="panel config-panel"><div className="panel-kicker">STEP 02 / CONFIGURE</div><h2>Disruption parameters</h2><p>Adjust severity, duration, and the recovery objective.</p><label className="duration-label" htmlFor="objective-select">Optimization objective</label><div className="select-wrap"><select id="objective-select" value={optimizationObjective} disabled={busy !== null} onChange={(event) => { invalidateRequest(); setOptimizationObjective(event.target.value as OptimizationObjective); setRequestError(null); }}><option value="balanced">Balanced recovery</option><option value="critical-delivery">Maximize critical cargo delivered on time</option><option value="minimize-delay">Minimize average container delay</option><option value="minimize-cost">Minimize disruption cost</option></select><Icon name="chevron" size={17}/></div><div className="slider-heading"><label htmlFor="critical-target-slider">Minimum critical cargo on-time</label><strong>{minimumCriticalDeliveryTarget}%</strong></div><input id="critical-target-slider" className="range-slider" type="range" min="0" max="100" step="5" value={minimumCriticalDeliveryTarget} disabled={busy !== null} style={{ "--slider-progress": `${minimumCriticalDeliveryTarget}%` } as CSSProperties} onChange={(event) => { invalidateRequest(); setMinimumCriticalDeliveryTarget(Number(event.target.value)); setRequestError(null); }}/><label className="duration-label" htmlFor="cost-limit">Maximum modeled disruption cost (optional)</label><div className="cost-limit-wrap"><input id="cost-limit" type="number" min="0" step="1000" placeholder="No cost limit" value={maximumDisruptionCost ?? ""} disabled={busy !== null} onChange={(event) => { invalidateRequest(); setMaximumDisruptionCost(event.target.value === "" ? null : Math.max(0, Number(event.target.value))); setRequestError(null); }}/></div><div className="slider-heading"><label htmlFor="capacity-slider">Effective capacity reduction</label><strong>{capacityLoss}%</strong></div><input id="capacity-slider" className="range-slider" type="range" min="10" max="90" step="5" value={capacityLoss} disabled={busy !== null} style={{ "--slider-progress": `${((capacityLoss - 10) / 80) * 100}%` } as CSSProperties} onChange={(event) => { invalidateRequest(); setCapacityLoss(Number(event.target.value)); setRequestError(null); }}/><div className="range-labels"><span>10% / Mild</span><span>90% / Severe</span></div><label className="duration-label" htmlFor="duration-select">Disruption duration</label><div className="select-wrap"><select id="duration-select" value={duration} disabled={busy !== null} onChange={(event) => { invalidateRequest(); setDuration(Number(event.target.value)); setRequestError(null); }}><option value="6">6 hours</option><option value="12">12 hours</option><option value="18">18 hours</option><option value="24">24 hours</option><option value="36">36 hours</option></select><Icon name="chevron" size={17}/></div><label className="adaptive-toggle"><input type="checkbox" checked={adaptiveEnabled} disabled={busy !== null} onChange={(event) => { invalidateRequest(); setAdaptiveEnabled(event.target.checked); setRequestError(null); }}/><span>Replan when conditions change</span></label>{adaptiveEnabled && <div className="adaptive-config"><label className="plan-control"><span>New disruption at hour</span><input type="number" min={1} max={SIMULATION_HORIZON_HOURS - secondaryDurationHours} value={replanHour} disabled={busy !== null} onChange={(event) => { invalidateRequest(); const nextHour = Math.max(1, Math.min(SIMULATION_HORIZON_HOURS - secondaryDurationHours, Number(event.target.value) || 1)); setReplanHour(nextHour); setSecondaryDurationHours((current) => Math.min(current, SIMULATION_HORIZON_HOURS - nextHour)); }}/></label><label className="plan-control"><span>Crane failure capacity loss</span><select value={secondaryCapacityLoss} disabled={busy !== null} onChange={(event) => { invalidateRequest(); setSecondaryCapacityLoss(Number(event.target.value)); }}><option value={20}>20%</option><option value={40}>40%</option><option value={60}>60%</option></select></label><label className="plan-control"><span>Crane failure duration</span><select value={secondaryDurationHours} disabled={busy !== null} onChange={(event) => { invalidateRequest(); setSecondaryDurationHours(Number(event.target.value)); }} aria-label="Crane failure duration">{craneFailureDurationChoices.map((hours) => <option key={hours} value={hours}>{hours} hours</option>)}</select></label><small>Crane failure is active for {secondaryDurationHours}h from T+{replanHour}h and ends at T+{replanHour + secondaryDurationHours}h; it compounds with the storm only while both events are active.</small></div>}<div className="config-note"><Icon name="info" size={16}/> The server runs 40 seeded trials across a 36-hour horizon. Disruptions and Jev replanning use the same simulation state; Jev decisions stay server-side.</div><button className="button button--primary run-button" disabled={busy !== null} onClick={() => void runScenario()}><Icon name={busy === "scenario" ? "clock" : "play"} size={17}/>{busy === "scenario" ? "Evaluating scenario…" : "Run simulation"}<Icon name="arrow" size={17}/></button></section>
              <section className="panel preview-panel"><div className="panel-top"><div><div className="panel-kicker">SCENARIO PREVIEW</div><h2>Potential area of impact</h2></div><span className="tiny-outline">3D DIGITAL TWIN</span></div><div className="scenario-preview-map"><PortMap3D selectedShip={selectedShip} onSelectShip={setSelectedShip} weather={scenario.zone} scenarioId={scenarioId} simulated compact command={mapCommand}/><span className="map-tag preview-map-tag"><Icon name={scenario.icon} size={13}/> {scenario.label.toUpperCase()}</span><MapToolbox onCommand={issueMapCommand}/></div><div className="preview-panel__foot"><span><i className="impact-indicator" style={{ background: scenario.zone.color }}/> Disruption footprint</span><span><i className="legend-line"/> Synthetic shipping routes</span></div></section></div>
          </> : run && baseline && currentOutcome ? <>
            <div className="simulation-toolbar"><div><button className="text-back" onClick={goBackToSetup}><Icon name="back" size={17}/> Edit scenario</button><h2>{scenario.label} <span>simulation</span></h2><div className="simulation-subtitle"><span className="live-dot live-dot--amber"/> DISRUPTION INJECTED <b>·</b> {capacityLoss}% CAPACITY LOSS <b>·</b> {duration}H DISRUPTION <b>·</b> {adaptiveEnabled ? `REPLAN T+${replanHour}H · CRANE FAILURE ${secondaryCapacityLoss}% / ${secondaryDurationHours}H · ` : ""}{horizonHours}H HORIZON</div></div><button className="button button--outline" onClick={goBackToSetup}><Icon name="reset" size={15}/> Edit scenario</button></div>
            <div className="running-map-grid">
              <section className="panel running-map-panel">
                <div className="panel-top"><div><div className="panel-kicker">SIMULATED PORT OPERATIONS</div><h2>Disruption footprint</h2></div><div className="replay-mode-switch" role="group" aria-label="Replay view"><button className={replayMode === "baseline" ? "is-selected" : ""} aria-pressed={replayMode === "baseline"} onClick={() => { setPlaying(false); setReplayMode("baseline"); }}>Baseline</button><button className={replayMode === "recovery" ? "is-selected" : ""} aria-pressed={replayMode === "recovery"} onClick={() => { setPlaying(false); setReplayMode("recovery"); }}>{evaluatedOutcome ? "Recovery plan" : decisionSource === "jev" ? "Jev-assisted" : decisionSource === "mock" ? "Mock plan" : "Fallback plan"}</button>{adaptive && <button className={replayMode === "adaptive" ? "is-selected" : ""} aria-pressed={replayMode === "adaptive"} onClick={() => { setPlaying(false); setReplayMode("adaptive"); }}>Adaptive Jev</button>}</div></div>
                <div className="running-map-stage"><PortMap3D selectedShip={selectedShip} onSelectShip={setSelectedShip} weather={scenario.zone} simulated scenarioId={scenarioId} compact command={mapCommand}/><div className="map-top-left"><span className="map-tag"><Icon name={scenario.icon} size={13}/> {scenario.label.toUpperCase()}</span><div className="map-coords" aria-label="Input data provenance" title={`Ports: ${run.state.provenance.ports}; vessel and cargo inputs: ${run.state.provenance.shipEtaAndCargo}; weather forecast: ${run.state.provenance.weather}; weather alerts: ${run.state.provenance.weatherAlerts}`}>MODELED EVENT · PORT {run.state.provenance.ports.toUpperCase()} · VESSEL/CARGO {run.state.provenance.shipEtaAndCargo.toUpperCase()} · FORECAST {run.state.provenance.weather.toUpperCase()}</div></div><MapToolbox onCommand={issueMapCommand}/>{replaySnapshot && <div className="replay-map-status"><strong>T+{replaySnapshot.simulationHour}H · {replayMode === "baseline" ? "BASELINE" : replayMode === "adaptive" ? "ADAPTIVE JEV" : "RECOVERY"}</strong><span>{replaySnapshot.ports.reduce((sum, port) => sum + port.berthAssignments.length, 0)} occupied berths · {replaySnapshot.vessels.filter((vessel) => vessel.status === "waiting").length} waiting vessels</span></div>}</div>
                <div className="sim-timeline"><button disabled={busy !== null} title={playing ? "Pause replay" : "Play replay"} aria-label={playing ? "Pause replay" : "Play replay"} onClick={() => { if (simulationHour >= horizonHours) setSimulationHour(0); setPlaying(!playing); }}><Icon name={playing ? "pause" : "play"} size={15}/></button><button disabled={busy !== null} title="Go back one hour" aria-label="Go back one hour" onClick={() => {setPlaying(false);setSimulationHour(Math.max(0,simulationHour - 1));}}><Icon name="back" size={15}/></button><span className="sim-timeline__start">T+0H</span><input aria-label="Simulation timeline" aria-valuetext={"T+" + simulationHour + " hours"} type="range" min="0" max={horizonHours} step="1" value={simulationHour} onChange={(event) => {setPlaying(false);setSimulationHour(Number(event.target.value));}}/><span className="sim-timeline__end">T+{horizonHours}H</span><strong>T+{simulationHour}H</strong></div>
                <ReplayOperations snapshot={replaySnapshot} state={run.state}/>
                <div className="map-integration-note">Operational statuses, berths, cargo progress, and capacity come from the selected replay. Geographic vessel tracks remain illustrative because the simulator does not return positions.</div>
              </section>
              <section className="panel impact-panel"><div className="panel-kicker">{replayMode === "baseline" ? "BASELINE REPLAY" : replayMode === "adaptive" ? "ADAPTIVE JEV REPLAY" : evaluatedOutcome ? "EVALUATED RECOVERY" : recoverySourceLabel}</div><h2>{replayMode === "baseline" ? "Without intervention" : replayMode === "adaptive" ? "Recovery after replanning" : "Recovery plan"}</h2><p>Simulation outcome from the same scenario, seed, and horizon as the displayed replay.</p><div className="impact-main"><span>Critical cargo on-time</span><strong>{selectedOutcome.mean.criticalCargoOnTimePercent.toFixed(1)}<small>%</small></strong><div className="impact-track"><span style={{ width: (selectedOutcome.mean.criticalCargoOnTimePercent + "%") }}/></div></div><div className="impact-facts"><div><span>Average container delay</span><strong>{selectedOutcome.mean.averageCargoDelayHours.toFixed(1)}h</strong></div><div><span>Containers at risk</span><strong>{number(containersAtRisk(selectedOutcome))}</strong></div><div><span>Estimated disruption cost</span><strong>{outcomeCost(selectedOutcome)}</strong></div></div><p className="impact-disclaimer"><Icon name="info" size={14}/> {selectedOutcome.runs} simulation runs · seed {selectedOutcome.seed}</p></section>
            </div>

            <section className="panel decision-panel">
              <div className="decision-panel__top">
                <div><div className="panel-kicker">JEV DECISION HARNESS</div><h2>{suggestedStrategy?.name ?? "No recommendation returned"}</h2><p>{run.payload.recommendation.decisionExplanation}</p></div>
                <span className={"decision-source decision-source--" + (decisionSource ?? "unavailable")}>{decisionSource === "jev" ? "Jev recommendation" : decisionSource === "mock" ? "Local mock" : "Deterministic fallback"}</span>
              </div>
              <div className="decision-facts">
                <div><small>Model</small><strong>{run.payload.recommendation.jev?.model ?? "Not available"}</strong></div>
                <div><small>{decisionSource === "jev" ? "Jev selection confidence" : decisionSource === "mock" ? "Local mock confidence" : "Jev confidence"}</small><strong>{run.payload.recommendation.jev ? Math.round(run.payload.recommendation.jev.selection.confidence * 100) + "%" : "Not returned"}</strong></div>
                <div><small>Critical cargo on-time</small><strong>{run.payload.recommendation.estimatedOutcomes.mean.criticalCargoOnTimePercent.toFixed(1)}%</strong></div>
                <div><small>Meeting target likelihood · simulation</small><strong>{Math.round(run.payload.recommendation.simulatedOutcomeLikelihoods.probabilityOfMeetingTarget * 100)}%</strong></div>
              </div>
              {run.payload.recommendation.fallbackReason && <p className="decision-fallback"><Icon name="info" size={14}/>{run.payload.recommendation.fallbackReason}</p>}
              <div className="decision-panel__meta">
                <span><strong>Operator objective:</strong> {run.payload.recommendation.decisionAudit.objective} · minimum critical delivery {run.payload.recommendation.decisionAudit.minimumCriticalCargoOnTimePercent}%{run.payload.recommendation.decisionAudit.maximumDisruptionCost === null ? "" : " · maximum cost $" + number(run.payload.recommendation.decisionAudit.maximumDisruptionCost)}</span>
                <span><strong>Objective constraints:</strong> {decisionCandidate(run.payload.recommendation.selectedStrategyId)?.meetsConstraints ? "Met" : "Not met by the selected strategy"}</span>
                <span><strong>Affected vessels:</strong> {run.payload.recommendation.affectedShips.length ? run.payload.recommendation.affectedShips.join(", ") : "No schedule change versus baseline"}</span>
                <span><strong>Affected cargo batches:</strong> {run.payload.recommendation.affectedCargo.length ? run.payload.recommendation.affectedCargo.join(", ") : "No cargo priority overrides"}</span>
              </div>
              {run.payload.recommendation.jev && <details className="jev-probabilities"><summary>Jev structured scores and strategy probabilities</summary><div>Operational risk: {run.payload.recommendation.jev.operationalRisk.score}/3 · cargo urgency: {run.payload.recommendation.jev.cargoUrgency.score}/3 · human review: {Math.round(run.payload.recommendation.jev.humanReviewProbability * 100)}%</div><ul>{Object.entries(run.payload.recommendation.jev.selection.probabilities).map(([strategyId, probability]) => <li key={strategyId}>{run.payload.availableStrategies.find((item) => item.id === strategyId)?.name ?? strategyId}: {Math.round(probability * 100)}%</li>)}</ul></details>}
            </section>

            {adaptive && <section className="panel adaptive-history"><div className="panel-kicker">EVENT-DRIVEN DECISION HISTORY</div><h2>{adaptive.recommendation.decisionSource === "jev" ? "Jev revisited" : adaptive.recommendation.decisionSource === "mock" ? "Local mock reevaluated" : "Deterministic fallback selected"} at T+{adaptive.atHour}h</h2><p>{adaptive.event.description} at {adaptive.event.portId} applied a further {Math.round(adaptive.event.severity * 100)}% capacity reduction. The checkpoint retained completed and partially unloaded cargo and existing berth assignments. Each candidate was continued once from that checkpoint; the reported adaptive outcome averages {adaptive.outcome.runs} seeded trials.</p><div className="adaptive-history__entries">{adaptive.decisionHistory.map((entry, index) => <article key={`${entry.hour}-${entry.strategyId}`}><small>T+{entry.hour}H · {entry.decisionSource === "initial" ? "INITIAL PLAN" : entry.decisionSource.toUpperCase()}</small><strong>{entry.strategyName}</strong><span>Critical on time {entry.measuredOutcome.criticalCargoOnTimePercent.toFixed(1)}% · average container delay {entry.measuredOutcome.averageCargoDelayHours.toFixed(1)}h · disruption cost {entry.measuredOutcome.estimatedDisruptionCost === null ? "Unavailable" : `$${number(entry.measuredOutcome.estimatedDisruptionCost)}`}</span>{index === 1 && <><ul>{entry.changedParameters.length ? entry.changedParameters.map((item) => <li key={item}>{item}</li>) : <li>No operational parameters changed; the selected plan keeps the current settings.</li>}</ul><p>{adaptive.decisionQuality.overridden ? adaptive.decisionQuality.explanation : adaptive.recommendation.decisionExplanation}</p><small>{adaptive.decisionQuality.originalChoice.source === "jev" ? "Jev original choice" : adaptive.decisionQuality.originalChoice.source === "mock" ? "Mock original choice" : "Fallback choice"}: {adaptive.decisionQuality.originalChoice.strategyName}</small><small>{adaptive.recommendation.decisionSource === "jev" && adaptive.recommendation.jev ? `Jev confidence ${Math.round(adaptive.recommendation.jev.selection.confidence * 100)}%` : adaptive.recommendation.decisionSource === "mock" && adaptive.recommendation.jev ? `Local mock selection confidence ${Math.round(adaptive.recommendation.jev.selection.confidence * 100)}%` : "No Jev confidence returned"}</small><details><summary>Inspect proposed future actions</summary><ul>{adaptive.decisionQuality.comparison.proposedPlan.actions.map((action, actionIndex) => <li key={`${action.type}-${actionIndex}`}>{action.type === "schedule" ? `Schedule ${action.vesselId} at ${action.portId}` : action.type === "delay" ? `Stage ${action.vesselId} from T+${adaptive!.atHour + action.startHour}h for ${action.hours}h` : action.type === "cargo-priority" ? `Set ${action.cargoId} cargo priority to ${action.priority}` : action.type === "reroute" ? `Reroute ${action.vesselId} to ${action.toPortId}` : action.type === "reserve-throughput" ? `Reserve ${action.criticalPercent}% critical throughput` : action.type === "allocate-resources" ? `Reserve port resources at ${action.portId}` : `Prioritize ${action.vesselIds.join(", ")}`}</li>)}</ul></details>{adaptive.recommendation.fallbackReason && <small className="decision-fallback">{adaptive.recommendation.fallbackReason}</small>}</>}</article>)}</div><div className="adaptive-history__comparison"><strong>Three-plan outcome comparison · {adaptive.outcome.runs} runs · seed {adaptive.outcome.seed}</strong><span>Critical cargo on time · baseline {adaptive.noIntervention.mean.criticalCargoOnTimePercent.toFixed(1)}% · initial plan {adaptive.initialPlan.mean.criticalCargoOnTimePercent.toFixed(1)}% · adaptive {adaptive.outcome.mean.criticalCargoOnTimePercent.toFixed(1)}%</span><span>Average container delay · baseline {adaptive.noIntervention.mean.averageCargoDelayHours.toFixed(1)}h · initial plan {adaptive.initialPlan.mean.averageCargoDelayHours.toFixed(1)}h · adaptive {adaptive.outcome.mean.averageCargoDelayHours.toFixed(1)}h</span><span>Adaptive vs. initial plan · critical deliveries {metricChange(adaptive.initialPlan.mean.criticalCargoOnTimePercent, adaptive.outcome.mean.criticalCargoOnTimePercent, " pp")} · average container delay {metricChange(adaptive.initialPlan.mean.averageCargoDelayHours, adaptive.outcome.mean.averageCargoDelayHours, "h", true)} · cost {adaptive.initialPlan.mean.estimatedDisruptionCost === null || adaptive.outcome.mean.estimatedDisruptionCost === null ? "unavailable" : metricChange(adaptive.initialPlan.mean.estimatedDisruptionCost, adaptive.outcome.mean.estimatedDisruptionCost, " dollars", true)}</span><span>Disruption cost · baseline {outcomeCost(adaptive.noIntervention)} · initial plan {outcomeCost(adaptive.initialPlan)} · adaptive {outcomeCost(adaptive.outcome)}</span></div></section>}

            {adaptive && <section className="panel adaptive-history"><div className="panel-kicker">T+{adaptive.decisionQuality.checkpoint.hour} CHECKPOINT QUALITY CHECK</div><h2>Decision source and applied plan</h2><div className="adaptive-history__comparison"><strong>{adaptive.decisionQuality.originalChoice.source === "jev" ? "Jev chose" : adaptive.decisionQuality.originalChoice.source === "mock" ? "Local mock selected" : "Deterministic fallback selected"} {adaptive.decisionQuality.originalChoice.strategyName}. Applied plan: {adaptive.decisionQuality.appliedStrategy.strategyName}.</strong><span>{adaptive.decisionQuality.explanation}</span><span>Continue current plan · {adaptive.decisionQuality.comparison.continueCurrentPlan.remainingCriticalCargoOnTimePercent.toFixed(1)}% of remaining critical cargo on time · {adaptive.decisionQuality.comparison.continueCurrentPlan.outcome.mean.averageCargoDelayHours.toFixed(1)}h average container delay · {outcomeCost(adaptive.decisionQuality.comparison.continueCurrentPlan.outcome)} total cost · {adaptive.decisionQuality.comparison.continueCurrentPlan.feasible ? "feasible" : "infeasible"} · {adaptive.decisionQuality.comparison.continueCurrentPlan.meetsMandatoryConstraints ? "meets constraints" : "misses constraints"}</span><span>{adaptive.decisionQuality.originalChoice.source === "jev" ? "Jev plan" : adaptive.decisionQuality.originalChoice.source === "mock" ? "Mock-selected plan" : "Fallback plan"} · {adaptive.decisionQuality.comparison.proposedPlan.remainingCriticalCargoOnTimePercent.toFixed(1)}% of remaining critical cargo on time · {adaptive.decisionQuality.comparison.proposedPlan.outcome.mean.averageCargoDelayHours.toFixed(1)}h average container delay · {outcomeCost(adaptive.decisionQuality.comparison.proposedPlan.outcome)} total cost · {adaptive.decisionQuality.comparison.proposedPlan.feasible ? "feasible" : "infeasible"} · {adaptive.decisionQuality.comparison.proposedPlan.meetsMandatoryConstraints ? "meets constraints" : "misses constraints"}</span><span>New disruption effect on the original plan · critical on time {adaptive.initialPlanWithoutNewDisruption.mean.criticalCargoOnTimePercent.toFixed(1)}% without the event vs. {adaptive.initialPlan.mean.criticalCargoOnTimePercent.toFixed(1)}% with it; average container delay {adaptive.initialPlanWithoutNewDisruption.mean.averageCargoDelayHours.toFixed(1)}h vs. {adaptive.initialPlan.mean.averageCargoDelayHours.toFixed(1)}h; cost {outcomeCost(adaptive.initialPlanWithoutNewDisruption)} vs. {outcomeCost(adaptive.initialPlan)}. Same seed and horizon.</span><span>Matched T+{adaptive.atHour} checkpoint, future disruptions, and seed · one seeded run per candidate. These are measured outcomes, not probability estimates.</span></div></section>}

            <section className="panel risk-panel"><div><div className="panel-kicker">RISK ASSESSMENT</div><h2>Simulation-based likelihoods</h2></div>{riskOutcome && <><div className="risk-panel__metrics"><div><small>Meet critical cargo target ({riskOutcome.targetCriticalCargoOnTimePercent}%)</small><strong>{Math.round(riskOutcome.probabilityOfMeetingTarget * 100)}%</strong></div><div><small>Below target</small><strong>{Math.round((1 - riskOutcome.probabilityOfMeetingTarget) * 100)}%</strong></div></div><p>{riskOutcome.runs} runs · seed {riskOutcome.seed} · {riskOutcome.horizonHours} hour horizon. Other probabilities (significant vessel delay, capacity overflow, and cost thresholds) are not calculated by this harness.</p></>}</section>

            <div className="section-title recommendation-heading"><div><div className="eyebrow">STEP 03 / CHOOSE YOUR RESPONSE</div><h2>Recovery playbook <span>— your call.</span></h2><p>Inspect complete plans, edit operational parameters, and evaluate a proposal under the same scenario and random seed.</p></div></div>
            {suggestedStrategy ? <RecoveryPlanner state={run.state} horizonHours={horizonHours} recommended={suggestedStrategy} decisionSource={decisionSource ?? "fallback"} evaluatedStrategies={run.payload.evaluatedStrategies} draft={draftPlan} evaluated={evaluatedPlan} pending={pendingChanges} busy={busy !== null} onLoad={loadPlan} onChange={(plan) => setDraftPlan(copyRecoveryPlan(plan))} onClear={() => setDraftPlan(null)} onEvaluate={() => void evaluatePlan()}/> : <div className="scenario-message scenario-message--error" role="status">No feasible recovery plan was returned for this scenario.</div>}
            <section className="panel compare-panel"><div className="compare-panel__heading"><div className="panel-kicker">SIDE-BY-SIDE OUTCOMES</div><h2>Baseline vs. evaluated plan</h2><p>{pendingChanges ? "Draft changed; metrics below still show the last evaluated plan." : evaluationCount ? "Plan " + evaluationCount + " evaluated under the same scenario, seed, and horizon." : recoverySourceLabel + " against baseline. Both values are Monte Carlo means; replay shows sample run 0."}</p></div><div className="compare-labels"><span>NO INTERVENTION</span><span>{evaluationCount ? "EVALUATED PLAN" : recoverySourceLabel}</span></div><div className="comparison-cards"><div className="comparison-half"><ResultStat name="Critical cargo on-time" value={baseline.mean.criticalCargoOnTimePercent.toFixed(1) + "%"}/><ResultStat name="Average container delay" value={baseline.mean.averageCargoDelayHours.toFixed(1) + "h"}/><ResultStat name="Containers at risk" value={number(containersAtRisk(baseline))} sub="not processed by the horizon"/><ResultStat name="Estimated disruption cost" value={outcomeCost(baseline)}/></div><div className="comparison-half comparison-half--enhanced"><ResultStat name="Critical cargo on-time" value={currentOutcome.mean.criticalCargoOnTimePercent.toFixed(1) + "%"} accent/><Delta before={baseline.mean.criticalCargoOnTimePercent} after={currentOutcome.mean.criticalCargoOnTimePercent} suffix=" pp"/><ResultStat name="Average container delay" value={currentOutcome.mean.averageCargoDelayHours.toFixed(1) + "h"} accent/><Delta before={baseline.mean.averageCargoDelayHours} after={currentOutcome.mean.averageCargoDelayHours} suffix="h" invert/><ResultStat name="Containers at risk" value={number(containersAtRisk(currentOutcome))} sub="not processed by the horizon" accent/><Delta before={containersAtRisk(baseline)} after={containersAtRisk(currentOutcome)} suffix=" containers" invert/><ResultStat name="Estimated disruption cost" value={outcomeCost(currentOutcome)} accent/>{baseline.mean.estimatedDisruptionCost !== null && currentOutcome.mean.estimatedDisruptionCost !== null && <Delta before={baseline.mean.estimatedDisruptionCost} after={currentOutcome.mean.estimatedDisruptionCost} prefix="$" invert/>}</div></div><div className="compare-bottom"><span><Icon name="info" size={14}/> Monte Carlo mean · {currentOutcome.runs} runs · seed {currentOutcome.seed} · {currentOutcome.horizonHours}h horizon</span><button disabled={!history.length || busy !== null} onClick={undoPlan}><Icon name="back" size={15}/> Undo last plan {history.length ? `(${history.length})` : ""}</button></div></section>
            {requestError && <div className="scenario-message scenario-message--error" role="alert"><Icon name="info" size={15}/>{requestError}</div>}
          </> : <div className="panel scenario-loading"><span className="map-loading__spinner"/>Preparing scenario results…</div>}
          <footer className="content-footer"><span>HARBORMIND · WHAT-IF SANDBOX</span><span>{run ? `Decision source: ${decisionSource} · simulation results, not validated forecasts` : "Server-side Jev harness · not a live operational control"}</span></footer>
        </main>}

        {tab === "about" && <main className="content-area about-area"><div className="page-heading"><div><div className="eyebrow">ABOUT / THE PROJECT</div><h1>Intelligence for the <br/>unpredictable<span className="heading-fullstop">.</span></h1><p>Maritime resilience starts before the next disruption.</p></div><span className="about-iteration">HACKATHON MVP <span>·</span> CONCEPT 01</span></div><div className="about-hero panel"><div><span className="eyebrow">THE MISSION</span><h2>When the unexpected hits,<br/><em>critical cargo keeps moving.</em></h2><p>HarborMind is a digital twin-style platform that models ports, vessels, cargo, and disruptions. Instead of only predicting problems, it lets operators test how responses could affect essential shipments before committing scarce port capacity.</p><button className="button button--primary" onClick={() => jump("simulations")}>Explore the scenario lab <Icon name="arrow" size={17}/></button></div><div className="about-hero-art" aria-hidden="true"><div className="about-radar"><div className="radar-arc radar-arc--1"/><div className="radar-arc radar-arc--2"/><div className="radar-arc radar-arc--3"/><Icon name="ship" size={68} strokeWidth={1.1}/><span className="radar-point radar-point--a"/><span className="radar-point radar-point--b"/><span className="radar-point radar-point--c"/></div></div></div><div className="about-section-heading"><span className="eyebrow">HOW IT WORKS</span><h2>Three layers. One clearer decision.</h2></div><div className="architecture-grid"><div className="architecture-card panel"><span className="architecture-icon"><Icon name="layers" size={24}/></span><small>01 / ENVIRONMENT</small><h3>Port digital twin</h3><p>Models port throughput, docking slots, vessels, cargo urgency, ETAs, and synthetic disruptions.</p><span className="architecture-tags"><em>Ships + berths</em><em>Cargo deadlines</em><em>Weather zones</em></span></div><div className="architecture-card panel"><span className="architecture-icon architecture-icon--teal"><Icon name="sparkle" size={24}/></span><small>02 / REASONING</small><h3>Jev decision harness</h3><p>The server-side TypeSafe Jev harness selects among recovery plans evaluated by the Monte Carlo simulator.</p><span className="architecture-tags"><em>Prioritization</em><em>Tradeoffs</em><em>Explainability</em></span></div><div className="architecture-card panel"><span className="architecture-icon architecture-icon--amber"><Icon name="grid" size={24}/></span><small>03 / EXPERIENCE</small><h3>Interactive scenario lab</h3><p>A map-first workspace to test storms and outages, inspect recommendations, and compare user-defined plans.</p><span className="architecture-tags"><em>Next.js</em><em>Three.js</em><em>What-if testing</em></span></div></div><div className="about-bottom-grid"><div className="panel tech-panel"><div className="panel-kicker">TECHNOLOGY</div><h2>Built for iteration.</h2><div className="tech-rows"><div><span><Icon name="grid" size={18}/> Frontend</span><strong>Next.js · App Router · React · CSS</strong></div><div><span><Icon name="globe" size={18}/> 3D visualization</span><strong>Three.js · WebGL</strong></div><div><span><Icon name="layers" size={18}/> Services</span><strong>Next.js API routes · seeded simulation harness</strong></div><div><span><Icon name="sparkle" size={18}/> AI decisioning</span><strong>Jev by TypeSafe · server API key required</strong></div><div><span><Icon name="wind" size={18}/> External data</span><strong>Open-Meteo forecast API · AISStream route available</strong></div></div></div><div className="panel roadmap-panel"><div className="panel-kicker">IMPLEMENTATION STATUS</div><h2>From prototype to platform.</h2><div className="roadmap-item"><span className="roadmap-item__done"><Icon name="check" size={15}/></span><div><strong>Interactive frontend baseline</strong><p>3D map, routes, scenarios, reversible decisions.</p></div><span>IN DEMO</span></div><div className="roadmap-item"><span className="roadmap-item__done"><Icon name="check" size={15}/></span><div><strong>Scenario simulation harness</strong><p>Seeded Monte Carlo outcomes and feasible recovery plan validation.</p></div><span>IN DEMO</span></div><div className="roadmap-item"><span className="roadmap-item__todo">3</span><div><strong>Connect live vessel and terminal feeds</strong><p>Live AIS positions, cargo manifests, and terminal operations.</p></div><span>PLANNED</span></div></div></div><div className="about-footer-note"><Icon name="shield" size={16}/> Port and cargo inputs are synthetic. Scenario recommendations identify Jev, local mock, or deterministic fallback results; simulation estimates are not validated forecasts.</div><footer className="content-footer"><span>HARBORMIND · RESILIENCE BY DESIGN</span><span>Keep what matters moving.</span></footer></main>}
      </div>
    </div>
  </div>;
}
