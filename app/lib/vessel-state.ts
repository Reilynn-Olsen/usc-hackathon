import { createStormScenario } from "../../lib/harbormind/demo.ts";
import { applyAisPositionReport } from "../../lib/harbormind/adapters.ts";
import type {
  OperationalSnapshot,
  SimulationState,
} from "../../lib/harbormind/types.ts";
import type { Ship } from "./data.ts";

export type MapVessel = Omit<Ship, "cargo"> & {
  cargo: string;
  mapPosition: [number, number];
  mapHeading: number;
  ghostPosition?: [number, number];
};

// A local schematic projection, with the port entrance at (8, 0).
// This preserves geographic offsets; the terminal geometry is illustrative.
export function projectPosition(
  position: { latitude: number; longitude: number },
  port: SimulationState["ports"][number],
): [number, number] {
  const x =
    (position.longitude - port.location.longitude) *
    111.32 *
    Math.cos((port.location.latitude * Math.PI) / 180);
  const north = (position.latitude - port.location.latitude) * 111.32;
  return [8 + x * 2, -north * 2];
}

export function ingestVesselReport(
  state: SimulationState,
  message: unknown,
  observedAt = new Date().toISOString(),
): SimulationState {
  if (!message || typeof message !== "object") return state;
  const root = message as {
    MetaData?: { MMSI?: unknown; ShipName?: unknown };
    Message?: { PositionReport?: { Latitude?: unknown; Longitude?: unknown } };
  };
  const mmsi = String(root.MetaData?.MMSI ?? "");
  const report = root.Message?.PositionReport;
  if (
    !/^\d{9}$/.test(mmsi) ||
    !report ||
    typeof report.Latitude !== "number" ||
    !Number.isFinite(report.Latitude) ||
    Math.abs(report.Latitude) > 90 ||
    typeof report.Longitude !== "number" ||
    !Number.isFinite(report.Longitude) ||
    Math.abs(report.Longitude) > 180
  )
    return state;
  let next = state;
  if (!state.ships.some((ship) => ship.mmsi === mmsi)) {
    const observed = state.ships.filter((ship) => ship.positionObservedAt);
    if (observed.length >= 32) return state;
    // AIS has no cargo manifest. Explicitly attach a synthetic demo workload,
    // preserving its provenance rather than implying AIS supplied operations.
    const templates = createStormScenario(state.startAt).ships;
    const template = templates[Number(mmsi) % templates.length];
    const vesselId = `ais-${mmsi}`;
    const ship = {
      ...structuredClone(template),
      vesselId,
      mmsi,
      name:
        typeof root.MetaData?.ShipName === "string"
          ? root.MetaData.ShipName.trim()
          : vesselId,
      positionObservedAt: observedAt,
      position: { latitude: report.Latitude, longitude: report.Longitude },
      heading: 0,
      speedKnots: 0,
      operationsSource: "synthetic" as const,
      cargo: template.cargo.map((cargo, index) => ({
        ...cargo,
        cargoId: `${vesselId}-cargo-${index}`,
        source: "synthetic" as const,
      })),
    };
    next = {
      ...state,
      ships: [...observed, ship],
      ports: state.ports.map((port) => ({
        ...port,
        queueShipIds: [...observed, ship]
          .filter((item) => item.destinationPortId === port.portId)
          .map((item) => item.vesselId),
      })),
    };
  }
  const updated = applyAisPositionReport(next, message);
  return {
    ...updated,
    ships: updated.ships.map((ship) =>
      ship.mmsi === mmsi ? { ...ship, positionObservedAt: observedAt } : ship,
    ),
  };
}

