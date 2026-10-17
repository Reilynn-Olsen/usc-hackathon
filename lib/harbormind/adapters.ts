import type { DataSource, ProvenanceSource, SimulationState } from "./types.ts";

function combined(sources: Array<DataSource | "unavailable">): ProvenanceSource | "unavailable" {
  const values = new Set(sources);
  if (!values.size || values.size === 1 && values.has("unavailable")) return "unavailable";
  if (values.has("unavailable") || values.size > 1) return "mixed";
  return sources[0];
}

function combinedSource(sources: DataSource[], fallback: ProvenanceSource): ProvenanceSource {
  return sources.length ? combined(sources) as ProvenanceSource : fallback;
}

function updateProvenance(state: SimulationState): SimulationState {
  return {
    ...state,
    provenance: {
      ports: combinedSource(state.ports.map((port) => port.source), state.provenance.ports),
      shipPositions: combinedSource(state.ships.map((ship) => ship.positionSource), state.provenance.shipPositions),
      shipEtaAndCargo: combinedSource(state.ships.flatMap((ship) => [ship.operationsSource, ...ship.cargo.map((cargo) => cargo.source)]), state.provenance.shipEtaAndCargo),
      weather: combinedSource(state.weather.map((item) => item.source), state.provenance.weather),
      weatherAlerts: state.weather.length ? combined(state.weather.map((item) => item.alertsSource)) : state.provenance.weatherAlerts,
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numericArray(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : undefined;
}

function zonedForecastTime(value: unknown, utcOffsetSeconds: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/Z|[+-]\d{2}:\d{2}$/.test(value)) return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  if (typeof utcOffsetSeconds !== "number" || !Number.isFinite(utcOffsetSeconds)) return undefined;
  const localAsUtc = Date.parse(`${value}Z`);
  return Number.isFinite(localAsUtc) ? new Date(localAsUtc - utcOffsetSeconds * 1000).toISOString() : undefined;
}

/** Adapts the payload returned by GET /api/weather without inventing missing observations. */
export function applyOpenMeteoForecast(state: SimulationState, payload: unknown, explicitPortId?: string): SimulationState {
  const root = object(payload);
  const location = object(root?.location);
  const weather = object(root?.weather);
  const marine = object(root?.marine);
  const hourlyWeather = object(weather?.hourly);
  const hourlyMarine = object(marine?.hourly);
  const times = hourlyWeather?.time;
  const wind = numericArray(hourlyWeather?.wind_speed_10m);
  const gusts = numericArray(hourlyWeather?.wind_gusts_10m);
  const precipitation = numericArray(hourlyWeather?.precipitation);
  const waves = numericArray(hourlyMarine?.wave_height);
  if (!Array.isArray(times) || !wind || !gusts || !precipitation || !waves) return state;
  const port = state.ports.find((item) => item.portId === explicitPortId)
    ?? state.ports.find((item) => item.location.name === location?.name)
    ?? (state.ports.length === 1 ? state.ports[0] : undefined);
  if (!port) return state;
  const count = Math.min(times.length, wind.length, gusts.length, precipitation.length, waves.length);
  const forecasts = Array.from({ length: count }, (_, index) => ({
    at: zonedForecastTime(times[index], weather?.utc_offset_seconds), windSpeedKph: wind[index], windGustKph: gusts[index], waveHeightM: waves[index], precipitationMm: precipitation[index],
  })).filter((point): point is { at: string; windSpeedKph: number; windGustKph: number; waveHeightM: number; precipitationMm: number } => Boolean(point.at));
  if (!forecasts.length) return state;
  const updated = state.weather.filter((item) => item.portId !== port.portId);
  updated.push({ portId: port.portId, forecasts, alerts: [], source: "live", alertsSource: "unavailable" });
  const next = { ...state, weather: updated };
  return updateProvenance(next);
}

/** Applies only AIS position fields; ETA, destination, cargo, and weather remain as supplied. */
export function applyAisPositionReport(state: SimulationState, message: unknown): SimulationState {
  const root = object(message);
  const metadata = object(root?.MetaData);
  const report = object(object(root?.Message)?.PositionReport);
  const mmsi = metadata?.MMSI;
  if (mmsi === undefined || !report || typeof report.Latitude !== "number" || typeof report.Longitude !== "number" || !Number.isFinite(report.Latitude) || !Number.isFinite(report.Longitude) || report.Latitude < -90 || report.Latitude > 90 || report.Longitude < -180 || report.Longitude > 180) return state;
  const ship = state.ships.find((item) => item.mmsi === String(mmsi));
  if (!ship) return state;
  const heading = typeof report.TrueHeading === "number" && Number.isFinite(report.TrueHeading) && report.TrueHeading >= 0 && report.TrueHeading <= 360 ? report.TrueHeading : ship.heading;
  const speedKnots = typeof report.Sog === "number" && Number.isFinite(report.Sog) && report.Sog >= 0 && report.Sog <= 100 ? report.Sog : ship.speedKnots;
  const ships = state.ships.map((item) => item === ship ? {
    ...item,
    position: { latitude: report.Latitude as number, longitude: report.Longitude as number },
    heading, speedKnots, positionSource: "live" as const,
  } : item);
  return updateProvenance({ ...state, ships });
}
