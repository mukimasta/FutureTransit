import type { Building, BuildingKind, Occupation, World } from "./types";

const DEFAULT_CAPACITY: Record<BuildingKind, number> = {
  home: 48,
  office: 128,
  shop: 30,
  school: 96,
  hospital: 72,
  restaurant: 36,
  park: 60,
};

export function buildingCapacity(building: Building): number {
  return building.development?.capacity ?? DEFAULT_CAPACITY[building.kind];
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

/**
 * The number of durable routine assignments a place can hold. School capacity
 * is shared by students and teachers; hospitals reserve part of their public
 * capacity for care visits, and shops/restaurants keep most room for patrons.
 */
export function assignmentCapacity(building: Building): number {
  const capacity = activeCapacity(building);
  switch (building.kind) {
    case "office":
    case "school":
      return capacity;
    case "hospital":
      return Math.max(1, Math.floor(capacity * 0.55));
    case "shop":
    case "restaurant":
      return Math.max(1, Math.floor(capacity * 0.3));
    case "home":
    case "park":
      return 0;
  }
}

export function supportsOccupation(
  building: Building,
  occupation: Occupation,
): boolean {
  switch (occupation) {
    case "worker":
      return building.kind === "office";
    case "student":
    case "teacher":
      return building.kind === "school";
    case "medic":
      return building.kind === "hospital";
    case "service":
      return (
        building.kind === "shop" ||
        building.kind === "restaurant" ||
        building.kind === "hospital"
      );
  }
}

export function availableJobSlots(world: World): number {
  const counts = jobCounts(world);
  return world.buildings.reduce(
    (sum, building) =>
      sum +
      Math.max(
        0,
        assignmentCapacity(building) - (counts.get(building.id) ?? 0),
      ),
    0,
  );
}

export function buildingDevelopmentStats(world: World, building: Building) {
  const assigned = world.residents.filter((resident) =>
    building.kind === "home"
      ? resident.homeId === building.id
      : resident.workId === building.id,
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
