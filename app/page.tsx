"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import PortMap3D, { type MapCommand } from "./components/PortMap3D";
import {
  ACTIONS,
  EMPTY_ACTIONS,
  SCENARIOS,
  SHIPS,
  type ActionId,
  type ActionState,
  type ScenarioId,
  type Tab,
} from "./lib/data";
import { Icon } from "./lib/icons";
import type {
  OperationalSnapshot,
  Recommendation,
  RecoveryStrategy,
  SimulationOptions,
  SimulationReplay,
  SimulationState,
  SimulationSummary,
} from "../lib/harbormind/types.ts";
import { applyOpenMeteoForecast } from "../lib/harbormind/adapters.ts";
import {
  actionSelectionForStrategy,
  availableActionsForStrategies,
  configureScenarioState,
  isLatestScenarioRequest,
  planSelectionForActions,
  replayForMode,
  scenarioSignature,
  snapshotAtHour,
  toggleAction,
} from "./lib/scenario";

type EvaluatedStrategy = {
  strategy: RecoveryStrategy;
  outcome: SimulationSummary;
  affectedShips: string[];
  affectedCargo: string[];
};
type RecommendationPayload = {
  recommendation: Recommendation;
  availableStrategies: RecoveryStrategy[];
  evaluatedStrategies: EvaluatedStrategy[];
};
type SimulationPayload = {
  strategyId: string;
  outcome: SimulationSummary;
  baseline: SimulationSummary;
  strategy: RecoveryStrategy;
  replay: SimulationReplay;
  baselineReplay?: SimulationReplay;
};
type ScenarioRun = {
  state: SimulationState;
  options: Partial<SimulationOptions>;
  signature: string;
  payload: RecommendationPayload;
  simulation: SimulationPayload;
};
type PlanSnapshot = {
  actions: ActionState;
  strategyId: string | null;
  outcome: SimulationSummary;
  replay: SimulationReplay;
};

const SIMULATION_HORIZON_HOURS = 36;

async function responseJson<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `Server returned an unreadable response (${response.status}).`,
    );
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

const DAY_MONTH: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
};
const number = (value: number) => value.toLocaleString("en-US");
const isSamePlan = (a: ActionState, b: ActionState) =>
  (Object.keys(a) as ActionId[]).every((key) => a[key] === b[key]);

function Metric({
  title,
  value,
  detail,
  icon,
  tone = "normal",
}: {
  title: string;
  value: string;
  detail: string;
  icon: "ship" | "shield" | "box" | "clock";
  tone?: "normal" | "warning" | "success";
}) {
  return (
    <div className="metric-card">
      <div className="metric-card__top">
        <span>{title}</span>
        <span className="metric-icon">
          <Icon name={icon} size={17} />
        </span>
      </div>
      <div className="metric-card__value">{value}</div>
      <div className={`metric-card__detail metric-card__detail--${tone}`}>
        <span className="metric-dot" />
        {detail}
      </div>
    </div>
  );
}

function MapToolbox({
  onCommand,
  onPort,
}: {
  onCommand: (kind: MapCommand["kind"]) => void;
  onPort?: boolean;
}) {
  return (
    <div className="map-toolbox">
      <button
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => onCommand("zoomIn")}
      >
        <Icon name="plus" size={17} />
      </button>
      <button
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => onCommand("zoomOut")}
      >
        <Icon name="minus" size={17} />
      </button>
      <span className="map-toolbox__divider" />
      <button
        title={onPort ? "Focus port" : "Reset view"}
        aria-label={onPort ? "Focus port" : "Reset view"}
        onClick={() => onCommand(onPort ? "focusPort" : "reset")}
      >
        <Icon name={onPort ? "anchor" : "reset"} size={16} />
      </button>
    </div>
  );
}