export function freezeVesselState(
  state: SimulationState,
  startAt = new Date().toISOString(),
): SimulationState {
  const frozen = structuredClone(state);
  const offset = Date.parse(startAt) - Date.parse(frozen.startAt);
  frozen.startAt = startAt;
  for (const ship of frozen.ships) {
    ship.estimatedArrival = new Date(
      Date.parse(ship.estimatedArrival) + offset,
    ).toISOString();
    for (const cargo of ship.cargo)
      cargo.deadline = new Date(
        Date.parse(cargo.deadline) + offset,
      ).toISOString();
    const port = frozen.ports.find(
      (item) => item.portId === ship.destinationPortId,
    );
    if (ship.positionObservedAt && port) {
      const [x, z] = projectPosition(ship.position, port);
      const distanceKm = Math.hypot(x - 8, z) / 2;
      // The ETA is modeled from distance/speed, never presented as AIS data.
      const arrivalHours =
        ship.speedKnots > 0.5 ? distanceKm / (ship.speedKnots * 1.852) : 6;
      ship.estimatedArrival = new Date(
        Date.parse(startAt) + arrivalHours * 3_600_000,
      ).toISOString();
      if (Date.parse(startAt) - Date.parse(ship.positionObservedAt) > 120_000)
        ship.positionSource = "cached";
    }
  }
  const sources = new Set(frozen.ships.map((ship) => ship.positionSource));
  frozen.provenance.shipPositions =
    sources.size > 1 ? "mixed" : frozen.ships[0].positionSource;
  return frozen;
}

export function vesselsForMap(
  state: SimulationState | null,
  snapshot?: OperationalSnapshot | null,
): MapVessel[] {
  if (!state) return [];
  return state.ships.map((ship, index) => {
    const port =
      state.ports.find((item) => item.portId === ship.destinationPortId) ??
      state.ports[0];
    const initial = projectPosition(ship.position, port);
    const operation = snapshot?.vessels.find(
      (item) => item.vesselId === ship.vesselId,
    );
    let position: [number, number] = initial;
    let heading = ship.heading;
    if (operation && snapshot && snapshot.simulationHour > 0) {
      const waitingIndex =
        snapshot.ports
          .find((item) => item.portId === operation.portId)
          ?.waitingVesselIds.indexOf(ship.vesselId) ?? index;
      const waiting: [number, number] = [
        -12 - Math.floor(Math.max(0, waitingIndex) / 6) * 10,
        -40 + (Math.max(0, waitingIndex) % 6) * 16,
      ];
      if (operation.status === "scheduled") {
        const progress = Math.min(
          1,
          snapshot.simulationHour / Math.max(0.01, operation.arrivalHour),
        );
        position = [
          initial[0] + (waiting[0] - initial[0]) * progress,
          initial[1] + (waiting[1] - initial[1]) * progress,
        ];
      } else if (operation.status === "waiting") position = waiting;
      else if (operation.status === "berthed") {
        const berthIndex =
          snapshot.ports
            .find((item) => item.portId === operation.portId)
            ?.berthAssignments.findIndex(
              (item) => item.vesselId === ship.vesselId,
            ) ?? 0;
        const berthNumber = Number(operation.berthId?.match(/(\d+)$/)?.[1]);
        position = [
          23,
          -36 +
            ((berthNumber > 0 ? berthNumber - 1 : Math.max(0, berthIndex)) %
              5) *
              17 -
            4,
        ];
        heading = 90;
      } else {
        position = [
          -55 -
            Math.min(
              30,
              (snapshot.simulationHour -
                (operation.departureHour ?? snapshot.simulationHour)) *
                5,
            ),
          initial[1],
        ];
        heading = 270;
      }
    }
    const critical = ship.cargo.some((cargo) => cargo.essential);
    const batches = snapshot?.cargoBatches.filter(
      (batch) => batch.vesselId === ship.vesselId,
    );
    const containers =
      batches?.reduce((sum, batch) => sum + batch.containersRemaining, 0) ??
      ship.cargo.reduce((sum, cargo) => sum + cargo.containers, 0);
    return {
      id: ship.vesselId,
      name: ship.name || ship.vesselId,
      callSign: ship.mmsi || "Synthetic",
      cargo: ship.cargo.map((cargo) => cargo.category).join(", "),
      containers,
      eta: new Date(ship.estimatedArrival).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      }),
      status: operation?.status ?? `${ship.positionSource} position`,
      progress: operation?.status === "departed" ? 1 : 0,
      priority: critical ? "Critical" : "Standard",
      color: critical ? "#62e1d1" : "#7d9cc7",
      route: [initial, position],
      mapPosition: position,
      mapHeading: heading,
      ...(snapshot ? { ghostPosition: initial } : {}),
    };
  });
}
