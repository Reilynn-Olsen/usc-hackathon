"use client";

import type { CargoPriority, RecoveryPlan, RecoveryStrategy, SimulationState, SimulationSummary } from "../../lib/harbormind/types.ts";

type EvaluatedStrategy = { strategy: RecoveryStrategy; outcome: SimulationSummary; affectedShips: string[]; affectedCargo: string[] };
type Props = {
  state: SimulationState;
  horizonHours: number;
  recommended: RecoveryStrategy;
  decisionSource: "jev" | "mock" | "fallback";
  evaluatedStrategies: EvaluatedStrategy[];
  draft: RecoveryPlan | null;
  evaluated: RecoveryPlan | null;
  pending: boolean;
  busy: boolean;
  onLoad: (strategy: RecoveryStrategy) => void;
  onChange: (plan: RecoveryPlan) => void;
  onClear: () => void;
  onEvaluate: () => void;
};

const cost = (summary: SimulationSummary) => summary.mean.estimatedDisruptionCost === null ? "Unavailable" : `$${Math.round(summary.mean.estimatedDisruptionCost).toLocaleString("en-US")}`;
const objectiveLabel = (objective: RecoveryPlan["objective"]) => ({ "critical-delivery": "Maximize critical cargo on time", "minimize-delay": "Minimize average container delay", "minimize-cost": "Minimize disruption cost", balanced: "Balanced recovery" })[objective];

function planDescription(plan: RecoveryPlan, state: SimulationState, strategy?: RecoveryStrategy): string[] {
  const portName = (portId: string) => state.ports.find((port) => port.portId === portId)?.location.name ?? portId;
  const cargoOwner = (cargoId: string) => state.ships.find((ship) => ship.cargo.some((cargo) => cargo.cargoId === cargoId))?.vesselId;
  return [
    `Scheduling: ${plan.scheduling.replaceAll("-", " ")}`,
    ...(strategy?.actions.filter((action) => action.type === "schedule").map((action, index) => `${index + 1}. ${action.vesselId} → ${portName(action.portId)}`) ?? []),
    ...Object.entries(plan.stagingWindowsByVessel).map(([id, window]) => `Stage ${id} from T+${window.startHour}h for ${window.durationHours}h`),
    ...Object.entries(plan.cargoPrioritiesByBatch).map(([id, priority]) => `Cargo batch ${id}${cargoOwner(id) ? ` on ${cargoOwner(id)}` : ""}: priority ${priority}/3`),
    ...(plan.reserveBerthForCriticalCargo ? ["Reserve one available berth for a vessel with critical cargo"] : []),
    ...(plan.criticalCapacityReservation ? [`Reserve ${plan.criticalCapacityReservation.percent}% critical throughput from T+${plan.criticalCapacityReservation.startHour}h to T+${plan.criticalCapacityReservation.endHour}h`] : []),
    ...state.ships.filter((ship) => plan.assignments[ship.vesselId] !== ship.destinationPortId).map((ship) => `Route ${ship.vesselId} to ${portName(plan.assignments[ship.vesselId])}`),
  ];
}

function alternativeReason(candidate: EvaluatedStrategy, recommended: EvaluatedStrategy | undefined): string {
  if (!recommended) return "Compare its measured outcome under the current objective.";
  if (candidate.outcome.mean.criticalCargoOnTimePercent > recommended.outcome.mean.criticalCargoOnTimePercent) return "Consider when critical delivery matters more than the current plan's trade-off.";
  if (candidate.outcome.mean.averageCargoDelayHours < recommended.outcome.mean.averageCargoDelayHours) return "Consider when lower average container delay is the main priority.";
  const candidateCost = candidate.outcome.mean.estimatedDisruptionCost;
  const recommendedCost = recommended.outcome.mean.estimatedDisruptionCost;
  if (candidateCost !== null && recommendedCost !== null && candidateCost < recommendedCost) return "Consider when minimizing modeled disruption cost matters most.";
  return "A different feasible operational plan; compare its measured effects before selecting it.";
}

