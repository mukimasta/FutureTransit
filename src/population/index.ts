import { FARE, RESIDENT_COLORS } from "../shared/constants";
import { id, random } from "../shared/math";
import type { Building, Purpose, Resident, World } from "../shared/types";
import { availableJobSlots, jobCounts } from "../shared/development";
import {
  chooseLeisurePlace,
  chooseWorkplace,
  commuteDeparture,
} from "./demand";

/**
 * Baselines use simulation seconds.  They deliberately compress a workday so a
 * half-hour play session contains a commute and a few non-work activities.
 */
export const POPULATION_TIMING = {
  firstDepartureAt: 12,
  departureSpacing: 165,
  departureJitter: 120,
  workStayMin: 75 * 60,
  workStayRange: 70 * 60,
  shopStayMin: 8 * 60,
  shopStayRange: 14 * 60,
  visitStayMin: 14 * 60,
  visitStayRange: 20 * 60,
  homeStayMin: 30 * 60,
  homeStayRange: 40 * 60,
  shortWalkSeconds: 150,
} as const;

const FAMILY_NAMES = [
  "林",
  "陈",
  "王",
  "李",
  "周",
  "张",
  "赵",
  "吴",
  "徐",
  "孙",
  "杨",
  "何",
];
const GIVEN_NAMES = [
  "安然",
  "子墨",
  "知夏",
  "予安",
  "若川",
  "晴川",
  "言溪",
  "星河",
  "乐宁",
  "思远",
  "清妍",
  "远航",
  "舒言",
  "沐白",
  "念初",
  "望舒",
];

