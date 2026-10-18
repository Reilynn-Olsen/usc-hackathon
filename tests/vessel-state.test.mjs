import assert from "node:assert/strict";
import test from "node:test";
import { createStormScenario } from "../lib/harbormind/demo.ts";
import { validateSimulationState } from "../lib/harbormind/validate.ts";
import {
  freezeVesselState,
  ingestVesselReport,
  projectPosition,
  vesselsForMap,
} from "../app/lib/vessel-state.ts";
import {
  generateStrategies,
  simulateStrategyWithReplay,
  simulateStrategy,
} from "../lib/harbormind/simulation.ts";

const start = "2026-10-17T12:00:00.000Z";
const report = (mmsi = 338123001, latitude = 33.66) => ({
  MetaData: { MMSI: mmsi, ShipName: "Observed Vessel" },
  Message: {
    PositionReport: {
      Latitude: latitude,
      Longitude: -118.4,
      TrueHeading: 90,
      Sog: 8,
    },
  },
});

test("AIS ingestion replaces demo identities, deduplicates MMSI, and labels synthetic operations", () => {
  const original = createStormScenario(start);
  const live = ingestVesselReport(original, report(), start);
  assert.equal(original.ships.length, 4);
  assert.equal(live.ships.length, 1);
  assert.equal(live.ships[0].vesselId, "ais-338123001");
  assert.equal(live.ships[0].name, "Observed Vessel");
  assert.equal(live.provenance.shipPositions, "live");
  assert.equal(live.provenance.shipEtaAndCargo, "synthetic");
  assert.equal(live.ships[0].cargo[0].source, "synthetic");
  assert.deepEqual(validateSimulationState(live).errors, []);
  const next = ingestVesselReport(live, report(338123001, 33.7), start);
  assert.equal(next.ships.length, 1);
  assert.equal(next.ships[0].position.latitude, 33.7);
  assert.equal(live.ships[0].position.latitude, 33.66);
  assert.equal(ingestVesselReport(live, report(338123001, NaN)), live);
  assert.equal(ingestVesselReport(live, report(338123001, 91)), live);
  assert.equal(ingestVesselReport(live, report("bad")), live);
});

test("live fleet stays bounded and existing vessels still update at the limit", () => {
  let state = createStormScenario(start);
  for (let index = 0; index < 40; index++)
    state = ingestVesselReport(state, report(338123000 + index), start);
  assert.equal(state.ships.length, 32);
  state = ingestVesselReport(state, report(338123000, 33.8), start);
  assert.equal(state.ships[0].position.latitude, 33.8);
  assert.deepEqual(validateSimulationState(state).errors, []);
});

test("frozen scenario is isolated from future AIS and retains reproducible results", () => {
  const live = ingestVesselReport(createStormScenario(start), report(), start);
  const frozen = freezeVesselState(live, start);
  const strategy = generateStrategies(frozen)[0];
  const options = { runs: 2, seed: 42, horizonHours: 6 };
  const before = simulateStrategyWithReplay(frozen, strategy, options);
  const updated = ingestVesselReport(live, report(338123001, 33.8), start);
  updated.ships[0].cargo[0].containers = 999;
  assert.equal(frozen.ships[0].position.latitude, 33.66);
  assert.notEqual(frozen.ships[0].cargo[0].containers, 999);
  assert.deepEqual(
    simulateStrategyWithReplay(frozen, strategy, options),
    before,
  );
  assert.deepEqual(validateSimulationState(frozen).errors, []);
  assert.equal(
    freezeVesselState(live, "2026-10-17T12:10:00Z").ships[0].positionSource,
    "cached",
  );
});

test("map starts at the captured position then follows waiting, berthing, and departure replay", () => {
  const state = freezeVesselState(
    ingestVesselReport(createStormScenario(start), report(), start),
    start,
  );
  const ship = state.ships[0];
  const initial = projectPosition(ship.position, state.ports[0]);
  const snapshot = (status, hour) => ({
    simulationHour: hour,
    vessels: [
      {
        vesselId: ship.vesselId,
        portId: ship.destinationPortId,
        status,
        arrivalHour: 2,
        berthId: "berth-2",
        berthAtHour: 3,
        departureHour: 4,
      },
    ],
    ports: [
      {
        portId: ship.destinationPortId,
        waitingVesselIds: [ship.vesselId],
        berthAssignments: [{ berthId: "berth-2", vesselId: ship.vesselId }],
      },
    ],
    cargoBatches: [{ vesselId: ship.vesselId, containersRemaining: 7 }],
  });
  assert.deepEqual(vesselsForMap(state)[0].mapPosition, initial);
  assert.deepEqual(
    vesselsForMap(state, snapshot("waiting", 0))[0].mapPosition,
    initial,
  );
  const waiting = vesselsForMap(state, snapshot("waiting", 2))[0];
  const berthed = vesselsForMap(state, snapshot("berthed", 3))[0];
  const departed = vesselsForMap(state, snapshot("departed", 5))[0];
  assert.notDeepEqual(waiting.mapPosition, initial);
  assert.notDeepEqual(waiting.mapPosition, berthed.mapPosition);
  assert.notDeepEqual(berthed.mapPosition, departed.mapPosition);
  assert.deepEqual(berthed.ghostPosition, initial);
  assert.equal(berthed.containers, 7);
  assert.deepEqual(
    vesselsForMap(state, snapshot("berthed", 3)),
    vesselsForMap(state, snapshot("berthed", 3)),
  );
});