function ResultStat({
  name,
  value,
  sub,
  accent = false,
}: {
  name: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`result-stat ${accent ? "result-stat--accent" : ""}`}>
      <div>{name}</div>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function Delta({
  before,
  after,
  suffix = "%",
  prefix = "",
  invert = false,
}: {
  before: number;
  after: number;
  suffix?: string;
  prefix?: string;
  invert?: boolean;
}) {
  const diff = after - before;
  const good = invert ? diff < 0 : diff > 0;
  const relative = before ? (diff / Math.abs(before)) * 100 : null;
  return (
    <span
      className={`outcome-delta ${diff === 0 ? "outcome-delta--flat" : good ? "outcome-delta--good" : "outcome-delta--bad"}`}
    >
      {diff > 0 ? "+" : ""}
      {prefix}
      {Number.isInteger(diff) ? diff : diff.toFixed(1)}
      {suffix}
      {relative === null
        ? ""
        : ` (${relative > 0 ? "+" : ""}${relative.toFixed(1)}%)`}{" "}
      vs. baseline
    </span>
  );
}

function ReplayOperations({
  snapshot,
  state,
}: {
  snapshot: OperationalSnapshot | null;
  state: SimulationState;
}) {
  if (!snapshot)
    return (
      <div className="replay-empty">
        Operational replay data is unavailable for this view.
      </div>
    );
  const isUnloading = (vesselId: string) =>
    snapshot.cargoBatches.some(
      (batch) => batch.vesselId === vesselId && batch.status === "unloading",
    );
  const criticalRemaining = snapshot.cargoBatches
    .filter((batch) => batch.criticality === "critical")
    .reduce((sum, batch) => sum + batch.containersRemaining, 0);
  const formatStatus = (
    status: OperationalSnapshot["vessels"][number]["status"],
    vesselId: string,
  ) =>
    status === "departed"
      ? "Completed"
      : status === "waiting"
        ? "Waiting"
        : status === "berthed"
          ? isUnloading(vesselId)
            ? "Unloading"
            : "Docked"
          : "Scheduled";

  return (
    <div className="replay-operations" aria-live="polite">
      <div className="replay-operations__summary">
        <strong>T+{snapshot.simulationHour}h operations</strong>
        <span>
          {criticalRemaining.toLocaleString("en-US")} critical containers
          remaining
        </span>
      </div>
      {snapshot.ports.map((portSnapshot) => {
        const port = state.ports.find(
          (item) => item.portId === portSnapshot.portId,
        );
        return (
          <section className="replay-port" key={portSnapshot.portId}>
            <div className="replay-port__facts">
              <strong>{port?.location.name ?? portSnapshot.portId}</strong>
              <span>
                {portSnapshot.capacityContainersPerHour.toFixed(2)}{" "}
                containers/hour · {portSnapshot.berthAssignments.length}/
                {port?.availableBerths ?? portSnapshot.berthAssignments.length}{" "}
                berths occupied
              </span>
            </div>
            <div className="replay-berths">
              {portSnapshot.berthAssignments.length ? (
                portSnapshot.berthAssignments.map(({ berthId, vesselId }) => (
                  <span key={berthId}>
                    {berthId}: {vesselId}
                  </span>
                ))
              ) : (
                <span>No occupied berths</span>
              )}
            </div>
            <div className="replay-disruptions">
              {portSnapshot.activeDisruptions.length ? (
                portSnapshot.activeDisruptions.map((item) => (
                  <span key={item.id}>
                    {item.description} · {Math.round(item.severity * 100)}%
                  </span>
                ))
              ) : (
                <span>No active disruptions</span>
              )}
            </div>
          </section>
        );
      })}
      <div className="replay-vessels">
        {snapshot.vessels.map((vessel) => {
          const ship = state.ships.find(
            (item) => item.vesselId === vessel.vesselId,
          );
          const plannedArrival = ship
            ? (Date.parse(ship.estimatedArrival) - Date.parse(state.startAt)) /
              3_600_000
            : vessel.arrivalHour;
          const delayed =
            vessel.status !== "departed" &&
            (vessel.arrivalHour > plannedArrival + 0.25 ||
              (vessel.status === "waiting" &&
                snapshot.simulationHour > vessel.arrivalHour + 0.25) ||
              (vessel.berthAtHour !== null &&
                vessel.berthAtHour > vessel.arrivalHour + 0.25));
          const batches = snapshot.cargoBatches.filter(
            (batch) => batch.vesselId === vessel.vesselId,
          );
          const carriesCriticalCargo = batches.some(
            (batch) => batch.criticality === "critical",
          );
          return (
            <article className="replay-vessel" key={vessel.vesselId}>
              <div className="replay-vessel__heading">
                <Icon
                  name="ship"
                  size={13}
                  className={`replay-vessel__icon ${carriesCriticalCargo ? "replay-vessel__icon--critical" : ""}`}
                />
                <strong>{vessel.vesselId}</strong>
                <span
                  className={`replay-state replay-state--${formatStatus(vessel.status, vessel.vesselId).toLowerCase()}`}
                >
                  {formatStatus(vessel.status, vessel.vesselId)}
                </span>
                {delayed && <span className="replay-delayed">Delayed</span>}
                {vessel.berthId && <small>{vessel.berthId}</small>}
              </div>
              {batches.map((batch) => (
                <div className="replay-cargo" key={batch.batchId}>
                  <span>
                    {batch.criticality === "critical" ? "Critical" : "Standard"}{" "}
                    · {batch.category}
                  </span>
                  <strong>
                    {batch.containersUnloaded}/{batch.containers} unloaded ·{" "}
                    {batch.containersRemaining} remaining
                  </strong>
                </div>
              ))}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedShip, setSelectedShip] = useState("PM-104");
  const [mapCommand, setMapCommand] = useState<MapCommand>({
    kind: "reset",
    nonce: 0,
  });
  const [now, setNow] = useState<Date | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scenarioId, setScenarioId] = useState<ScenarioId>("storm");
  const [capacityLoss, setCapacityLoss] = useState(60);
  const [duration, setDuration] = useState(18);
  const [ran, setRan] = useState(false);
  const [busy, setBusy] = useState<"scenario" | "evaluation" | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [run, setRun] = useState<ScenarioRun | null>(null);
  const [evaluatedOutcome, setEvaluatedOutcome] =
    useState<SimulationSummary | null>(null);
  const [actions, setActions] = useState<ActionState>({ ...EMPTY_ACTIONS });
  const [evaluatedActions, setEvaluatedActions] = useState<ActionState>({
    ...EMPTY_ACTIONS,
  });
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(
    null,
  );
  const [evaluatedStrategyId, setEvaluatedStrategyId] = useState<string | null>(
    null,
  );
  const [history, setHistory] = useState<PlanSnapshot[]>([]);
  const [evaluationCount, setEvaluationCount] = useState(0);
  const [simulationHour, setSimulationHour] = useState(0);
  const [replayMode, setReplayMode] = useState<"baseline" | "recovery">(
    "baseline",
  );
  const [evaluatedReplay, setEvaluatedReplay] =
    useState<SimulationReplay | null>(null);
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

  const isCurrentRequest = (id: number, controller: AbortController) =>
    isLatestScenarioRequest(
      id,
      requestId.current,
      controller,
      requestController.current,
    );

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

  useEffect(() => {
    if (!ran || !playing) return;
    const timer = window.setInterval(
      () =>
        setSimulationHour((hour) => {
          if (hour >= horizonHours) {
            setPlaying(false);
            return hour;
          }
          return Math.min(horizonHours, hour + 1);
        }),
      900,
    );
    return () => window.clearInterval(timer);
  }, [ran, playing, horizonHours]);

  const selected = SHIPS.find((ship) => ship.id === selectedShip) ?? SHIPS[0];
  const scenario =
    SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0];
  const activeSignature = scenarioSignature(scenarioId, capacityLoss, duration);
  const staleRun = Boolean(run && run.signature !== activeSignature);
  const baseline = run?.simulation.baseline ?? null;
  const recoveryOutcome = evaluatedOutcome ?? run?.simulation.outcome ?? null;
  const currentOutcome = recoveryOutcome;
  const selectedOutcome =
    replayMode === "baseline" ? baseline! : recoveryOutcome!;
  const pendingChanges =
    !isSamePlan(actions, evaluatedActions) ||
    selectedStrategyId !== evaluatedStrategyId;
  const selectedActionsCount = Object.values(actions).filter(Boolean).length;
  const suggestedStrategy =
    run?.payload.recommendation &&
    run.payload.availableStrategies.find(
      (item) => item.id === run.payload.recommendation.selectedStrategyId,
    );
  const suggestedActions = suggestedStrategy
    ? actionSelectionForStrategy(suggestedStrategy)
    : EMPTY_ACTIONS;
  const actionAvailability = availableActionsForStrategies(
    run?.payload.availableStrategies ?? [],
  );
  const totalContainers =
    run?.state.ships
      .flatMap((ship) => ship.cargo)
      .reduce((sum, cargo) => sum + cargo.containers, 0) ?? 0;
  const recoveryReplay = evaluatedReplay ?? run?.simulation.replay;
  const activeReplay = replayForMode(
    replayMode,
    run?.simulation.baselineReplay,
    recoveryReplay,
  );
  const replaySnapshot = snapshotAtHour(activeReplay, simulationHour);
  const riskOutcome = selectedOutcome;
  const decisionSource = run?.payload.recommendation.decisionSource;
  const decisionStatus =
    busy === "scenario"
      ? "EVALUATING SCENARIO"
      : busy === "evaluation"
        ? "SIMULATING PLAN"
        : staleRun
          ? "SCENARIO CHANGED"
          : !run
            ? requestError
              ? "JEV UNAVAILABLE"
              : "JEV NOT EVALUATED"
            : decisionSource === "jev"
              ? "RECOMMENDATION AVAILABLE"
              : decisionSource === "mock"
                ? "LOCAL JEV MOCK"
                : "FALLBACK STRATEGY";
  const candidateForAction = (id: ActionId) =>
    run?.payload.evaluatedStrategies.find(
      (item) => actionSelectionForStrategy(item.strategy)[id],
    );
  const containersAtRisk = (summary: SimulationSummary) =>
    Math.max(
      0,
      totalContainers - Math.round(summary.mean.totalContainersProcessed),
    );
  const outcomeCost = (summary: SimulationSummary) =>
    summary.mean.estimatedDelayCost === null
      ? "Unavailable"
      : `$${number(summary.mean.estimatedDelayCost)}`;

  const issueMapCommand = (kind: MapCommand["kind"], shipId?: string) =>
    setMapCommand((current) => ({ kind, shipId, nonce: current.nonce + 1 }));
  const jump = (destination: Tab) => {
    setTab(destination);
    setMobileMenu(false);
    issueMapCommand("reset");
  };
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
      const stateResponse = await fetch("/api/scenario", {
        cache: "no-store",
        signal: controller.signal,
      });
      let state = configureScenarioState(
        await responseJson<SimulationState>(stateResponse),
        scenario,
        capacityLoss,
        duration,
      );
      try {
        const weatherResponse = await fetch("/api/weather", {
          cache: "no-store",
          signal: AbortSignal.timeout(9_000),
        });
        if (weatherResponse.ok)
          state = applyOpenMeteoForecast(
            state,
            await weatherResponse.json(),
            state.ports[0]?.portId,
          );
      } catch {
        if (controller.signal.aborted)
          throw new DOMException("Request aborted", "AbortError");
      }
      if (!isCurrentRequest(id, controller)) return;
      const options = {
        runs: 40,
        seed: 42,
        horizonHours: SIMULATION_HORIZON_HOURS,
      };
      const recommendationResponse = await fetch("/api/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ state, options }),
      });
      const payload = await responseJson<RecommendationPayload>(
        recommendationResponse,
      );
      if (!isCurrentRequest(id, controller)) return;
      const simulationResponse = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          state,
          options,
          strategyId: payload.recommendation.selectedStrategyId,
        }),
      });
      const simulation =
        await responseJson<SimulationPayload>(simulationResponse);
      if (!isCurrentRequest(id, controller)) return;
      setRun({
        state,
        options,
        signature: activeSignature,
        payload,
        simulation,
      });
      setEvaluatedOutcome(null);
      setEvaluatedReplay(null);
      setReplayMode("recovery");
      setActions({ ...EMPTY_ACTIONS });
      setEvaluatedActions({ ...EMPTY_ACTIONS });
      setSelectedStrategyId(null);
      setEvaluatedStrategyId(null);
      setHistory([]);
      setEvaluationCount(0);
      setSimulationHour(0);
      setPlaying(false);
      setRan(true);
      setRequestError(null);
      issueMapCommand("reset");
    } catch (error) {
      if (
        isCurrentRequest(id, controller) &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        setRequestError(
          error instanceof Error
            ? error.message
            : "Could not evaluate this scenario.",
        );
    } finally {
      if (isCurrentRequest(id, controller)) {
        requestController.current = null;
        setBusy(null);
      }
    }
  };
  const evaluatePlan = async (plan = actions, strategyIdOverride?: string) => {
    if (!run) return;
    const request = beginRequest("evaluation");
    if (!request) return;
    const { controller, id } = request;
    const exactStrategyId =
      strategyIdOverride ??
      (isSamePlan(plan, actions) ? selectedStrategyId : null);
    try {
      const response = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          state: run.state,
          options: run.options,
          ...(exactStrategyId
            ? { strategyId: exactStrategyId }
            : { plan: planSelectionForActions(plan) }),
        }),
      });
      const result = await responseJson<SimulationPayload>(response);
      if (!isCurrentRequest(id, controller)) return;
      if (evaluatedOutcome && evaluatedReplay)
        setHistory((previous) => [
          ...previous,
          {
            actions: { ...evaluatedActions },
            strategyId: evaluatedStrategyId,
            outcome: evaluatedOutcome,
            replay: evaluatedReplay,
          },
        ]);
      setActions({ ...plan });
      setEvaluatedActions({ ...plan });
      setSelectedStrategyId(exactStrategyId);
      setEvaluatedStrategyId(exactStrategyId);
      setEvaluatedOutcome(result.outcome);
      setEvaluatedReplay(result.replay);
      setReplayMode("recovery");
      setEvaluationCount((count) => count + 1);
      setSimulationHour(0);
      setPlaying(false);
      setRequestError(null);
    } catch (error) {
      if (
        isCurrentRequest(id, controller) &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        setRequestError(
          error instanceof Error
            ? error.message
            : "Could not simulate this recovery plan.",
        );
    } finally {
      if (isCurrentRequest(id, controller)) {
        requestController.current = null;
        setBusy(null);
      }
    }
  };
  const selectStrategy = (strategy: RecoveryStrategy) => {
    setActions(actionSelectionForStrategy(strategy));
    setSelectedStrategyId(strategy.id);
    setRequestError(null);
  };
  const undoPlan = () => {
    if (!history.length) return;
    const previous = history[history.length - 1];
    setHistory((current) => current.slice(0, -1));
    setActions({ ...previous.actions });
    setEvaluatedActions({ ...previous.actions });
    setSelectedStrategyId(previous.strategyId);
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

  const formatDate = now
    ? now.toLocaleDateString("en-US", DAY_MONTH).toUpperCase()
    : "DEMO";
  const time = now
    ? now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "--:--";

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar--open" : ""}`}>
        <button
          className="brand"
          onClick={() => jump("overview")}
          aria-label="HarborMind home"
        >
          <span className="brand__mark">
            <Icon name="layers" size={22} strokeWidth={2} />
          </span>
          <span className="brand__words">
            <strong>
              harbor<span>mind</span>
            </strong>
            <small>RESILIENCE PLATFORM</small>
          </span>
        </button>
        <div className="sidebar__section-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            className={tab === "overview" ? "active" : ""}
            onClick={() => jump("overview")}
          >
            <Icon name="grid" size={18} />
            <span>Command center</span>
            <span className="nav-active-dot" />
          </button>
          <button
            className={tab === "simulations" ? "active" : ""}
            onClick={() => jump("simulations")}
          >
            <Icon name="flask" size={18} />
            <span>Scenario lab</span>
            <span className="nav-beta">BETA</span>
          </button>
          <button
            className={tab === "about" ? "active" : ""}
            onClick={() => jump("about")}
          >
            <Icon name="info" size={18} />
            <span>About project</span>
          </button>
        </nav>
        <div className="sidebar__bottom">
          <div className="sidebar__port">
            <span className="sidebar__port-icon">
              <Icon name="anchor" size={19} />
            </span>
            <div>
              <small>ACTIVE PORT</small>
              <strong>Los Angeles, CA</strong>
              <span>33.74° N · 118.27° W</span>
            </div>
            <Icon name="chevron" size={16} />
          </div>
          <div className="environment">
            <span className="environment__pulse" />
            <span>DEMO ENVIRONMENT</span>
            <span>v0.1</span>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__left">
            <button
              aria-label="Open navigation"
              className="mobile-menu"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              <Icon name="menu" />
            </button>
            <span className="breadcrumb-start">OPERATIONS</span>
            <Icon name="chevron" size={14} />
            <strong>
              {tab === "overview"
                ? "Command center"
                : tab === "simulations"
                  ? "Scenario lab"
                  : "About project"}
            </strong>
          </div>
          <div className="topbar__right">
            <span className="topbar__local">
              <Icon name="clock" size={14} /> {formatDate}{" "}
              <span className="topbar__clock">{time} LOCAL</span>
            </span>
            <span className="topbar__divider" />
            <span className="system-status">
              <span /> SYSTEMS READY
            </span>
            <a
              className="avatar"
              href="https://github.com/Reilynn-Olsen/usc-hackathon/tree/docker-next"
              aria-label="View project on GitHub"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="github" size={18} />
            </a>
          </div>
        </header>

        <div className="page-scroll">
          {tab === "overview" && (
            <main className="content-area">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">MARITIME OPERATIONS / OVERVIEW</div>
                  <h1>
                    Command center<span className="heading-fullstop">.</span>
                  </h1>
                  <p>
                    Live-style situational awareness for critical cargo
                    movements.
                  </p>
                </div>
                <button
                  className="button button--outline heading-action"
                  onClick={() => jump("simulations")}
                >
                  <Icon name="flask" size={17} /> Open scenario lab{" "}
                  <Icon name="arrow" size={15} />
                </button>
              </div>

              <div className="weather-banner">
                <span className="weather-banner__icon">
                  <Icon name="alert" size={20} />
                </span>
                <div className="weather-banner__body">
                  <div>
                    <strong>Marine weather advisory</strong>
                    <span className="weather-banner__tag">MONITORING</span>
                  </div>
                  <p>
                    Elevated coastal winds detected in the demo zone. Select a
                    scenario to model operational impact.
                  </p>
                </div>
                <button onClick={() => jump("simulations")}>
                  Model disruption <Icon name="arrow" size={15} />
                </button>
              </div>

              <div className="metrics-grid">
                <Metric
                  title="Tracked vessels"
                  value="06"
                  detail="4 inbound · 2 at approach"
                  icon="ship"
                />
                <Metric
                  title="Critical shipments"
                  value="01"
                  detail="Medical cargo prioritized"
                  icon="shield"
                  tone="success"
                />
                <Metric
                  title="Containers in transit"
                  value="12,320"
                  detail="Synthetic cargo manifest"
                  icon="box"
                />
                <Metric
                  title="Berth utilization"
                  value="78%"
                  detail="Approaching high capacity"
                  icon="clock"
                  tone="warning"
                />
              </div>

              <div className="main-grid">
                <section className="map-panel panel">
                  <div className="panel-top">
                    <div>
                      <div className="panel-kicker">
                        <span className="live-dot" /> 3D MARITIME VIEW{" "}
                        <span className="panel-kicker__divider">/</span> PACIFIC
                        COAST
                      </div>
                      <h2>Port traffic overview</h2>
                    </div>
                    <div className="panel-top__actions">
                      <span className="small-data-label">
                        <Icon name="layers" size={13} /> DEMO VESSELS
                      </span>
                      <button
                        className="mini-button"
                        onClick={() => issueMapCommand("focusPort")}
                      >
                        <Icon name="anchor" size={14} /> Focus port
                      </button>
                    </div>
                  </div>
                  <div className="map-stage">
                    <PortMap3D
                      selectedShip={selectedShip}
                      onSelectShip={setSelectedShip}
                      weather={{ x: -42, z: -34, radius: 17, color: "#dba75b" }}
                      command={mapCommand}
                    />
                    <div className="map-top-left">
                      <span className="map-tag">
                        <Icon name="globe" size={13} /> LOS ANGELES HARBOR
                      </span>
                      <div className="map-coords">33.7405° N, 118.2728° W</div>
                    </div>
                    <MapToolbox onCommand={issueMapCommand} />
                    <div className="map-legend">
                      <span>
                        <i className="legend-dot legend-dot--teal" /> Critical
                        cargo
                      </span>
                      <span>
                        <i className="legend-dot legend-dot--yellow" /> High
                        priority
                      </span>
                      <span>
                        <i className="legend-dot legend-dot--blue" /> Standard
                      </span>
                      <span>
                        <i className="legend-line" /> Vessel route
                      </span>
                    </div>
                    <span className="view-badge">
                      PERSPECTIVE <b>·</b> 3D
                    </span>
                  </div>
                  <div className="map-panel__footer">
                    <span>
                      <Icon name="info" size={14} /> Select a vessel or scroll
                      to explore. Synthetic locations, routes, and cargo.
                    </span>
                    <span>
                      <span className="live-dot" /> SCENE ACTIVE
                    </span>
                  </div>
                </section>

                <aside className="details-column">
                  <section className="panel vessel-card">
                    <div className="side-panel-header">
                      <div className="panel-kicker">VESSEL INSPECTOR</div>
                      <span className="tiny-outline">{selected.id}</span>
                    </div>
                    <div className="vessel-card__title">
                      <div className="vessel-avatar">
                        <Icon name="ship" size={27} />
                      </div>
                      <div>
                        <h2>{selected.name}</h2>
                        <p>CALL SIGN {selected.callSign}</p>
                      </div>
                    </div>
                    <span
                      className={`priority-pill priority-pill--${selected.priority.toLowerCase()}`}
                    >
                      <span />
                      {selected.priority.toUpperCase()} PRIORITY
                    </span>
                    <div className="vessel-progress-header">
                      <span>Route completion</span>
                      <strong>{Math.round(selected.progress * 100)}%</strong>
                    </div>
                    <div className="progress-track">
                      <span
                        style={{
                          width: `${selected.progress * 100}%`,
                          background: selected.color,
                        }}
                      />
                    </div>
                    <div className="vessel-data-grid">
                      <div>
                        <small>CARGO TYPE</small>
                        <strong>{selected.cargo}</strong>
                      </div>
                      <div>
                        <small>CONTAINERS</small>
                        <strong>{number(selected.containers)} TEU</strong>
                      </div>
                      <div>
                        <small>EST. ARRIVAL</small>
                        <strong>
                          {selected.eta} <em>PT</em>
                        </strong>
                      </div>
                      <div>
                        <small>STATUS</small>
                        <strong className="status-dot-text">
                          <span /> {selected.status}
                        </strong>
                      </div>
                    </div>
                    <button
                      className="button button--subtle vessel-focus"
                      onClick={() => issueMapCommand("focusShip", selected.id)}
                    >
                      <Icon name="target" size={15} /> Focus on vessel{" "}
                      <Icon name="arrow" size={14} />
                    </button>
                  </section>
                  <section className="panel activity-panel">
                    <div className="side-panel-header">
                      <div>
                        <div className="panel-kicker">OPERATIONS PULSE</div>
                        <h3>Port conditions</h3>
                      </div>
                      <span className="tiny-outline">DEMO</span>
                    </div>
                    <div className="conditions-row">
                      <div className="conditions-row__icon conditions-row__icon--teal">
                        <Icon name="anchor" size={17} />
                      </div>
                      <div>
                        <strong>Dock availability</strong>
                        <span>3 of 5 berths occupied</span>
                      </div>
                      <span className="condition-indicator">NORMAL</span>
                    </div>
                    <div className="conditions-row">
                      <div className="conditions-row__icon conditions-row__icon--amber">
                        <Icon name="wind" size={17} />
                      </div>
                      <div>
                        <strong>Coastal conditions</strong>
                        <span>Elevated wind watch</span>
                      </div>
                      <span className="condition-indicator condition-indicator--warn">
                        WATCH
                      </span>
                    </div>
                    <div className="conditions-row">
                      <div className="conditions-row__icon conditions-row__icon--blue">
                        <Icon name="route" size={17} />
                      </div>
                      <div>
                        <strong>Shipping channel</strong>
                        <span>Moderate inbound flow</span>
                      </div>
                      <span className="condition-indicator">OPEN</span>
                    </div>
                  </section>
                  <div className="intelligence-link">
                    <span className="intelligence-link__star">
                      <Icon name="sparkle" size={19} />
                    </span>
                    <div>
                      <strong>Prepare before disruption.</strong>
                      <p>Run scenarios to compare recovery strategies.</p>
                    </div>
                    <button
                      aria-label="Open scenario lab"
                      onClick={() => jump("simulations")}
                    >
                      <Icon name="arrow" size={18} />
                    </button>
                  </div>
                </aside>
              </div>
              <footer className="content-footer">
                <span>HARBORMIND · DIGITAL TWIN PROTOTYPE</span>
                <span>
                  Illustrative data only · Not for operational navigation
                </span>
              </footer>
            </main>
          )}

          {tab === "simulations" && (
            <main className="content-area scenario-area">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    DISRUPTION PLANNING / WHAT-IF ENGINE
                  </div>
                  <h1>
                    Scenario lab<span className="heading-fullstop">.</span>
                  </h1>
                  <p>
                    Stress-test port operations. Compare tradeoffs. Keep
                    essential cargo moving.
                  </p>
                </div>
                <span className="scenario-demo-pill">
                  <Icon name="sparkle" size={15} /> {decisionStatus}
                </span>
              </div>
              {requestError && (
                <div
                  className="scenario-message scenario-message--error"
                  role="alert"
                >
                  <Icon name="alert" size={16} />
                  <span>{requestError}</span>
                </div>
              )}
              {staleRun && (
                <div className="scenario-message" role="status">
                  <Icon name="info" size={16} />
                  <span>
                    Scenario settings changed. The previous recommendation and
                    results are retained until the new scenario finishes.
                  </span>
                </div>
              )}
              <div className="scenario-steps">
                <div className="scenario-step is-done">
                  <span>01</span> Configure disruption
                </div>
                <Icon name="chevron" size={15} />
                <div className={`scenario-step ${ran ? "is-done" : ""}`}>
                  <span>02</span> Run simulation
                </div>
                <Icon name="chevron" size={15} />
                <div className={`scenario-step ${ran ? "is-done" : ""}`}>
                  <span>03</span> Explore recovery plan
                </div>
              </div>
              {!ran ? (
                <>
                  <div className="section-title">
                    <div>
                      <div className="eyebrow">
                        STEP 01 / SELECT A DISRUPTION
                      </div>
                      <h2>What should we simulate?</h2>
                    </div>
                    <span>Choose one of four modeled conditions</span>
                  </div>
                  <div className="scenario-options">
                    {SCENARIOS.map((item) => (
                      <button
                        key={item.id}
                        disabled={busy !== null}
                        onClick={() => chooseScenario(item.id)}
                        className={`scenario-option ${scenarioId === item.id ? "scenario-option--selected" : ""}`}
                      >
                        <span
                          className={`scenario-option__icon scenario-option__icon--${item.icon}`}
                        >
                          <Icon name={item.icon} size={24} />
                        </span>
                        <span className="scenario-option__heading">
                          <strong>{item.label}</strong>
                          {scenarioId === item.id && (
                            <span className="scenario-selected-check">
                              <Icon name="check" size={13} />
                            </span>
                          )}
                        </span>
                        <span className="scenario-option__kicker">
                          {item.kicker}
                        </span>
                        <span className="scenario-option__desc">
                          {item.description}
                        </span>
                        <span className="scenario-option__impact">
                          <Icon name="alert" size={14} /> {item.impact}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="scenario-config-grid">
                    <section className="panel config-panel">
                      <div className="panel-kicker">STEP 02 / CONFIGURE</div>
                      <h2>Disruption parameters</h2>
                      <p>
                        Adjust the severity and estimated duration to model
                        different outcomes.
                      </p>
                      <div className="slider-heading">
                        <label htmlFor="capacity-slider">
                          Effective capacity reduction
                        </label>
                        <strong>{capacityLoss}%</strong>
                      </div>
                      <input
                        id="capacity-slider"
                        className="range-slider"
                        type="range"
                        min="10"
                        max="90"
                        step="5"
                        value={capacityLoss}
                        disabled={busy !== null}
                        style={
                          {
                            "--slider-progress": `${((capacityLoss - 10) / 80) * 100}%`,
                          } as CSSProperties
                        }
                        onChange={(event) => {
                          invalidateRequest();
                          setCapacityLoss(Number(event.target.value));
                          setRequestError(null);
                        }}
                      />
                      <div className="range-labels">
                        <span>10% / Mild</span>
                        <span>90% / Severe</span>
                      </div>
                      <label
                        className="duration-label"
                        htmlFor="duration-select"
                      >
                        Disruption duration
                      </label>
                      <div className="select-wrap">
                        <select
                          id="duration-select"
                          value={duration}
                          disabled={busy !== null}
                          onChange={(event) => {
                            invalidateRequest();
                            setDuration(Number(event.target.value));
                            setRequestError(null);
                          }}
                        >
                          <option value="6">6 hours</option>
                          <option value="12">12 hours</option>
                          <option value="18">18 hours</option>
                          <option value="24">24 hours</option>
                          <option value="36">36 hours</option>
                        </select>
                        <Icon name="chevron" size={17} />
                      </div>
                      <div className="config-note">
                        <Icon name="info" size={16} /> The server runs 40 seeded
                        trials across a 36-hour horizon. Set how many hours the
                        disruption remains active; Jev decisions stay
                        server-side.
                      </div>
                      <button
                        className="button button--primary run-button"
                        disabled={busy !== null}
                        onClick={() => void runScenario()}
                      >
                        <Icon
                          name={busy === "scenario" ? "clock" : "play"}
                          size={17}
                        />
                        {busy === "scenario"
                          ? "Evaluating scenario…"
                          : "Run simulation"}
                        <Icon name="arrow" size={17} />
                      </button>
                    </section>
                    <section className="panel preview-panel">
                      <div className="panel-top">
                        <div>
                          <div className="panel-kicker">SCENARIO PREVIEW</div>
                          <h2>Potential area of impact</h2>
                        </div>
                        <span className="tiny-outline">3D DIGITAL TWIN</span>
                      </div>
                      <div className="scenario-preview-map">
                        <PortMap3D
                          selectedShip={selectedShip}
                          onSelectShip={setSelectedShip}
                          weather={scenario.zone}
                          scenarioId={scenarioId}
                          simulated
                          compact
                          command={mapCommand}
                        />
                        <span className="map-tag preview-map-tag">
                          <Icon name={scenario.icon} size={13} />{" "}
                          {scenario.label.toUpperCase()}
                        </span>
                        <MapToolbox onCommand={issueMapCommand} />
                      </div>
                      <div className="preview-panel__foot">
                        <span>
                          <i
                            className="impact-indicator"
                            style={{ background: scenario.zone.color }}
                          />{" "}
                          Disruption footprint
                        </span>
                        <span>
                          <i className="legend-line" /> Synthetic shipping
                          routes
                        </span>
                      </div>
                    </section>
                  </div>
                </>
              ) : run && baseline && currentOutcome ? (
                <>
                  <div className="simulation-toolbar">
                    <div>
                      <button className="text-back" onClick={goBackToSetup}>
                        <Icon name="back" size={17} /> Edit scenario
                      </button>
                      <h2>
                        {scenario.label} <span>simulation</span>
                      </h2>
                      <div className="simulation-subtitle">
                        <span className="live-dot live-dot--amber" /> DISRUPTION
                        INJECTED <b>·</b> {capacityLoss}% CAPACITY LOSS <b>·</b>{" "}
                        {duration}H DISRUPTION <b>·</b> {horizonHours}H HORIZON
                      </div>
                    </div>
                    <button
                      className="button button--outline"
                      onClick={goBackToSetup}
                    >
                      <Icon name="reset" size={15} /> Edit scenario
                    </button>
                  </div>
                  <div className="running-map-grid">
                    <section className="panel running-map-panel">
                      <div className="panel-top">
                        <div>
                          <div className="panel-kicker">
                            SIMULATED PORT OPERATIONS
                          </div>
                          <h2>Disruption footprint</h2>
                        </div>
                        <div
                          className="replay-mode-switch"
                          role="group"
                          aria-label="Replay view"
                        >
                          <button
                            className={
                              replayMode === "baseline" ? "is-selected" : ""
                            }
                            aria-pressed={replayMode === "baseline"}
                            onClick={() => {
                              setPlaying(false);
                              setReplayMode("baseline");
                            }}
                          >
                            Baseline
                          </button>
                          <button
                            className={
                              replayMode === "recovery" ? "is-selected" : ""
                            }
                            aria-pressed={replayMode === "recovery"}
                            onClick={() => {
                              setPlaying(false);
                              setReplayMode("recovery");
                            }}
                          >
                            {evaluatedOutcome
                              ? "Recovery plan"
                              : decisionSource === "jev"
                                ? "Jev-assisted"
                                : decisionSource === "mock"
                                  ? "Mock plan"
                                  : "Fallback plan"}
                          </button>
                        </div>
                      </div>
                      <div className="running-map-stage">
                        <PortMap3D
                          selectedShip={selectedShip}
                          onSelectShip={setSelectedShip}
                          weather={scenario.zone}
                          simulated
                          scenarioId={scenarioId}
                          compact
                          command={mapCommand}
                        />
                        <div className="map-top-left">
                          <span className="map-tag">
                            <Icon name={scenario.icon} size={13} />{" "}
                            {scenario.label.toUpperCase()}
                          </span>
                          <div className="map-coords">
                            MODELED EVENT ·{" "}
                            {run.state.provenance.ports.toUpperCase()} PORT
                            INPUT
                          </div>
                        </div>
                        <MapToolbox onCommand={issueMapCommand} />
                        {replaySnapshot && (
                          <div className="replay-map-status">
                            <strong>
                              T+{replaySnapshot.simulationHour}H ·{" "}
                              {replayMode === "baseline"
                                ? "BASELINE"
                                : "RECOVERY"}
                            </strong>
                            <span>
                              {replaySnapshot.ports.reduce(
                                (sum, port) =>
                                  sum + port.berthAssignments.length,
                                0,
                              )}{" "}
                              occupied berths ·{" "}
                              {
                                replaySnapshot.vessels.filter(
                                  (vessel) => vessel.status === "waiting",
                                ).length
                              }{" "}
                              waiting vessels
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="sim-timeline">
                        <button
                          disabled={busy !== null}
                          title={playing ? "Pause replay" : "Play replay"}
                          aria-label={playing ? "Pause replay" : "Play replay"}
                          onClick={() => {
                            if (simulationHour >= horizonHours)
                              setSimulationHour(0);
                            setPlaying(!playing);
                          }}
                        >
                          <Icon name={playing ? "pause" : "play"} size={15} />
                        </button>
                        <button
                          disabled={busy !== null}
                          title="Go back one hour"
                          aria-label="Go back one hour"
                          onClick={() => {
                            setPlaying(false);
                            setSimulationHour(Math.max(0, simulationHour - 1));
                          }}
                        >
                          <Icon name="back" size={15} />
                        </button>
                        <span className="sim-timeline__start">T+0H</span>
                        <input
                          aria-label="Simulation timeline"
                          aria-valuetext={"T+" + simulationHour + " hours"}
                          type="range"
                          min="0"
                          max={horizonHours}
                          step="1"
                          value={simulationHour}
                          onChange={(event) => {
                            setPlaying(false);
                            setSimulationHour(Number(event.target.value));
                          }}
                        />
                        <span className="sim-timeline__end">
                          T+{horizonHours}H
                        </span>
                        <strong>T+{simulationHour}H</strong>
                      </div>
                      <ReplayOperations
                        snapshot={replaySnapshot}
                        state={run.state}
                      />
                      <div className="map-integration-note">
                        Operational statuses, berths, cargo progress, and
                        capacity come from the selected replay. Geographic
                        vessel tracks remain illustrative because the simulator
                        does not return positions.
                      </div>
                    </section>
                    <section className="panel impact-panel">
                      <div className="panel-kicker">
                        {replayMode === "baseline"
                          ? "BASELINE REPLAY"
                          : evaluatedOutcome
                            ? "EVALUATED RECOVERY"
                            : "JEV-SELECTED RECOVERY"}
                      </div>
                      <h2>
                        {replayMode === "baseline"
                          ? "Without intervention"
                          : "Recovery plan"}
                      </h2>
                      <p>
                        Server-side Monte Carlo estimate from the same scenario
                        state, seed, and horizon as the displayed replay.
                      </p>
                      <div className="impact-main">
                        <span>Critical cargo on-time</span>
                        <strong>
                          {selectedOutcome.mean.criticalCargoOnTimePercent.toFixed(
                            1,
                          )}
                          <small>%</small>
                        </strong>
                        <div className="impact-track">
                          <span
                            style={{
                              width:
                                selectedOutcome.mean
                                  .criticalCargoOnTimePercent + "%",
                            }}
                          />
                        </div>
                      </div>
                      <div className="impact-facts">
                        <div>
                          <span>Average cargo delay</span>
                          <strong>
                            {selectedOutcome.mean.averageCargoDelayHours.toFixed(
                              1,
                            )}
                            h
                          </strong>
                        </div>
                        <div>
                          <span>Containers at risk</span>
                          <strong>
                            {number(containersAtRisk(selectedOutcome))}
                          </strong>
                        </div>
                        <div>
                          <span>Estimated disruption cost</span>
                          <strong>{outcomeCost(selectedOutcome)}</strong>
                        </div>
                      </div>
                      <p className="impact-disclaimer">
                        <Icon name="info" size={14} /> Simulation estimate ·{" "}
                        {selectedOutcome.runs} runs · seed{" "}
                        {selectedOutcome.seed}
                      </p>
                    </section>
                  </div>

                  <section className="panel decision-panel">
                    <div className="decision-panel__top">
                      <div>
                        <div className="panel-kicker">JEV DECISION HARNESS</div>
                        <h2>
                          {suggestedStrategy?.name ??
                            "No recommendation returned"}
                        </h2>
                        <p>
                          {suggestedStrategy?.summary ??
                            "The recommendation endpoint returned no feasible strategy."}
                        </p>
                      </div>
                      <span
                        className={`decision-source decision-source--${decisionSource ?? "unavailable"}`}
                      >
                        {decisionSource === "jev"
                          ? "Jev recommendation"
                          : decisionSource === "mock"
                            ? "Local mock"
                            : "Deterministic fallback"}
                      </span>
                    </div>
                    <div className="decision-facts">
                      <div>
                        <small>Model</small>
                        <strong>
                          {run.payload.recommendation.jev?.model ??
                            "Not available"}
                        </strong>
                      </div>
                      <div>
                        <small>Jev selection confidence</small>
                        <strong>
                          {run.payload.recommendation.jev
                            ? `${Math.round(run.payload.recommendation.jev.selection.confidence * 100)}%`
                            : "Not returned"}
                        </strong>
                      </div>
                      <div>
                        <small>Critical cargo on-time</small>
                        <strong>
                          {run.payload.recommendation.baselineComparison.selected.mean.criticalCargoOnTimePercent.toFixed(
                            1,
                          )}
                          %
                        </strong>
                      </div>
                      <div>
                        <small>Meeting target likelihood · simulation</small>
                        <strong>
                          {Math.round(
                            run.payload.recommendation
                              .simulatedOutcomeLikelihoods
                              .probabilityOfMeetingTarget * 100,
                          )}
                          %
                        </strong>
                      </div>
                    </div>
                    {run.payload.recommendation.fallbackReason && (
                      <p className="decision-fallback">
                        <Icon name="info" size={14} />
                        {run.payload.recommendation.fallbackReason}
                      </p>
                    )}
                    <div className="decision-panel__meta">
                      <span>
                        <strong>Harness summary:</strong>{" "}
                        {run.payload.recommendation.recommendationSummary}
                      </span>
                      <span>
                        <strong>Affected vessels:</strong>{" "}
                        {run.payload.recommendation.affectedShips.length
                          ? run.payload.recommendation.affectedShips.join(", ")
                          : "No schedule change versus baseline"}
                      </span>
                      <span>
                        <strong>Affected cargo:</strong>{" "}
                        {run.payload.recommendation.affectedCargo.length
                          ? run.payload.recommendation.affectedCargo.join(", ")
                          : "None identified"}
                      </span>
                      <span>
                        <strong>Port and weather inputs:</strong> ports{" "}
                        {run.state.provenance.ports}; ship positions{" "}
                        {run.state.provenance.shipPositions}; vessel/cargo
                        operations {run.state.provenance.shipEtaAndCargo};
                        weather {run.state.provenance.weather}
                      </span>
                    </div>
                    {run.payload.recommendation.jev && (
                      <details className="jev-probabilities">
                        <summary>
                          Jev structured scores and strategy probabilities
                        </summary>
                        <div>
                          Operational risk:{" "}
                          {run.payload.recommendation.jev.operationalRisk.score}
                          /3 · cargo urgency:{" "}
                          {run.payload.recommendation.jev.cargoUrgency.score}/3
                          · human review:{" "}
                          {Math.round(
                            run.payload.recommendation.jev
                              .humanReviewProbability * 100,
                          )}
                          %
                        </div>
                        <ul>
                          {Object.entries(
                            run.payload.recommendation.jev.selection
                              .probabilities,
                          ).map(([strategyId, probability]) => (
                            <li key={strategyId}>
                              {run.payload.availableStrategies.find(
                                (item) => item.id === strategyId,
                              )?.name ?? strategyId}
                              : {Math.round(probability * 100)}%
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <details className="alternative-strategies">
                      <summary>
                        Inspect{" "}
                        {Math.max(
                          0,
                          run.payload.evaluatedStrategies.length - 1,
                        )}{" "}
                        alternative feasible strategies
                      </summary>
                      <div className="alternative-strategy-list">
                        {run.payload.evaluatedStrategies
                          .filter(
                            (item) =>
                              item.strategy.id !==
                              run.payload.recommendation.selectedStrategyId,
                          )
                          .map((item) => (
                            <article
                              key={item.strategy.id}
                              className="alternative-strategy"
                            >
                              <div>
                                <strong>{item.strategy.name}</strong>
                                <p>{item.strategy.summary}</p>
                              </div>
                              <div className="alternative-strategy__metrics">
                                <span>
                                  Critical cargo on-time{" "}
                                  <b>
                                    {item.outcome.mean.criticalCargoOnTimePercent.toFixed(
                                      1,
                                    )}
                                    %
                                  </b>
                                </span>
                                <span>
                                  Average cargo delay{" "}
                                  <b>
                                    {item.outcome.mean.averageCargoDelayHours.toFixed(
                                      1,
                                    )}
                                    h
                                  </b>
                                </span>
                                <span>
                                  Est. disruption cost{" "}
                                  <b>{outcomeCost(item.outcome)}</b>
                                </span>
                                <span>
                                  Meet target probability{" "}
                                  <b>
                                    {Math.round(
                                      item.outcome.probabilityOfMeetingTarget *
                                        100,
                                    )}
                                    %
                                  </b>
                                </span>
                              </div>
                              <small>
                                Affected vessels:{" "}
                                {item.affectedShips.length
                                  ? item.affectedShips.join(", ")
                                  : "No schedule change versus baseline"}
                              </small>
                              <button
                                className="button button--outline button--small"
                                disabled={busy !== null}
                                onClick={() => selectStrategy(item.strategy)}
                              >
                                Select this plan
                              </button>
                            </article>
                          ))}
                      </div>
                    </details>
                  </section>

                  <section className="panel risk-panel">
                    <div>
                      <div className="panel-kicker">RISK ASSESSMENT</div>
                      <h2>Simulation-based likelihoods</h2>
                    </div>
                    {riskOutcome && (
                      <>
                        <div className="risk-panel__metrics">
                          <div>
                            <small>
                              Meet critical cargo target (
                              {riskOutcome.targetCriticalCargoOnTimePercent}%)
                            </small>
                            <strong>
                              {Math.round(
                                riskOutcome.probabilityOfMeetingTarget * 100,
                              )}
                              %
                            </strong>
                          </div>
                          <div>
                            <small>Below target</small>
                            <strong>
                              {Math.round(
                                (1 - riskOutcome.probabilityOfMeetingTarget) *
                                  100,
                              )}
                              %
                            </strong>
                          </div>
                        </div>
                        <p>
                          {riskOutcome.runs} runs · seed {riskOutcome.seed} ·{" "}
                          {riskOutcome.horizonHours} hour horizon. Other
                          probabilities (significant vessel delay, capacity
                          overflow, and cost thresholds) are not calculated by
                          this harness.
                        </p>
                      </>
                    )}
                  </section>

                  <div className="section-title recommendation-heading">
                    <div>
                      <div className="eyebrow">
                        STEP 03 / CHOOSE YOUR RESPONSE
                      </div>
                      <h2>
                        Recovery playbook <span>— your call.</span>
                      </h2>
                      <p>
                        Choose a feasible strategy or combine modeled actions.
                        The server validates and simulates every submitted plan.
                      </p>
                    </div>
                    <span className="recommended-count">
                      <Icon name="sparkle" size={15} />{" "}
                      {Object.values(suggestedActions).filter(Boolean).length}{" "}
                      {decisionSource === "jev"
                        ? "JEV"
                        : decisionSource === "mock"
                          ? "MOCK"
                          : "FALLBACK"}{" "}
                      SUGGESTED ACTIONS
                    </span>
                  </div>
                  <div className="plan-grid">
                    <section className="panel actions-panel">
                      <div className="actions-panel__top">
                        <div className="recommendation-brand">
                          <div className="recommendation-brand__icon">
                            <Icon name="sparkle" size={19} />
                          </div>
                          <div>
                            <strong>Decision support</strong>
                            <span>
                              {decisionSource === "jev"
                                ? "Jev-selected feasible strategy"
                                : decisionSource === "mock"
                                  ? "Explicit local mock response"
                                  : "Deterministic fallback; not a Jev decision"}
                            </span>
                          </div>
                        </div>
                        <button
                          className="link-button"
                          disabled={busy !== null}
                          onClick={() => {
                            setActions({ ...EMPTY_ACTIONS });
                            setSelectedStrategyId(null);
                          }}
                        >
                          Clear selections
                        </button>
                      </div>
                      <div className="action-list">
                        {ACTIONS.map((action) => {
                          const candidate = candidateForAction(action.id);
                          const suggested = suggestedActions[action.id];
                          return (
                            <label
                              key={action.id}
                              className={`action-row ${actions[action.id] ? "action-row--checked" : ""} ${!actionAvailability[action.id] ? "action-row--disabled" : ""}`}
                            >
                              <input
                                type="checkbox"
                                checked={actions[action.id]}
                                disabled={
                                  !actionAvailability[action.id] ||
                                  busy !== null
                                }
                                onChange={(event) => {
                                  setActions((current) =>
                                    toggleAction(
                                      current,
                                      action.id,
                                      event.target.checked,
                                    ),
                                  );
                                  setSelectedStrategyId(null);
                                  setRequestError(null);
                                }}
                              />
                              <span className="custom-checkbox">
                                <Icon name="check" size={14} />
                              </span>
                              <span className="action-row__body">
                                <span className="action-row__title">
                                  <strong>{action.name}</strong>
                                  {suggested && (
                                    <em>
                                      {decisionSource === "jev"
                                        ? "JEV SUGGESTED"
                                        : decisionSource === "mock"
                                          ? "MOCK SUGGESTED"
                                          : "FALLBACK PLAN"}
                                    </em>
                                  )}
                                </span>
                                <span className="action-row__detail">
                                  {candidate?.strategy.summary ??
                                    (run.payload.availableStrategies.length
                                      ? "No feasible candidate supports this action in the current scenario."
                                      : action.detail)}
                                </span>
                                <small>
                                  {candidate
                                    ? `Feasible candidate outcome: ${candidate.outcome.mean.criticalCargoOnTimePercent.toFixed(1)}% critical cargo on-time · ${candidate.outcome.mean.averageCargoDelayHours.toFixed(1)}h average delay · ${outcomeCost(candidate.outcome)}`
                                    : action.benefit}
                                </small>
                                <small>
                                  Affected vessels:{" "}
                                  {candidate?.affectedShips.length
                                    ? candidate.affectedShips.join(", ")
                                    : candidate
                                      ? "No schedule change versus baseline"
                                      : "Unavailable in current port model"}
                                </small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="actions-panel__footer">
                        <span>
                          {selectedActionsCount} of 4 actions selected{" "}
                          <small>
                            {pendingChanges
                              ? "· Not evaluated"
                              : "· Evaluated plan"}
                          </small>
                        </span>
                        <div>
                          <button
                            className="button button--outline button--small"
                            disabled={busy !== null || !suggestedStrategy}
                            onClick={() =>
                              suggestedStrategy &&
                              selectStrategy(suggestedStrategy)
                            }
                          >
                            <Icon name="sparkle" size={15} /> Try suggested plan
                          </button>
                          <button
                            className="button button--primary button--small"
                            disabled={busy !== null}
                            onClick={() => void evaluatePlan()}
                          >
                            <Icon name="play" size={14} />
                            {busy === "evaluation"
                              ? "Evaluating…"
                              : "Evaluate my plan"}
                          </button>
                        </div>
                      </div>
                    </section>
                    <section className="panel compare-panel">
                      <div className="compare-panel__heading">
                        <div className="panel-kicker">
                          SIDE-BY-SIDE OUTCOMES
                        </div>
                        <h2>Does your plan help?</h2>
                        <p>
                          {pendingChanges
                            ? "Selection changed. Submit to update saved results."
                            : evaluationCount
                              ? `Plan ${evaluationCount} evaluated · same scenario, seed, and horizon.`
                              : "Comparing the Jev-selected recovery against baseline; switch the replay above to inspect each timeline."}
                        </p>
                      </div>
                      <div className="compare-labels">
                        <span>NO INTERVENTION</span>
                        <span>RECOVERY PLAN</span>
                      </div>
                      <div className="comparison-cards">
                        <div className="comparison-half">
                          <ResultStat
                            name="Critical cargo on-time"
                            value={`${baseline.mean.criticalCargoOnTimePercent.toFixed(1)}%`}
                          />
                          <ResultStat
                            name="Average cargo delay"
                            value={`${baseline.mean.averageCargoDelayHours.toFixed(1)}h`}
                          />
                          <ResultStat
                            name="Containers at risk"
                            value={number(containersAtRisk(baseline))}
                            sub="not processed by the horizon"
                          />
                          <ResultStat
                            name="Estimated disruption cost"
                            value={outcomeCost(baseline)}
                          />
                        </div>
                        <div className="comparison-half comparison-half--enhanced">
                          <ResultStat
                            name="Critical cargo on-time"
                            value={`${currentOutcome.mean.criticalCargoOnTimePercent.toFixed(1)}%`}
                            accent
                          />
                          <Delta
                            before={baseline.mean.criticalCargoOnTimePercent}
                            after={
                              currentOutcome.mean.criticalCargoOnTimePercent
                            }
                            suffix=" pp"
                          />
                          <ResultStat
                            name="Average cargo delay"
                            value={`${currentOutcome.mean.averageCargoDelayHours.toFixed(1)}h`}
                            accent
                          />
                          <Delta
                            before={baseline.mean.averageCargoDelayHours}
                            after={currentOutcome.mean.averageCargoDelayHours}
                            suffix="h"
                            invert
                          />
                          <ResultStat
                            name="Containers at risk"
                            value={number(containersAtRisk(currentOutcome))}
                            sub="not processed by the horizon"
                            accent
                          />
                          <Delta
                            before={containersAtRisk(baseline)}
                            after={containersAtRisk(currentOutcome)}
                            suffix=" containers"
                            invert
                          />
                          <ResultStat
                            name="Estimated disruption cost"
                            value={outcomeCost(currentOutcome)}
                            accent
                          />
                          {baseline.mean.estimatedDelayCost !== null &&
                            currentOutcome.mean.estimatedDelayCost !== null && (
                              <Delta
                                before={baseline.mean.estimatedDelayCost}
                                after={currentOutcome.mean.estimatedDelayCost}
                                prefix="$"
                                invert
                              />
                            )}
                        </div>
                      </div>
                      <div className="compare-bottom">
                        <span>
                          <Icon name="info" size={14} /> Server simulation
                          outputs · {run.state.provenance.ports} port data ·{" "}
                          {run.state.provenance.weather} weather
                        </span>
                        <button
                          disabled={!history.length || busy !== null}
                          onClick={undoPlan}
                        >
                          <Icon name="back" size={15} /> Undo last plan{" "}
                          {history.length ? `(${history.length})` : ""}
                        </button>
                      </div>
                    </section>
                  </div>
                  {pendingChanges && (
                    <div className="pending-preview">
                      <Icon name="info" size={17} />
                      <div>
                        <strong>Plan not yet evaluated</strong>
                        <span>
                          Submit the selected combination to validate
                          feasibility and calculate outcomes with the same seed
                          and horizon.
                        </span>
                      </div>
                      <button
                        disabled={busy !== null}
                        onClick={() => void evaluatePlan()}
                      >
                        Evaluate changes <Icon name="arrow" size={16} />
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="panel scenario-loading">
                  <span className="map-loading__spinner" />
                  Preparing scenario results…
                </div>
              )}
              <footer className="content-footer">
                <span>HARBORMIND · WHAT-IF SANDBOX</span>
                <span>
                  {run
                    ? `Decision source: ${decisionSource} · simulation results, not validated forecasts`
                    : "Server-side Jev harness · not a live operational control"}
                </span>
              </footer>
            </main>
          )}

          {tab === "about" && (
            <main className="content-area about-area">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ABOUT / THE PROJECT</div>
                  <h1>
                    Intelligence for the <br />
                    unpredictable<span className="heading-fullstop">.</span>
                  </h1>
                  <p>Maritime resilience starts before the next disruption.</p>
                </div>
                <span className="about-iteration">
                  USC 2026 DUAL-USE HACKATHON MVP
                </span>
              </div>
              <div className="about-hero panel">
                <div>
                  <span className="eyebrow">THE MISSION</span>
                  <h2>
                    When the unexpected hits,
                    <br />
                    <em>critical cargo keeps moving.</em>
                  </h2>
                  <p>
                    HarborMind is a digital twin-style platform that models
                    ports, vessels, cargo, and disruptions. Instead of only
                    predicting problems, it lets operators test how responses
                    could affect essential shipments before committing scarce
                    port capacity.
                  </p>
                  <button
                    className="button button--primary"
                    onClick={() => jump("simulations")}
                  >
                    Explore the scenario lab <Icon name="arrow" size={17} />
                  </button>
                </div>
                <div className="about-hero-art" aria-hidden="true">
                  <div className="about-radar">
                    <div className="radar-arc radar-arc--1" />
                    <div className="radar-arc radar-arc--2" />
                    <div className="radar-arc radar-arc--3" />
                    <Icon name="ship" size={68} strokeWidth={1.1} />
                    <span className="radar-point radar-point--a" />
                    <span className="radar-point radar-point--b" />
                    <span className="radar-point radar-point--c" />
                  </div>
                </div>
              </div>
              <div className="about-section-heading">
                <span className="eyebrow">HOW IT WORKS</span>
                <h2>Three layers. One clearer decision.</h2>
              </div>
              <div className="architecture-grid">
                <div className="architecture-card panel">
                  <span className="architecture-icon">
                    <Icon name="layers" size={24} />
                  </span>
                  <small>01 / ENVIRONMENT</small>
                  <h3>Port digital twin</h3>
                  <p>
                    Models port throughput, docking slots, vessels, cargo
                    urgency, ETAs, and synthetic disruptions.
                  </p>
                  <span className="architecture-tags">
                    <em>Ships + berths</em>
                    <em>Cargo deadlines</em>
                    <em>Weather zones</em>
                  </span>
                </div>
                <div className="architecture-card panel">
                  <span className="architecture-icon architecture-icon--teal">
                    <Icon name="sparkle" size={24} />
                  </span>
                  <small>02 / REASONING</small>
                  <h3>Jev decision harness</h3>
                  <p>
                    The server-side TypeSafe Jev harness selects among recovery
                    plans evaluated by the Monte Carlo simulator.
                  </p>
                  <span className="architecture-tags">
                    <em>Prioritization</em>
                    <em>Tradeoffs</em>
                    <em>Explainability</em>
                  </span>
                </div>
                <div className="architecture-card panel">
                  <span className="architecture-icon architecture-icon--amber">
                    <Icon name="grid" size={24} />
                  </span>
                  <small>03 / EXPERIENCE</small>
                  <h3>Interactive scenario lab</h3>
                  <p>
                    A map-first workspace to test storms and outages, inspect
                    recommendations, and compare user-defined plans.
                  </p>
                  <span className="architecture-tags">
                    <em>Next.js</em>
                    <em>Three.js</em>
                    <em>What-if testing</em>
                  </span>
                </div>
              </div>
              <div className="about-bottom-grid">
                <div className="panel tech-panel">
                  <div className="panel-kicker">TECHNOLOGY</div>
                  <h2>Built for iteration.</h2>
                  <div className="tech-rows">
                    <div>
                      <span>
                        <Icon name="grid" size={18} /> Frontend
                      </span>
                      <strong>Next.js · App Router · React · CSS</strong>
                    </div>
                    <div>
                      <span>
                        <Icon name="globe" size={18} /> 3D visualization
                      </span>
                      <strong>Three.js · WebGL</strong>
                    </div>
                    <div>
                      <span>
                        <Icon name="layers" size={18} /> Services
                      </span>
                      <strong>
                        Next.js API routes · seeded simulation harness
                      </strong>
                    </div>
                    <div>
                      <span>
                        <Icon name="sparkle" size={18} /> AI decisioning
                      </span>
                      <strong>Jev by TypeSafe · server API key required</strong>
                    </div>
                    <div>
                      <span>
                        <Icon name="wind" size={18} /> External data
                      </span>
                      <strong>
                        Open-Meteo forecast API · AISStream route available
                      </strong>
                    </div>
                  </div>
                </div>
                <div className="panel roadmap-panel">
                  <div className="panel-kicker">IMPLEMENTATION STATUS</div>
                  <h2>From prototype to platform.</h2>
                  <div className="roadmap-item">
                    <span className="roadmap-item__done">
                      <Icon name="check" size={15} />
                    </span>
                    <div>
                      <strong>Interactive frontend baseline</strong>
                      <p>3D map, routes, scenarios, reversible decisions.</p>
                    </div>
                    <span>IN DEMO</span>
                  </div>
                  <div className="roadmap-item">
                    <span className="roadmap-item__done">
                      <Icon name="check" size={15} />
                    </span>
                    <div>
                      <strong>Scenario simulation harness</strong>
                      <p>
                        Seeded Monte Carlo outcomes and feasible recovery plan
                        validation.
                      </p>
                    </div>
                    <span>IN DEMO</span>
                  </div>
                  <div className="roadmap-item">
                    <span className="roadmap-item__todo">3</span>
                    <div>
                      <strong>Connect live vessel and terminal feeds</strong>
                      <p>
                        Live AIS positions, cargo manifests, and terminal
                        operations.
                      </p>
                    </div>
                    <span>PLANNED</span>
                  </div>
                </div>
              </div>
              <div className="about-footer-note">
                <Icon name="shield" size={16} /> Port and cargo inputs are
                synthetic. Scenario recommendations identify Jev, local mock, or
                deterministic fallback results; simulation estimates are not
                validated forecasts.
              </div>
              <footer className="content-footer">
                <span>HARBORMIND · RESILIENCE BY DESIGN</span>
                <span>Keep what matters moving.</span>
              </footer>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