function buildingsOf(world: World, kind: Building["kind"]): Building[] {
  return world.buildings.filter((building) => building.kind === kind);
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function favoriteCandidates(world: World, resident: Resident): Building[] {
  return world.buildings.filter(
    (building) =>
      building.id !== resident.homeId &&
      building.id !== resident.workId &&
      (building.kind === "shop" || building.kind === "home"),
  );
}

function setFavorites(world: World, resident: Resident): void {
  const candidates = favoriteCandidates(world, resident);
  if (!candidates.length) return;

  const home = world.buildings.find(
    (building) => building.id === resident.homeId,
  );
  const first = chooseLeisurePlace(world, home, candidates)!.id;
  const values = [first];
  if (candidates.length > 1 && random(world) < 0.35) {
    values.push(chooseLeisurePlace(world, home, candidates)!.id);
  }
  resident.favorites = distinct(values);
}

function residenceVisitCandidates(
  world: World,
  resident: Resident,
): Building[] {
  const favoriteBuildings = resident.favorites
    .map((favoriteId) =>
      world.buildings.find((building) => building.id === favoriteId),
    )
    .filter((building): building is Building => Boolean(building));
  return favoriteBuildings.length
    ? favoriteBuildings
    : favoriteCandidates(world, resident);
}

function chooseFavoriteDestination(
  world: World,
  resident: Resident,
  currentId: string,
): string | null {
  const candidates = residenceVisitCandidates(world, resident).filter(
    (building) => building.id !== currentId,
  );
  const current = world.buildings.find((building) => building.id === currentId);
  return chooseLeisurePlace(world, current, candidates)?.id ?? null;
}

function fallbackDestination(
  resident: Resident,
  currentId: string,
): { destinationId: string; purpose: Purpose } | null {
  if (currentId !== resident.homeId)
    return { destinationId: resident.homeId, purpose: "home" };
  if (currentId !== resident.workId)
    return { destinationId: resident.workId, purpose: "work" };
  return null;
}

function dwellSeconds(world: World, purpose: Purpose): number {
  switch (purpose) {
    case "work":
      return (
        POPULATION_TIMING.workStayMin +
        Math.floor(random(world) * POPULATION_TIMING.workStayRange)
      );
    case "shop":
      return (
        POPULATION_TIMING.shopStayMin +
        Math.floor(random(world) * POPULATION_TIMING.shopStayRange)
      );
    case "visit":
      return (
        POPULATION_TIMING.visitStayMin +
        Math.floor(random(world) * POPULATION_TIMING.visitStayRange)
      );
    case "home":
      return (
        POPULATION_TIMING.homeStayMin +
        Math.floor(random(world) * POPULATION_TIMING.homeStayRange)
      );
  }
}

function chooseNextIntent(
  world: World,
  resident: Resident,
  currentId: string,
): { destinationId: string; purpose: Purpose } | null {
  const favorite = chooseFavoriteDestination(world, resident, currentId);
  const favoritePurpose: Purpose =
    world.buildings.find((b) => b.id === favorite)?.kind === "shop"
      ? "shop"
      : "visit";
  if (currentId === resident.homeId)
    return favorite && random(world) < 0.25
      ? { destinationId: favorite, purpose: favoritePurpose }
      : fallbackDestination(resident, currentId);
  const roll = random(world);
  if (currentId === resident.workId) {
    if (favorite && roll < 0.78)
      return { destinationId: favorite, purpose: favoritePurpose };
    return fallbackDestination(resident, currentId);
  }

  if (roll < 0.6) return fallbackDestination(resident, currentId);
  if (favorite && roll < 0.9)
    return { destinationId: favorite, purpose: favoritePurpose };
  return fallbackDestination(resident, currentId);
}

/**
 * Creates durable residents, but intentionally does not append them to
 * world.residents.  This keeps city-growth population changes atomic.
 */
export function createResidents(
  world: World,
  home: Building,
  count: number,
): Resident[] {
  const actualHome = world.buildings.find(
    (building) => building.id === home.id,
  );
  if (!actualHome || actualHome.kind !== "home")
    throw new Error("Residents need a valid home building in this world.");
  if (!Number.isInteger(count) || count < 0)
    throw new Error("Resident count must be a non-negative integer.");

  const offices = buildingsOf(world, "office");
  if (count > 0 && !offices.length)
    throw new Error("Residents need at least one office destination.");
  if (count > availableJobSlots(world))
    throw new Error("New residents need available commissioned jobs.");
  const placeCandidates = world.buildings.filter(
    (building) =>
      building.id !== actualHome.id &&
      (building.kind === "shop" || building.kind === "home"),
  );
  const residents: Resident[] = [];
  const jobs = jobCounts(world);

  for (let index = 0; index < count; index += 1) {
    const cityIndex = world.residents.length + index;
    const residentId = id(world, "resident-");
    const work = chooseWorkplace(world, actualHome, jobs);
    if (!work)
      throw new Error("New residents need available commissioned jobs.");
    jobs.set(work.id, (jobs.get(work.id) ?? 0) + 1);
    const favorites: string[] = [];
    if (placeCandidates.length) {
      favorites.push(
        chooseLeisurePlace(world, actualHome, placeCandidates)!.id,
      );
      if (placeCandidates.length > 1 && random(world) < 0.35)
        favorites.push(
          chooseLeisurePlace(world, actualHome, placeCandidates)!.id,
        );
    }
    const departure =
      index === 0
        ? POPULATION_TIMING.firstDepartureAt + Math.floor(random(world) * 15)
        : POPULATION_TIMING.firstDepartureAt +
          index * POPULATION_TIMING.departureSpacing +
          Math.floor(random(world) * POPULATION_TIMING.departureJitter);

    const firstPlace =
      index % 4 === 2 && placeCandidates.length
        ? chooseLeisurePlace(world, actualHome, placeCandidates)!
        : work;
    residents.push({
      id: residentId,
      name: `${FAMILY_NAMES[cityIndex % FAMILY_NAMES.length]}${GIVEN_NAMES[Math.floor(cityIndex / FAMILY_NAMES.length) % GIVEN_NAMES.length]}`,
      color: RESIDENT_COLORS[index % RESIDENT_COLORS.length]!,
      homeId: actualHome.id,
      workId: work.id,
      favorites: distinct(favorites),
      atBuildingId: actualHome.id,
      nextDeparture: world.time + departure,
      nextDestinationId: firstPlace.id,
      purpose:
        firstPlace.kind === "office"
          ? "work"
          : firstPlace.kind === "shop"
            ? "shop"
            : "visit",
      status: "inside",
      journey: null,
      // Seconds of perceived time per fare unit.  It remains fixed after creation.
      fareSensitivity: 6 + Math.floor(random(world) * 15),
      trips: 0,
    });
  }
  return residents;
}

/**
 * Plans only after the simulation has completed an arrival.  It never changes
 * an in-progress journey, a walking resident, or an already scheduled intent.
 */
export function planNextActivity(world: World, resident: Resident): void {
  if (
    resident.journey ||
    resident.status !== "inside" ||
    !resident.atBuildingId ||
    resident.nextDeparture > world.time
  )
    return;
  const current = world.buildings.find(
    (building) => building.id === resident.atBuildingId,
  );
  if (!current) return;

  const offices = buildingsOf(world, "office").filter(
    (building) => building.id !== resident.workId,
  );
  if (offices.length && random(world) < 0.055) {
    const home = world.buildings.find(
      (building) => building.id === resident.homeId,
    );
    const nextWork = home
      ? chooseWorkplace(world, home, undefined, resident.workId)
      : null;
    if (nextWork) resident.workId = nextWork.id;
  }
  if (favoriteCandidates(world, resident).length && random(world) < 0.08)
    setFavorites(world, resident);

  const intent =
    chooseNextIntent(world, resident, current.id) ??
    fallbackDestination(resident, current.id);
  if (
    !intent ||
    !world.buildings.some((building) => building.id === intent.destinationId)
  )
    return;

  // `purpose` still describes the activity just reached.  Its dwell time must
  // be chosen before overwriting the field with the next intention.
  let departure = world.time + dwellSeconds(world, resident.purpose);
  if (current.kind === "office" || intent.purpose === "work") {
    const office =
      current.kind === "office"
        ? current
        : world.buildings.find(
            (building) => building.id === intent.destinationId,
          );
    departure = commuteDeparture(
      world,
      resident,
      office,
      departure,
      current.kind === "office",
    );
  }
  resident.nextDestinationId = intent.destinationId;
  resident.purpose = intent.purpose;
  resident.nextDeparture = departure;
}

/**
 * Compares whole door-to-door estimates supplied by the caller.  The fare is a
 * deliberately small personal time penalty; no random draw occurs here.
 */
export function chooseTravelMode(
  _world: World,
  resident: Resident,
  walkSeconds: number,
  podSeconds: number,
): "walk" | "pod" {
  if (!Number.isFinite(walkSeconds) || !Number.isFinite(podSeconds))
    return "walk";
  if (walkSeconds <= POPULATION_TIMING.shortWalkSeconds) return "walk";
  const podGeneralizedSeconds = podSeconds + FARE * resident.fareSensitivity;
  return podGeneralizedSeconds < walkSeconds ? "pod" : "walk";
}