test("AIS fleet submitted to the simulation API is the fleet rendered throughout replay", async () => {
  const { POST } = await import("../app/api/simulate/route.ts");
  let feed = ingestVesselReport(createStormScenario(start), report(), start);
  feed = ingestVesselReport(feed, report(338123002, 33.7), start);
  const frozen = freezeVesselState(feed, start);
  const strategy = generateStrategies(frozen)[0];
  const response = await POST(new Request("http://localhost/api/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: frozen, strategyId: strategy.id, options: { runs: 2, seed: 42, horizonHours: 36 } }),
  }));
  assert.equal(response.status, 200);
  const simulation = await response.json();
  const ids = frozen.ships.map((ship) => ship.vesselId).sort();
  // A later position report must not alter the captured run's map positions.
  feed = ingestVesselReport(feed, report(338123001, 33.8), start);
  assert.notDeepEqual(vesselsForMap(feed)[0].mapPosition, vesselsForMap(frozen)[0].mapPosition);
  for (const replay of [simulation.replay, simulation.baselineReplay]) {
    assert.ok(replay.snapshots.length > 1);
    for (const snapshot of replay.snapshots) {
      const vessels = vesselsForMap(frozen, snapshot);
      assert.deepEqual(vessels.map((ship) => ship.id).sort(), ids);
      assert.deepEqual(snapshot.vessels.map((ship) => ship.vesselId).sort(), ids);
      assert.equal(vessels.reduce((sum, ship) => sum + ship.containers, 0),
        snapshot.cargoBatches.reduce((sum, batch) => sum + batch.containersRemaining, 0));
    }
  }
});


test("schematic approach ships clear the piers and berthed hulls fit alongside them", async () => {
  const { PIER_Z, PIER_HALF_WIDTH, SHIP_HALF_LENGTH, SHIP_HALF_WIDTH, berthPosition } = await import("../app/lib/port-layout.ts");
  const state = createStormScenario(start);
  const original = structuredClone(state.ships.map((ship) => ship.position));
  const approaches = vesselsForMap(state);
  for (const ship of approaches) assert.ok(ship.mapPosition[0] + SHIP_HALF_LENGTH < 9);
  assert.deepEqual(state.ships.map((ship) => ship.position), original);
  for (let index = 0; index < PIER_Z.length; index++) {
    const [x, z] = berthPosition(index);
    assert.ok(x + SHIP_HALF_LENGTH < 33, "Hull clears the shore");
    for (const pier of PIER_Z) assert.ok(Math.abs(z - pier) > SHIP_HALF_WIDTH + PIER_HALF_WIDTH, "Hull clears every pier");
  }
});

test("equipment failure closes affected berths in replay and reopens them after repair", async () => {
  const { configureScenarioState } = await import("../app/lib/scenario.ts");
  const { SCENARIOS } = await import("../app/lib/data.ts");
  const { berthIntersectsArea } = await import("../app/lib/port-layout.ts");
  const outage = SCENARIOS.find((item) => item.id === "outage");
  const options = { runs: 1, seed: 42, horizonHours: 8, maxArrivalDelayHours: 0, capacityReductionVariation: 0, unloadingTimeVariation: 0, equipmentFailureProbability: 0 };
  for (const startHour of [0, 2]) {
    const state = configureScenarioState(createStormScenario(start), outage, 50, 3);
    state.ports[0].activeDisruptions[0].startHour = startHour;
    for (const ship of state.ships) {
      ship.estimatedArrival = start;
      for (const cargo of ship.cargo) cargo.containers = 1000;
    }
    const closed = state.ports[0].activeDisruptions[0].closedBerthIds;
    assert.deepEqual(closed, [`${state.ports[0].portId}-berth-2`]);
    assert.deepEqual(validateSimulationState(state).errors, []);
    const strategy = generateStrategies(state)[0];
    const { replay, summary } = simulateStrategyWithReplay(state, strategy, options);
    assert.deepEqual(summary, simulateStrategy(state, strategy, options));
    for (const snapshot of replay.snapshots) {
      if (snapshot.simulationHour >= startHour && snapshot.simulationHour < startHour + 3) {
        assert.ok(snapshot.ports[0].berthAssignments.every((item) => !closed.includes(item.berthId)));
        for (const vessel of snapshot.vessels.filter((item) => item.status === "berthed")) {
          const index = Number(vessel.berthId.match(/(\d+)$/)[1]) - 1;
          assert.equal(berthIntersectsArea(index, outage.zone), false);
        }
      }
      const remaining = snapshot.cargoBatches.reduce((sum, batch) => sum + batch.containersRemaining, 0);
      const unloaded = snapshot.cargoBatches.reduce((sum, batch) => sum + batch.containersUnloaded, 0);
      assert.equal(remaining + unloaded, 4000, "A berth closure preserves cargo progress");
    }
    assert.ok(replay.snapshots.some((snapshot) => snapshot.simulationHour > startHour + 3 && snapshot.ports[0].berthAssignments.some((item) => closed.includes(item.berthId))));
    if (startHour > 0) assert.ok(replay.snapshots.find((snapshot) => snapshot.simulationHour === 1).ports[0].berthAssignments.some((item) => closed.includes(item.berthId)));
    state.ports[0].activeDisruptions[0].closedBerthIds = ["unknown-berth"];
    assert.ok(validateSimulationState(state).errors.length > 0);
  }
});
