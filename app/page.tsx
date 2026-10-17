"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import PortMap3D, { type MapCommand } from "./components/PortMap3D";
import { ACTIONS, EMPTY_ACTIONS, RECOMMENDED_ACTIONS, SCENARIOS, SHIPS, estimateOutcome, type ActionId, type ActionState, type Outcome, type ScenarioId, type Tab } from "./lib/data";
import { Icon } from "./lib/icons";

const DAY_MONTH: Intl.DateTimeFormatOptions = { month: "short", day: "2-digit" };
const number = (value: number) => value.toLocaleString("en-US");
const isSamePlan = (a: ActionState, b: ActionState) => (Object.keys(a) as ActionId[]).every((key) => a[key] === b[key]);

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

function SeverityIndicator({ level }: { level: "HIGH" | "MODERATE" | "LOW" }) {
  return <span className={`severity severity--${level.toLowerCase()}`}><span/>{level} RISK</span>;
}

function ResultStat({ name, value, sub, accent = false }: { name: string; value: string; sub?: string; accent?: boolean }) {
  return <div className={`result-stat ${accent ? "result-stat--accent" : ""}`}><div>{name}</div><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}

function Delta({ before, after, suffix = "%", invert = false }: { before: number; after: number; suffix?: string; invert?: boolean }) {
  const diff = after - before;
  const good = invert ? diff < 0 : diff > 0;
  return <span className={`outcome-delta ${diff === 0 ? "outcome-delta--flat" : good ? "outcome-delta--good" : "outcome-delta--bad"}`}>{diff > 0 ? "+" : ""}{Number.isInteger(diff) ? diff : diff.toFixed(1)}{suffix} vs. baseline</span>;
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedShip, setSelectedShip] = useState("PM-104");
  const [mapCommand, setMapCommand] = useState<MapCommand>({ kind: "reset", nonce: 0 });
  const [now, setNow] = useState<Date | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scenarioId, setScenarioId] = useState<ScenarioId>("storm");
  const [capacityLoss, setCapacityLoss] = useState(60);
  const [duration, setDuration] = useState(12);
  const [ran, setRan] = useState(false);
  const [actions, setActions] = useState<ActionState>({ ...EMPTY_ACTIONS });
  const [evaluatedActions, setEvaluatedActions] = useState<ActionState>({ ...EMPTY_ACTIONS });
  const [history, setHistory] = useState<ActionState[]>([]);
  const [evaluationCount, setEvaluationCount] = useState(0);
  const [simulationHour, setSimulationHour] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ran || !playing) return;
    const timer = window.setInterval(() => setSimulationHour((hour) => {
      if (hour >= duration) { setPlaying(false); return hour; }
      return Math.min(duration, hour + 1);
    }), 900);
    return () => window.clearInterval(timer);
  }, [ran, playing, duration]);

  const selected = SHIPS.find((ship) => ship.id === selectedShip) ?? SHIPS[0];
  const scenario = SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0];
  const baseline = useMemo(() => estimateOutcome(scenarioId, capacityLoss, duration, EMPTY_ACTIONS), [scenarioId, capacityLoss, duration]);
  const evaluated = useMemo(() => estimateOutcome(scenarioId, capacityLoss, duration, evaluatedActions), [scenarioId, capacityLoss, duration, evaluatedActions]);
  const preview = useMemo(() => estimateOutcome(scenarioId, capacityLoss, duration, actions), [scenarioId, capacityLoss, duration, actions]);
  const pendingChanges = !isSamePlan(actions, evaluatedActions);
  const selectedActionsCount = Object.values(actions).filter(Boolean).length;

  const issueMapCommand = (kind: MapCommand["kind"], shipId?: string) => setMapCommand({ kind, shipId, nonce: Date.now() + Math.random() });
  const jump = (destination: Tab) => { setTab(destination); setMobileMenu(false); issueMapCommand("reset"); };
  const chooseScenario = (id: ScenarioId) => {
    const item = SCENARIOS.find((scenario) => scenario.id === id)!;
    setScenarioId(id);
    setCapacityLoss(item.intensity);
    setActions({ ...EMPTY_ACTIONS });
    setEvaluatedActions({ ...EMPTY_ACTIONS });
    setEvaluationCount(0);
    setHistory([]);
    setPlaying(false);
    setSimulationHour(0);
  };
  const runScenario = () => {
    setRan(true);
    setActions({ ...EMPTY_ACTIONS });
    setEvaluatedActions({ ...EMPTY_ACTIONS });
    setEvaluationCount(0);
    setHistory([]);
    setSimulationHour(0);
    setPlaying(false);
    issueMapCommand("reset");
  };
  const evaluatePlan = (plan = actions) => {
    setHistory((previous) => [...previous, { ...evaluatedActions }]);
    setActions({ ...plan });
    setEvaluatedActions({ ...plan });
    setEvaluationCount((count) => count + 1);
  };
  const undoPlan = () => {
    if (!history.length) return;
    const previous = history[history.length - 1];
    setHistory((current) => current.slice(0, -1));
    setActions({ ...previous });
    setEvaluatedActions({ ...previous });
    setEvaluationCount((count) => Math.max(0, count - 1));
  };
  const goBackToSetup = () => {
    setRan(false);
    setActions({ ...EMPTY_ACTIONS });
    setEvaluatedActions({ ...EMPTY_ACTIONS });
    setHistory([]);
    setEvaluationCount(0);
    setSimulationHour(0);
    setPlaying(false);
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
          <div className="page-heading"><div><div className="eyebrow">DISRUPTION PLANNING / WHAT-IF ENGINE</div><h1>Scenario lab<span className="heading-fullstop">.</span></h1><p>Stress-test port operations. Compare tradeoffs. Keep essential cargo moving.</p></div><span className="scenario-demo-pill"><Icon name="sparkle" size={15}/> JEV-READY · MOCK DECISIONS</span></div>
          <div className="scenario-steps"><div className="scenario-step is-done"><span>01</span> Configure disruption</div><Icon name="chevron" size={15}/><div className={`scenario-step ${ran ? "is-done" : ""}`}><span>02</span> Run simulation</div><Icon name="chevron" size={15}/><div className={`scenario-step ${ran ? "is-done" : ""}`}><span>03</span> Explore recovery plan</div></div>
          {!ran ? <>
            <div className="section-title"><div><div className="eyebrow">STEP 01 / SELECT A DISRUPTION</div><h2>What should we simulate?</h2></div><span>Choose one of four modeled conditions</span></div>
            <div className="scenario-options">{SCENARIOS.map((item) => <button key={item.id} onClick={() => chooseScenario(item.id)} className={`scenario-option ${scenarioId === item.id ? "scenario-option--selected" : ""}`}><span className={`scenario-option__icon scenario-option__icon--${item.icon}`}><Icon name={item.icon} size={24}/></span><span className="scenario-option__heading"><strong>{item.label}</strong>{scenarioId === item.id && <span className="scenario-selected-check"><Icon name="check" size={13}/></span>}</span><span className="scenario-option__kicker">{item.kicker}</span><span className="scenario-option__desc">{item.description}</span><span className="scenario-option__impact"><Icon name="alert" size={14}/> {item.impact}</span></button>)}</div>
            <div className="scenario-config-grid"><section className="panel config-panel"><div className="panel-kicker">STEP 02 / CONFIGURE</div><h2>Disruption parameters</h2><p>Adjust the severity and estimated duration to model different outcomes.</p><div className="slider-heading"><label htmlFor="capacity-slider">Effective capacity reduction</label><strong>{capacityLoss}%</strong></div><input id="capacity-slider" className="range-slider" type="range" min="10" max="90" step="5" value={capacityLoss} style={{ "--slider-progress": `${((capacityLoss - 10) / 80) * 100}%` } as CSSProperties} onChange={(event) => setCapacityLoss(Number(event.target.value))}/><div className="range-labels"><span>10% / Mild</span><span>90% / Severe</span></div><label className="duration-label" htmlFor="duration-select">Disruption duration</label><div className="select-wrap"><select id="duration-select" value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value="6">6 hours</option><option value="12">12 hours</option><option value="18">18 hours</option><option value="24">24 hours</option><option value="36">36 hours</option></select><Icon name="chevron" size={17}/></div><div className="config-note"><Icon name="info" size={16}/> All outcomes are deterministic examples using synthetic data. Live simulation engine and Jev API integration are future connection points.</div><button className="button button--primary run-button" onClick={runScenario}><Icon name="play" size={17}/> Run simulation <Icon name="arrow" size={17}/></button></section>
              <section className="panel preview-panel"><div className="panel-top"><div><div className="panel-kicker">SCENARIO PREVIEW</div><h2>Potential area of impact</h2></div><span className="tiny-outline">3D DIGITAL TWIN</span></div><div className="scenario-preview-map"><PortMap3D selectedShip={selectedShip} onSelectShip={setSelectedShip} weather={scenario.zone} scenarioId={scenarioId} simulated compact command={mapCommand}/><span className="map-tag preview-map-tag"><Icon name={scenario.icon} size={13}/> {scenario.label.toUpperCase()}</span><MapToolbox onCommand={issueMapCommand}/></div><div className="preview-panel__foot"><span><i className="impact-indicator" style={{ background: scenario.zone.color }}/> Disruption footprint</span><span><i className="legend-line"/> Synthetic shipping routes</span></div></section></div>
          </> : <>
            <div className="simulation-toolbar"><div><button className="text-back" onClick={goBackToSetup}><Icon name="back" size={17}/> Edit scenario</button><h2>{scenario.label} <span>simulation</span></h2><div className="simulation-subtitle"><span className="live-dot live-dot--amber"/> DISRUPTION INJECTED <b>·</b> {capacityLoss}% CAPACITY LOSS <b>·</b> {duration}H DURATION</div></div><button className="button button--outline" onClick={goBackToSetup}><Icon name="reset" size={15}/> Reset scenario</button></div>
            <div className="running-map-grid"><section className="panel running-map-panel"><div className="panel-top"><div><div className="panel-kicker">SIMULATED PORT OPERATIONS</div><h2>Disruption footprint</h2></div><span className="active-scenario-badge"><span/> SIMULATION MODE</span></div><div className="running-map-stage"><PortMap3D selectedShip={selectedShip} onSelectShip={setSelectedShip} weather={scenario.zone} simulated scenarioId={scenarioId} simulationHour={simulationHour} compact command={mapCommand}/><div className="map-top-left"><span className="map-tag"><Icon name={scenario.icon} size={13}/> {scenario.label.toUpperCase()}</span><div className="map-coords">MODELED EVENT · NOT LIVE WEATHER</div></div><MapToolbox onCommand={issueMapCommand}/></div><div className="sim-timeline"><button title={playing ? "Pause replay" : "Play replay"} aria-label={playing ? "Pause replay" : "Play replay"} onClick={() => { if (simulationHour >= duration) setSimulationHour(0); setPlaying(!playing); }}><Icon name={playing ? "pause" : "play"} size={15}/></button><button title="Go back one hour" aria-label="Go back one hour" onClick={() => {setPlaying(false);setSimulationHour(Math.max(0,simulationHour - 1));}}><Icon name="back" size={15}/></button><span className="sim-timeline__start">T+0H</span><input aria-label="Simulation timeline" type="range" min="0" max={duration} step="1" value={simulationHour} onChange={(event) => {setPlaying(false);setSimulationHour(Number(event.target.value));}}/><span className="sim-timeline__end">T+{duration}H</span><strong>T+{simulationHour}H</strong></div></section>
              <section className="panel impact-panel"><div className="panel-kicker">INITIAL IMPACT ASSESSMENT</div><h2>Without intervention</h2><p>Illustrative baseline: first-in, first-out scheduling with reduced capacity.</p><div className="impact-main"><span>Critical cargo on-time</span><strong>{baseline.criticalOnTime}<small>%</small></strong><div className="impact-track"><span style={{ width: `${baseline.criticalOnTime}%` }}/></div></div><div className="impact-facts"><div><span>Average delay</span><strong>{baseline.averageDelay}h</strong></div><div><span>Containers at risk</span><strong>{number(baseline.cargoAtRisk)}</strong></div><div><span>Estimated disruption cost</span><strong>${baseline.operatingCost}k</strong></div></div><p className="impact-disclaimer"><Icon name="info" size={14}/> Demo projections, not validated forecasts.</p></section></div>
            <div className="section-title recommendation-heading"><div><div className="eyebrow">STEP 03 / CHOOSE YOUR RESPONSE</div><h2>Recovery playbook <span>— your call.</span></h2><p>Review example recommendations or build your own plan. Nothing is applied automatically.</p></div><span className="recommended-count"><Icon name="sparkle" size={15}/> 3 SUGGESTED ACTIONS</span></div>
            <div className="plan-grid"><section className="panel actions-panel"><div className="actions-panel__top"><div className="recommendation-brand"><div className="recommendation-brand__icon"><Icon name="sparkle" size={19}/></div><div><strong>Decision support</strong><span>Mock Jev-style recommendations</span></div></div><button className="link-button" onClick={() => setActions({ ...EMPTY_ACTIONS })}>Clear selections</button></div><div className="action-list">{ACTIONS.map((action) => <label key={action.id} className={`action-row ${actions[action.id] ? "action-row--checked" : ""}`}><input type="checkbox" checked={actions[action.id]} onChange={(event) => setActions((current) => ({ ...current, [action.id]: event.target.checked }))}/><span className="custom-checkbox"><Icon name="check" size={14}/></span><span className="action-row__body"><span className="action-row__title"><strong>{action.name}</strong>{action.recommended && <em>RECOMMENDED</em>}</span><span className="action-row__detail">{action.detail}</span><small>{action.benefit}</small></span></label>)}</div><div className="actions-panel__footer"><span>{selectedActionsCount} of 4 actions selected <small>{pendingChanges ? "· Not evaluated" : "· Evaluated plan"}</small></span><div><button className="button button--outline button--small" onClick={() => evaluatePlan({ ...RECOMMENDED_ACTIONS })}><Icon name="sparkle" size={15}/> Try suggested plan</button><button className="button button--primary button--small" onClick={() => evaluatePlan()}><Icon name="play" size={14}/> Evaluate my plan</button></div></div></section>
              <section className="panel compare-panel"><div className="compare-panel__heading"><div className="panel-kicker">SIDE-BY-SIDE OUTCOMES</div><h2>Does your plan help?</h2><p>{pendingChanges ? "Selection changed. Evaluate to update saved results." : evaluationCount ? `Plan ${evaluationCount} evaluated · compare to baseline.` : "No action applied yet. Evaluate a plan to see the difference."}</p></div><div className="compare-labels"><span>NO INTERVENTION</span><span>YOUR LAST EVALUATED PLAN</span></div><div className="comparison-cards"><div className="comparison-half"><ResultStat name="Critical cargo on-time" value={`${baseline.criticalOnTime}%`}/><ResultStat name="Average shipment delay" value={`${baseline.averageDelay}h`}/><ResultStat name="Disruption cost" value={`$${baseline.operatingCost}k`}/></div><div className="comparison-half comparison-half--enhanced"><ResultStat name="Critical cargo on-time" value={`${evaluated.criticalOnTime}%`} accent/><Delta before={baseline.criticalOnTime} after={evaluated.criticalOnTime}/><ResultStat name="Average shipment delay" value={`${evaluated.averageDelay}h`} accent/><Delta before={baseline.averageDelay} after={evaluated.averageDelay} suffix="h" invert/><ResultStat name="Disruption cost" value={`$${evaluated.operatingCost}k`} accent/><Delta before={baseline.operatingCost} after={evaluated.operatingCost} suffix="k" invert/></div></div><div className="compare-bottom"><span><Icon name="info" size={14}/> Estimates use a local illustrative scoring model.</span><button disabled={!history.length} onClick={undoPlan}><Icon name="back" size={15}/> Undo last plan {history.length ? `(${history.length})` : ""}</button></div></section></div>
            {pendingChanges && <div className="pending-preview"><Icon name="trend" size={17}/><div><strong>Uncommitted plan preview</strong><span>With current selections: {preview.criticalOnTime}% estimated critical cargo on-time, {preview.averageDelay}h average delay.</span></div><button onClick={() => evaluatePlan()}>Evaluate changes <Icon name="arrow" size={16}/></button></div>}
          </>}
          <footer className="content-footer"><span>HARBORMIND · WHAT-IF SANDBOX</span><span>Not connected to live Jev or port operations</span></footer>
        </main>}

        {tab === "about" && <main className="content-area about-area"><div className="page-heading"><div><div className="eyebrow">ABOUT / THE PROJECT</div><h1>Intelligence for the <br/>unpredictable<span className="heading-fullstop">.</span></h1><p>Maritime resilience starts before the next disruption.</p></div><span className="about-iteration">HACKATHON MVP <span>·</span> CONCEPT 01</span></div><div className="about-hero panel"><div><span className="eyebrow">THE MISSION</span><h2>When the unexpected hits,<br/><em>critical cargo keeps moving.</em></h2><p>HarborMind is a digital twin-style platform that models ports, vessels, cargo, and disruptions. Instead of only predicting problems, it lets operators test how responses could affect essential shipments before committing scarce port capacity.</p><button className="button button--primary" onClick={() => jump("simulations")}>Explore the scenario lab <Icon name="arrow" size={17}/></button></div><div className="about-hero-art" aria-hidden="true"><div className="about-radar"><div className="radar-arc radar-arc--1"/><div className="radar-arc radar-arc--2"/><div className="radar-arc radar-arc--3"/><Icon name="ship" size={68} strokeWidth={1.1}/><span className="radar-point radar-point--a"/><span className="radar-point radar-point--b"/><span className="radar-point radar-point--c"/></div></div></div><div className="about-section-heading"><span className="eyebrow">HOW IT WORKS</span><h2>Three layers. One clearer decision.</h2></div><div className="architecture-grid"><div className="architecture-card panel"><span className="architecture-icon"><Icon name="layers" size={24}/></span><small>01 / ENVIRONMENT</small><h3>Port digital twin</h3><p>Models port throughput, docking slots, vessels, cargo urgency, ETAs, and synthetic disruptions.</p><span className="architecture-tags"><em>Ships + berths</em><em>Cargo deadlines</em><em>Weather zones</em></span></div><div className="architecture-card panel"><span className="architecture-icon architecture-icon--teal"><Icon name="sparkle" size={24}/></span><small>02 / REASONING</small><h3>Jev decision harness</h3><p>Planned Dockerized Jev service compares potential actions against deterministic simulation and optimization results.</p><span className="architecture-tags"><em>Prioritization</em><em>Tradeoffs</em><em>Explainability</em></span></div><div className="architecture-card panel"><span className="architecture-icon architecture-icon--amber"><Icon name="grid" size={24}/></span><small>03 / EXPERIENCE</small><h3>Interactive scenario lab</h3><p>A map-first workspace to test storms and outages, inspect recommendations, and compare user-defined plans.</p><span className="architecture-tags"><em>Next.js</em><em>Three.js</em><em>What-if testing</em></span></div></div><div className="about-bottom-grid"><div className="panel tech-panel"><div className="panel-kicker">TECHNOLOGY</div><h2>Built for iteration.</h2><div className="tech-rows"><div><span><Icon name="grid" size={18}/> Frontend</span><strong>Next.js · App Router · React · CSS</strong></div><div><span><Icon name="globe" size={18}/> 3D visualization</span><strong>Three.js · WebGL</strong></div><div><span><Icon name="layers" size={18}/> Services</span><strong>Docker · Next.js · planned simulation API</strong></div><div><span><Icon name="sparkle" size={18}/> AI decisioning</span><strong>Jev by TypeSafe (integration planned)</strong></div><div><span><Icon name="wind" size={18}/> External data</span><strong>Open-Meteo / MyShipTracking (planned)</strong></div></div></div><div className="panel roadmap-panel"><div className="panel-kicker">IMPLEMENTATION STATUS</div><h2>From prototype to platform.</h2><div className="roadmap-item"><span className="roadmap-item__done"><Icon name="check" size={15}/></span><div><strong>Interactive frontend baseline</strong><p>3D map, routes, scenarios, reversible decisions.</p></div><span>IN DEMO</span></div><div className="roadmap-item"><span className="roadmap-item__todo">2</span><div><strong>Deterministic port simulator</strong><p>Actual berths, resource constraints, vessel timelines.</p></div><span>PLANNED</span></div><div className="roadmap-item"><span className="roadmap-item__todo">3</span><div><strong>Connect Jev + live feeds</strong><p>Decisions, rationale, tracked vessels, forecasts.</p></div><span>PLANNED</span></div></div></div><div className="about-footer-note"><Icon name="shield" size={16}/> This is a demonstration UI. Its ports, ship tracks, operating metrics, scoring model, and recommendation explanations are synthetic—not actual Jev responses or forecasts.</div><footer className="content-footer"><span>HARBORMIND · RESILIENCE BY DESIGN</span><span>Keep what matters moving.</span></footer></main>}
      </div>
    </div>
  </div>;
}
