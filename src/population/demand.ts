import { activeCapacity, jobCounts } from "../shared/development";
import { distance, random } from "../shared/math";
import type { Building, Resident, World } from "../shared/types";

function weightedBuilding(
  world: World,
  buildings: Building[],
  weight: (building: Building) => number,
): Building | null {
  const choices = buildings.map((building) => ({
    building,
    weight: Math.max(0, weight(building)),
  }));
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  if (!total) return null;
  let draw = random(world) * total;
  for (const choice of choices) {
    draw -= choice.weight;
    if (draw < 0) return choice.building;
  }
  return choices.at(-1)?.building ?? null;
}

/** Jobs are finite, while attractive centers pull commuters across districts. */
export function chooseWorkplace(
  world: World,
  home: Building,
  counts = jobCounts(world),
  excludeId?: string,
): Building | null {
  return weightedBuilding(
    world,
    world.buildings.filter(
      (building) => building.kind === "office" && building.id !== excludeId,
    ),
    (building) => {
      const free = Math.max(
        0,
        activeCapacity(building) - (counts.get(building.id) ?? 0),
      );
      const attraction = building.development?.role === "employment" ? 4 : 1;
      return (free * attraction) / (1 + distance(home, building) / 80);
    },
  );
}

/** This only selects existing buildings; it never invents customers or trips. */
export function chooseLeisurePlace(
  world: World,
  from: Building | undefined,
  candidates: Building[],
): Building | null {
  return weightedBuilding(world, candidates, (building) => {
    const attraction =
      building.kind === "home"
        ? 0.7
        : Math.sqrt(activeCapacity(building) / 12) *
          (building.development?.role === "commercial" ? 4 : 1);
    return attraction / (1 + (from ? distance(from, building) : 0) / 65);
  });
}

/** A portion of commuters join an office-specific wave, with individual jitter.
 * Maximum extra dwell is 30 city minutes; other activities remain asynchronous. */
export function commuteDeparture(
  world: World,
  resident: Resident,
  office: Building | undefined,
  earliest: number,
  leavingOffice: boolean,
): number {
  if (!office?.development || random(world) >= 0.65) return earliest;
  const period = 3 * 3600;
  let hash = 0;
  for (const char of resident.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const offset =
    office.development.shift +
    (leavingOffice ? 90 * 60 : 0) +
    (hash % 900) +
    Math.floor(random(world) * 300);
  const target = Math.ceil((earliest - offset) / period) * period + offset;
  return target - earliest <= 30 * 60 ? target : earliest;
}
