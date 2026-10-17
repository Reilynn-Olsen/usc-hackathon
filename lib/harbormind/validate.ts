import type { DataSource, SimulationState } from "./types.ts";

const sources = new Set<DataSource>(["live", "cached", "synthetic"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isoDate = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const validSource = (value: unknown): value is DataSource => typeof value === "string" && sources.has(value as DataSource);
const validProvenance = (value: unknown) => validSource(value) || value === "mixed";

export function validateSimulationState(input: unknown): { state?: SimulationState; errors: string[] } {
  const errors: string[] = [];
  if (!record(input)) return { errors: ["Request body must be an object."] };
  if (!text(input.scenarioId) || input.scenarioId.length > 120) errors.push("scenarioId must be a non-empty string under 120 characters.");
  if (!isoDate(input.startAt)) errors.push("startAt must be a valid ISO date.");
  if (!Array.isArray(input.ports) || input.ports.length < 1 || input.ports.length > 20) errors.push("ports must contain 1 to 20 ports.");
  if (!Array.isArray(input.ships) || input.ships.length < 1 || input.ships.length > 200) errors.push("ships must contain 1 to 200 ships.");
  if (!Array.isArray(input.weather) || input.weather.length > 20) errors.push("weather must be an array of at most 20 port forecasts.");
  if (!record(input.provenance)) errors.push("provenance is required.");

  const portIds = new Set<string>();
  if (Array.isArray(input.ports)) for (const [index, raw] of input.ports.entries()) {
    const path = `ports[${index}]`;
    if (!record(raw)) { errors.push(`${path} must be an object.`); continue; }
    if (!text(raw.portId) || portIds.has(raw.portId)) errors.push(`${path}.portId must be unique and non-empty.`);
    else portIds.add(raw.portId);
    if (!record(raw.location) || !text(raw.location.name) || !finite(raw.location.latitude) || !finite(raw.location.longitude) || raw.location.latitude < -90 || raw.location.latitude > 90 || raw.location.longitude < -180 || raw.location.longitude > 180) errors.push(`${path}.location is invalid.`);
    for (const key of ["normalCapacityContainersPerDay", "currentCapacityContainersPerDay", "availableBerths", "unloadingResources"] as const) {
      if (!finite(raw[key]) || raw[key] < 0 || ((key === "availableBerths" || key === "unloadingResources") && !Number.isInteger(raw[key]))) errors.push(`${path}.${key} must be a non-negative ${key === "availableBerths" || key === "unloadingResources" ? "integer" : "number"}.`);
    }
    for (const key of ["normalCapacityContainersPerDay", "currentCapacityContainersPerDay"] as const) if (finite(raw[key]) && raw[key] > 1_000_000) errors.push(`${path}.${key} cannot exceed 1,000,000 containers per day.`);
    if (!stringList(raw.queueShipIds)) errors.push(`${path}.queueShipIds must be a string array.`);
    if (!stringList(raw.supportedHandling)) errors.push(`${path}.supportedHandling must be a string array.`);
    if (!validSource(raw.source)) errors.push(`${path}.source must be live, cached, or synthetic.`);
    if (!Array.isArray(raw.activeDisruptions) || raw.activeDisruptions.some((item) => !record(item) || !text(item.id) || !text(item.description) || !finite(item.severity) || item.severity < 0 || item.severity > 1 || !finite(item.startHour) || !Number.isInteger(item.startHour) || item.startHour < 0 || item.startHour > 720 || !finite(item.durationHours) || !Number.isInteger(item.durationHours) || item.durationHours < 0 || item.durationHours > 720)) errors.push(`${path}.activeDisruptions contains invalid data.`);
  }

  const shipIds = new Set<string>();
  const cargoIds = new Set<string>();
  if (Array.isArray(input.ships)) for (const [index, raw] of input.ships.entries()) {
    const path = `ships[${index}]`;
    if (!record(raw)) { errors.push(`${path} must be an object.`); continue; }
    if (!text(raw.vesselId) || shipIds.has(raw.vesselId)) errors.push(`${path}.vesselId must be unique and non-empty.`);
    else shipIds.add(raw.vesselId);
    if (raw.mmsi !== undefined && !text(raw.mmsi)) errors.push(`${path}.mmsi must be a string when supplied.`);
    if (!record(raw.position) || !finite(raw.position.latitude) || !finite(raw.position.longitude) || raw.position.latitude < -90 || raw.position.latitude > 90 || raw.position.longitude < -180 || raw.position.longitude > 180) errors.push(`${path}.position is invalid.`);
    if (!finite(raw.heading) || raw.heading < 0 || raw.heading > 360) errors.push(`${path}.heading must be between 0 and 360.`);
    if (!finite(raw.speedKnots) || raw.speedKnots < 0 || raw.speedKnots > 100) errors.push(`${path}.speedKnots must be between 0 and 100.`);
    if (!isoDate(raw.estimatedArrival)) errors.push(`${path}.estimatedArrival must be a valid ISO date.`);
    if (!text(raw.destinationPortId)) errors.push(`${path}.destinationPortId is required.`);
    if (!stringList(raw.eligibleAlternativePortIds)) errors.push(`${path}.eligibleAlternativePortIds must be a string array.`);
    if (!validSource(raw.positionSource)) errors.push(`${path}.positionSource must be live, cached, or synthetic.`);
    if (!validSource(raw.operationsSource)) errors.push(`${path}.operationsSource must be live, cached, or synthetic.`);
    if (!Array.isArray(raw.cargo) || raw.cargo.length < 1 || raw.cargo.length > 100) { errors.push(`${path}.cargo must contain 1 to 100 items.`); continue; }
    for (const [cargoIndex, cargo] of raw.cargo.entries()) {
      const cargoPath = `${path}.cargo[${cargoIndex}]`;
      if (!record(cargo)) { errors.push(`${cargoPath} must be an object.`); continue; }
      if (!text(cargo.cargoId) || cargoIds.has(cargo.cargoId)) errors.push(`${cargoPath}.cargoId must be unique and non-empty.`);
      else cargoIds.add(cargo.cargoId);
      if (!text(cargo.category)) errors.push(`${cargoPath}.category is required.`);
      if (!finite(cargo.containers) || cargo.containers < 1 || !Number.isSafeInteger(cargo.containers) || cargo.containers > 1_000_000) errors.push(`${cargoPath}.containers must be a safe integer from 1 to 1,000,000.`);
      if (typeof cargo.essential !== "boolean") errors.push(`${cargoPath}.essential must be boolean.`);
      if (!isoDate(cargo.deadline)) errors.push(`${cargoPath}.deadline must be a valid ISO date.`);
      if (cargo.delayCostPerContainerHour !== undefined && (!finite(cargo.delayCostPerContainerHour) || cargo.delayCostPerContainerHour < 0 || cargo.delayCostPerContainerHour > 1_000_000_000)) errors.push(`${cargoPath}.delayCostPerContainerHour must be from 0 to 1,000,000,000.`);
      if (!stringList(cargo.specialHandling)) errors.push(`${cargoPath}.specialHandling must be a string array.`);
      if (!validSource(cargo.source)) errors.push(`${cargoPath}.source must be live, cached, or synthetic.`);
    }
  }

  const forecastPorts = new Set<string>();
  if (Array.isArray(input.weather)) for (const [index, raw] of input.weather.entries()) {
    const path = `weather[${index}]`;
    if (!record(raw)) { errors.push(`${path} must be an object.`); continue; }
    if (!text(raw.portId) || forecastPorts.has(raw.portId)) errors.push(`${path}.portId must be unique and non-empty.`);
    else forecastPorts.add(raw.portId);
    if (!validSource(raw.source)) errors.push(`${path}.source must be live, cached, or synthetic.`);
    if (raw.alertsSource !== "unavailable" && !validSource(raw.alertsSource)) errors.push(`${path}.alertsSource must be live, cached, synthetic, or unavailable.`);
    if (!Array.isArray(raw.forecasts) || raw.forecasts.length > 336 || raw.forecasts.some((item) => !record(item) || !isoDate(item.at) || !finite(item.windSpeedKph) || item.windSpeedKph < 0 || !finite(item.windGustKph) || item.windGustKph < 0 || !finite(item.waveHeightM) || item.waveHeightM < 0 || !finite(item.precipitationMm) || item.precipitationMm < 0)) errors.push(`${path}.forecasts contains invalid data.`);
    if (!Array.isArray(raw.alerts) || raw.alerts.some((item) => !record(item) || !text(item.id) || !text(item.description) || !finite(item.severity) || item.severity < 0 || item.severity > 1)) errors.push(`${path}.alerts contains invalid data.`);
  }

  if (record(input.provenance)) {
    for (const key of ["ports", "shipPositions", "shipEtaAndCargo"] as const) if (!validProvenance(input.provenance[key])) errors.push(`provenance.${key} must be live, cached, synthetic, or mixed.`);
    if (input.provenance.weather !== "unavailable" && !validProvenance(input.provenance.weather)) errors.push("provenance.weather must be live, cached, synthetic, mixed, or unavailable.");
    if (input.provenance.weatherAlerts !== "unavailable" && !validProvenance(input.provenance.weatherAlerts)) errors.push("provenance.weatherAlerts must be live, cached, synthetic, mixed, or unavailable.");
  }

  if (Array.isArray(input.ports) && Array.isArray(input.ships)) {
    const queues = new Set<string>();
    for (const port of input.ports) if (record(port) && Array.isArray(port.queueShipIds)) for (const id of port.queueShipIds) {
      if (typeof id !== "string" || queues.has(id)) errors.push(`Ship ${String(id)} appears more than once in port queues.`);
      queues.add(String(id));
      const ship = input.ships.find((item) => record(item) && item.vesselId === id);
      if (!ship || !record(ship) || ship.destinationPortId !== port.portId) errors.push(`Queued ship ${String(id)} must exist and match its destination port.`);
    }
    for (const ship of input.ships) if (record(ship)) {
      if (!portIds.has(String(ship.destinationPortId))) errors.push(`Ship ${String(ship.vesselId)} references an unmodeled destination port.`);
      if (!queues.has(String(ship.vesselId))) errors.push(`Ship ${String(ship.vesselId)} must appear in a port queue.`);
      if (Array.isArray(ship.eligibleAlternativePortIds)) for (const id of ship.eligibleAlternativePortIds) {
        if (!portIds.has(String(id)) || id === ship.destinationPortId) errors.push(`Ship ${String(ship.vesselId)} references an invalid alternative port.`);
      }
    }
    for (const port of input.ports) if (record(port) && Array.isArray(port.activeDisruptions) && Array.isArray(port.queueShipIds) && Array.isArray(port.supportedHandling)) {
      for (const id of port.queueShipIds) {
        const ship = input.ships.find((item) => record(item) && item.vesselId === id);
        if (record(ship) && Array.isArray(ship.cargo)) for (const cargo of ship.cargo) if (record(cargo) && Array.isArray(cargo.specialHandling)) {
          for (const handling of cargo.specialHandling) if (!port.supportedHandling.includes(handling)) errors.push(`Port ${String(port.portId)} does not model required handling ${String(handling)} for ship ${String(id)}.`);
        }
      }
    }
    if (Array.isArray(input.weather)) for (const weather of input.weather) if (record(weather) && !portIds.has(String(weather.portId))) errors.push(`Weather references an unmodeled port ${String(weather.portId)}.`);
  }

  return errors.length ? { errors: [...new Set(errors)].slice(0, 30) } : { state: input as unknown as SimulationState, errors };
}
