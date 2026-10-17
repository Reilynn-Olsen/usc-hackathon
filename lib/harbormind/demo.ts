import type { SimulationState } from "./types.ts";

const hoursAfter = (startAt: string, hours: number) => new Date(Date.parse(startAt) + hours * 3_600_000).toISOString();

export function createStormScenario(startAt = new Date().toISOString()): SimulationState {
  const portId = "port-los-angeles";
  const shipIds = ["evergreen-1", "pacific-star", "northwind", "ocean-crown"];
  const source = "synthetic" as const;
  return {
    scenarioId: "la-storm-capacity-cut",
    startAt,
    ports: [{
      portId,
      location: { name: "Port of Los Angeles", latitude: 33.74, longitude: -118.27 },
      normalCapacityContainersPerDay: 240,
      currentCapacityContainersPerDay: 240,
      availableBerths: 2,
      unloadingResources: 2,
      queueShipIds: shipIds,
      activeDisruptions: [{ id: "storm-capacity-cut", description: "Storm reduces modeled unloading capacity by 60%.", severity: 0.6, startHour: 0, durationHours: 18 }],
      supportedHandling: ["refrigerated", "hazmat"],
      source,
    }],
    ships: [
      {
        vesselId: "evergreen-1", mmsi: "synthetic-338123000", position: { latitude: 33.66, longitude: -118.14 }, heading: 285, speedKnots: 8.2,
        estimatedArrival: hoursAfter(startAt, 0), destinationPortId: portId, eligibleAlternativePortIds: [], positionSource: source, operationsSource: source,
        cargo: [{ cargoId: "consumer-goods", category: "consumer goods", containers: 160, essential: false, deadline: hoursAfter(startAt, 72), delayCostPerContainerHour: 8, specialHandling: [], source }],
      },
      {
        vesselId: "pacific-star", mmsi: "synthetic-338234000", position: { latitude: 33.61, longitude: -118.2 }, heading: 300, speedKnots: 7.5,
        estimatedArrival: hoursAfter(startAt, 1), destinationPortId: portId, eligibleAlternativePortIds: [], positionSource: source, operationsSource: source,
        cargo: [{ cargoId: "medical-supplies", category: "medical supplies", containers: 20, essential: true, deadline: hoursAfter(startAt, 18), delayCostPerContainerHour: 400, specialHandling: ["refrigerated"], source }],
      },
      {
        vesselId: "northwind", mmsi: "synthetic-338345000", position: { latitude: 33.57, longitude: -118.31 }, heading: 5, speedKnots: 6.8,
        estimatedArrival: hoursAfter(startAt, 2), destinationPortId: portId, eligibleAlternativePortIds: [], positionSource: source, operationsSource: source,
        cargo: [{ cargoId: "perishable-food", category: "perishable food", containers: 45, essential: true, deadline: hoursAfter(startAt, 30), delayCostPerContainerHour: 100, specialHandling: ["refrigerated"], source }],
      },
      {
        vesselId: "ocean-crown", mmsi: "synthetic-338456000", position: { latitude: 33.7, longitude: -118.42 }, heading: 80, speedKnots: 9.1,
        estimatedArrival: hoursAfter(startAt, 3), destinationPortId: portId, eligibleAlternativePortIds: [], positionSource: source, operationsSource: source,
        cargo: [{ cargoId: "industrial-components", category: "industrial components", containers: 60, essential: false, deadline: hoursAfter(startAt, 60), delayCostPerContainerHour: 30, specialHandling: [], source }],
      },
    ],
    weather: [{
      portId,
      forecasts: [0, 6, 12, 24].map((hours, index) => ({
        at: hoursAfter(startAt, hours), windSpeedKph: [42, 48, 44, 30][index], windGustKph: [65, 78, 70, 45][index],
        waveHeightM: [2.8, 3.4, 3.1, 1.8][index], precipitationMm: [4, 8, 5, 1][index],
      })),
      alerts: [{ id: "synthetic-storm-alert", description: "Synthetic severe weather alert for demonstration only.", severity: 0.8 }],
      source,
      alertsSource: source,
    }],
    provenance: { ports: source, shipPositions: source, shipEtaAndCargo: source, weather: source, weatherAlerts: source },
  };
}