export default function RecoveryPlanner({ state, horizonHours, recommended, decisionSource, evaluatedStrategies, draft, evaluated, pending, busy, onLoad, onChange, onClear, onEvaluate }: Props) {
  const recommendedCandidate = evaluatedStrategies.find((item) => item.strategy.id === recommended.id);
  const selectedPlan = draft;
  const portsFor = (shipId: string) => {
    const ship = state.ships.find((item) => item.vesselId === shipId)!;
    return state.ports.filter((port) => {
      if (port.portId === ship.destinationPortId) return true;
      if (ship.cargo.some((cargo) => cargo.essential) || !ship.eligibleAlternativePortIds.includes(port.portId)
        || port.currentCapacityContainersPerDay <= 0 || port.availableBerths < 1 || port.unloadingResources < 1) return false;
      const assignedShips = state.ships.filter((item) => (item.vesselId === shipId ? port.portId : selectedPlan!.assignments[item.vesselId] ?? item.destinationPortId) === port.portId);
      return assignedShips.every((item) => item.cargo.every((cargo) => cargo.specialHandling.every((need) => port.supportedHandling.includes(need))))
        && assignedShips.reduce((sum, item) => sum + item.cargo.reduce((count, cargo) => count + cargo.containers, 0), 0) <= port.currentCapacityContainersPerDay * horizonHours / 24;
    });
  };
  const update = (partial: Partial<RecoveryPlan>) => selectedPlan && onChange({ ...selectedPlan, ...partial });
  const updateStaging = (vesselId: string, duration: number) => {
    if (!selectedPlan) return;
    const stagingWindowsByVessel = { ...selectedPlan.stagingWindowsByVessel };
    if (!duration) delete stagingWindowsByVessel[vesselId];
    else stagingWindowsByVessel[vesselId] = { startHour: Math.min(stagingWindowsByVessel[vesselId]?.startHour ?? 0, horizonHours - duration), durationHours: duration as 2 | 4 | 8 | 12 };
    onChange({ ...selectedPlan, stagingWindowsByVessel });
  };
  const updatePriority = (cargoId: string, priority: 0 | CargoPriority) => {
    if (!selectedPlan) return;
    const cargoPrioritiesByBatch = { ...selectedPlan.cargoPrioritiesByBatch };
    if (!priority) delete cargoPrioritiesByBatch[cargoId];
    else cargoPrioritiesByBatch[cargoId] = priority;
    onChange({ ...selectedPlan, cargoPrioritiesByBatch });
  };
  const updateReservation = (percent: number) => {
    if (!selectedPlan) return;
    update({ criticalCapacityReservation: percent ? selectedPlan.criticalCapacityReservation
      ? { ...selectedPlan.criticalCapacityReservation, percent }
      : { percent, startHour: 0, endHour: horizonHours } : null });
  };
  const plans = planDescription(recommended, state, recommended);
  const sourceLabel = decisionSource === "jev" ? "JEV-SELECTED PLAN" : decisionSource === "mock" ? "LOCAL MOCK PLAN" : "DETERMINISTIC FALLBACK";

  return <section className="panel recovery-planner">
    <div className="recovery-planner__heading">
      <div><div className="panel-kicker">RECOVERY PLAYBOOK</div><h2>Operational plans</h2><p>Jev compares complete simulated plans. Load a proposal to edit it; evaluation only runs a what-if simulation.</p></div>
      <span className="decision-source">{recommendedCandidate ? "FEASIBLE RECOMMENDATION" : "RECOMMENDATION"}</span>
    </div>

    <article className="recovery-plan-card recovery-plan-card--recommended">
      <div className="recovery-plan-card__top"><div><small>{sourceLabel}</small><h3>{recommended.name}</h3><p>{recommended.summary}</p></div><button className="button button--outline button--small" disabled={busy} onClick={() => onLoad(recommended)}>Edit this plan</button></div>
      <div className="recovery-plan-card__metrics"><span>Critical on time <strong>{recommendedCandidate?.outcome.mean.criticalCargoOnTimePercent.toFixed(1) ?? "—"}%</strong></span><span>Average container delay <strong>{recommendedCandidate?.outcome.mean.averageCargoDelayHours.toFixed(1) ?? "—"}h</strong></span><span>Disruption cost <strong>{recommendedCandidate ? cost(recommendedCandidate.outcome) : "—"}</strong></span><span>Target likelihood <strong>{recommendedCandidate ? `${Math.round(recommendedCandidate.outcome.probabilityOfMeetingTarget * 100)}%` : "—"}</strong></span></div>
      <div className="recovery-plan-card__objective"><b>{objectiveLabel(recommended.objective)}</b> · {recommended.minimumCriticalCargoOnTimePercent}% delivery target{recommended.maximumDisruptionCost === null ? "" : ` · $${recommended.maximumDisruptionCost.toLocaleString("en-US")} cost ceiling`}</div>
      <details className="plan-actions"><summary>Inspect {plans.length} modeled actions</summary><ul>{plans.map((action) => <li key={action}>{action}</li>)}</ul></details>
    </article>

    <div className="recovery-plan-editor">
      <div className="recovery-plan-editor__top"><div><h3>Plan editor</h3><p>{selectedPlan ? pending ? "Draft differs from the last evaluated plan." : "Draft matches the last evaluated plan." : "Choose a recommendation or alternative to create a draft."}</p></div>{selectedPlan && <button className="link-button" disabled={busy} onClick={onClear}>Clear draft</button>}</div>
      {selectedPlan ? <>
        <div className="plan-control-grid">
          <label className="plan-control"><span>Vessel scheduling policy</span><select value={selectedPlan.scheduling} disabled={busy} onChange={(event) => update({ scheduling: event.target.value as RecoveryPlan["scheduling"] })}><option value="arrival-order">Arrival order</option><option value="critical-first">Critical cargo first</option><option value="deadline-risk-first">Deadline risk first</option><option value="balanced">Balanced</option></select></label>
          <label className="plan-control plan-control--check"><input type="checkbox" checked={selectedPlan.reserveBerthForCriticalCargo} disabled={busy || !state.ports.some((port) => Math.min(port.availableBerths, port.unloadingResources) > 1 && state.ships.some((ship) => (selectedPlan.assignments[ship.vesselId] ?? ship.destinationPortId) === port.portId && ship.cargo.some((cargo) => cargo.essential)))} onChange={(event) => update({ reserveBerthForCriticalCargo: event.target.checked })}/><span>Reserve one berth for critical cargo</span></label>
        </div>
        <div className="plan-table-wrap"><h4>Vessel assignments and staging</h4><div className="plan-table">
          {state.ships.map((ship) => {
            const staging = selectedPlan.stagingWindowsByVessel[ship.vesselId];
            const ports = portsFor(ship.vesselId);
            return <div className="plan-vessel-row" key={ship.vesselId}><div><strong>{ship.vesselId}</strong><small>{ship.cargo.some((cargo) => cargo.essential) ? "Critical cargo aboard" : "Standard cargo"}</small></div><label><span>Destination</span><select value={selectedPlan.assignments[ship.vesselId] ?? ship.destinationPortId} disabled={busy} onChange={(event) => update({ assignments: { ...selectedPlan.assignments, [ship.vesselId]: event.target.value } })}>{ports.map((port) => <option key={port.portId} value={port.portId}>{port.location.name}</option>)}</select></label><label><span>Stage</span><select value={staging?.durationHours ?? 0} disabled={busy} onChange={(event) => updateStaging(ship.vesselId, Number(event.target.value))}><option value={0}>No hold</option>{[2, 4, 8, 12].filter((hours) => hours <= horizonHours).map((hours) => <option key={hours} value={hours}>{hours} hours</option>)}</select></label>{staging && <label><span>Start hour</span><input aria-label={`${ship.vesselId} staging start hour`} type="number" min={0} max={Math.max(0, horizonHours - staging.durationHours)} value={staging.startHour} disabled={busy} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value)) update({ stagingWindowsByVessel: { ...selectedPlan.stagingWindowsByVessel, [ship.vesselId]: { ...staging, startHour: Math.max(0, Math.min(horizonHours - staging.durationHours, value)) } } }); }}/></label>}</div>;
          })}
        </div><small className="plan-hint">Berths are assigned by the simulator using the selected policy; this model has no berth-specific handling differences.</small></div>
        <div className="plan-table-wrap"><h4>Cargo batch priorities</h4><div className="plan-table plan-table--cargo">{state.ships.flatMap((ship) => ship.cargo.map((cargo) => <label className="plan-cargo-row" key={cargo.cargoId}><span><strong>{cargo.cargoId}</strong><small>{ship.vesselId} · {cargo.category} · {cargo.essential ? "critical" : "standard"} · due {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(cargo.deadline))} UTC</small></span><select aria-label={`${cargo.cargoId} priority`} value={selectedPlan.cargoPrioritiesByBatch[cargo.cargoId] ?? 0} disabled={busy} onChange={(event) => updatePriority(cargo.cargoId, Number(event.target.value) as 0 | CargoPriority)}><option value={0}>Default</option><option value={1}>Priority</option><option value={2}>High</option><option value={3}>Urgent</option></select></label>))}</div><small className="plan-hint">Priority overrides affect actual batch unloading order; higher levels move first.</small></div>
        <div className="plan-table-wrap"><h4>Critical throughput reservation</h4><div className="plan-control-grid"><label className="plan-control"><span>Reserved share</span><select value={selectedPlan.criticalCapacityReservation?.percent ?? 0} disabled={busy || !state.ships.some((ship) => ship.cargo.some((cargo) => cargo.essential) && state.ships.some((other) => other.cargo.some((cargo) => !cargo.essential)))} onChange={(event) => updateReservation(Number(event.target.value))}><option value={0}>No reservation</option><option value={25}>25%</option><option value={50}>50%</option><option value={75}>75%</option></select></label>{selectedPlan.criticalCapacityReservation && <><label className="plan-control"><span>Starts at hour</span><input type="number" min={0} max={horizonHours - 1} value={selectedPlan.criticalCapacityReservation.startHour} disabled={busy} onChange={(event) => { const value = Number(event.target.value); const reservation = selectedPlan.criticalCapacityReservation!; if (Number.isInteger(value)) update({ criticalCapacityReservation: { ...reservation, startHour: Math.max(0, Math.min(reservation.endHour - 1, value)) } }); }}/></label><label className="plan-control"><span>Ends at hour</span><input type="number" min={1} max={horizonHours} value={selectedPlan.criticalCapacityReservation.endHour} disabled={busy} onChange={(event) => { const value = Number(event.target.value); const reservation = selectedPlan.criticalCapacityReservation!; if (Number.isInteger(value)) update({ criticalCapacityReservation: { ...reservation, endHour: Math.max(reservation.startHour + 1, Math.min(horizonHours, value)) } }); }}/></label></>}</div></div>
        <div className="recovery-plan-editor__footer"><span>{pending ? "Changes are not yet evaluated." : evaluated ? `Last outcome: ${evaluated.scheduling.replaceAll("-", " ")} · same simulation conditions.` : "Ready to evaluate this plan."}</span><button className="button button--primary button--small" disabled={busy} onClick={onEvaluate}>Evaluate my plan</button></div>
      </> : <div className="plan-editor-empty"><span>Choose “Edit this plan” above or load an alternative below. No recommendation is selected automatically.</span></div>}
    </div>

    <details className="alternative-strategies" open>
      <summary>Compare {Math.max(0, evaluatedStrategies.length - 1)} alternative feasible plans</summary>
      <div className="alternative-strategy-list">{evaluatedStrategies.filter((item) => item.strategy.id !== recommended.id).map((item) => <article className="alternative-strategy" key={item.strategy.id}><div><strong>{item.strategy.name}</strong><p>{item.strategy.summary}</p></div><div className="alternative-strategy__metrics"><span>Critical on time <b>{item.outcome.mean.criticalCargoOnTimePercent.toFixed(1)}%</b></span><span>Average container delay <b>{item.outcome.mean.averageCargoDelayHours.toFixed(1)}h</b></span><span>Disruption cost <b>{cost(item.outcome)}</b></span><span>Meet target <b>{Math.round(item.outcome.probabilityOfMeetingTarget * 100)}%</b></span></div><small>{alternativeReason(item, recommendedCandidate)}</small><small>Affects vessels: {item.affectedShips.length ? item.affectedShips.join(", ") : "No vessel schedule changes"}</small><small>Affects cargo: {item.affectedCargo.length ? item.affectedCargo.join(", ") : "No cargo assignment changes"}</small><details className="alternative-plan-actions"><summary>Inspect modeled operations</summary><ul>{planDescription(item.strategy, state, item.strategy).map((action) => <li key={action}>{action}</li>)}</ul></details><button className="button button--outline button--small" disabled={busy} onClick={() => onLoad(item.strategy)}>Edit this plan</button></article>)}</div>
    </details>
  </section>;
}
