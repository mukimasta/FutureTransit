import type { Building, World } from "./types";

export function buildingCapacity(building: Building): number {
  return (
    building.development?.capacity ??
    (building.kind === "home" ? 48 : building.kind === "office" ? 128 : 24)
  );
}

export function activeCapacity(building: Building): number {
  const fraction = building.development
    ? ({ 1: 0.5, 2: 0.75, 3: 1 } as const)[building.development.stage]
    : 1;
  return Math.floor(buildingCapacity(building) * fraction);
}

export function jobCounts(world: World): Map<string, number> {
  const counts = new Map<string, number>();
  for (const resident of world.residents)
    counts.set(resident.workId, (counts.get(resident.workId) ?? 0) + 1);
  return counts;
}

export function availableJobSlots(world: World): number {
  const counts = jobCounts(world);
  return world.buildings.reduce(
    (sum, building) =>
      sum +
      (building.kind === "office"
        ? Math.max(0, activeCapacity(building) - (counts.get(building.id) ?? 0))
        : 0),
    0,
  );
}

export function buildingDevelopmentStats(world: World, building: Building) {
  const assigned = world.residents.filter((resident) =>
    building.kind === "home"
      ? resident.homeId === building.id
      : building.kind === "office" && resident.workId === building.id,
  ).length;
  return {
    assigned,
    capacity: Math.max(buildingCapacity(building), assigned),
    active: Math.max(activeCapacity(building), assigned),
    stage: building.development?.stage ?? 3,
    nextAt: building.development?.nextAt ?? 0,
    role: building.development?.role ?? "local",
  };
}
