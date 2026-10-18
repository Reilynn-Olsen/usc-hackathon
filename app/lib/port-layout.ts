// Shared schematic dimensions for the port mesh and vessel placement.
export const PIER_Z = [-36, -19, -2, 15, 32] as const;
export const PIER_HALF_WIDTH = 2.55;
export const SHIP_HALF_LENGTH = 5.5;
export const SHIP_HALF_WIDTH = 1.5;
export const OPEN_WATER_MAX_X = 2;

export function berthPosition(index: number): [number, number] {
  const pier = PIER_Z[index % PIER_Z.length];
  return [22, pier + (Math.floor(index / PIER_Z.length) % 2 === 0 ? -5.5 : 5.5)];
}

export function waterPosition([x, z]: [number, number]): [number, number] {
  // Geographic observations stay untouched in SimulationState. The schematic
  // has a different coastline, so keep displayed approach vessels west of piers.
  return [Math.min(OPEN_WATER_MAX_X, x), z];
}

export function berthIntersectsArea(index: number, area: { x: number; z: number; radius: number }): boolean {
  const [x, z] = berthPosition(index);
  const dx = Math.max(0, Math.abs(area.x - x) - SHIP_HALF_LENGTH);
  const dz = Math.max(0, Math.abs(area.z - z) - SHIP_HALF_WIDTH);
  return Math.hypot(dx, dz) <= area.radius;
}
