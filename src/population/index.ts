import { fareForDistance, fareRate } from "../economy";
import { RESIDENT_COLORS } from "../shared/constants";
import { id, random } from "../shared/math";
import type {
  Building,
  Occupation,
  Purpose,
  Resident,
  World,
} from "../shared/types";
import { availableJobSlots, jobCounts } from "../shared/development";
import {
  buildingsWithRoom,
  chooseLeisurePlace,
  chooseRoutinePlace,
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
  careStayMin: 25 * 60,
  careStayRange: 35 * 60,
  mealStayMin: 18 * 60,
  mealStayRange: 24 * 60,
  leisureStayMin: 20 * 60,
  leisureStayRange: 45 * 60,
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

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function favoriteCandidates(world: World, resident: Resident): Building[] {
  return world.buildings.filter(
    (building) =>
      building.id !== resident.homeId &&
      building.id !== resident.workId &&
      (building.kind === "shop" ||
        building.kind === "restaurant" ||
        building.kind === "park" ||
        building.kind === "home"),
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
  world: World,
  resident: Resident,
  currentId: string,
): { destinationId: string; purpose: Purpose } | null {
  if (currentId !== resident.homeId)
    return { destinationId: resident.homeId, purpose: "home" };
  if (
    currentId !== resident.workId &&
    world.buildings.some((building) => building.id === resident.workId)
  )
    return {
      destinationId: resident.workId,
      purpose: resident.occupation === "student" ? "study" : "work",
    };
  return null;
}

/** Local city time begins at 07:00 when a new game starts. */
export function cityHour(world: World): number {
  const day = 24 * 3600;
  return ((((world.time + 7 * 3600) % day) + day) % day) / 3600;
}

function stableHash(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function nextLocalTime(world: World, hour: number, jitterSeconds = 0): number {
  const day = 24 * 3600;
  const local = (((world.time + 7 * 3600) % day) + day) % day;
  const target = hour * 3600 + jitterSeconds;
  let delta = target - local;
  if (delta <= 0) delta += day;
  return world.time + delta;
}

function routineStartHour(
  world: World,
  resident: Pick<Resident, "id" | "workId" | "occupation">,
): number {
  const routine = world.buildings.find(
    (building) => building.id === resident.workId,
  );
  if (routine?.kind === "hospital") {
    const cohort = stableHash(resident.id) % 3;
    return [7, 15, 23][cohort]!;
  }
  if (resident.occupation === "teacher") return 7.25;
  if (resident.occupation === "student") return 7.75;
  if (resident.occupation === "service") return 8.5;
  return 8;
}

function nearRoutineStart(hour: number, start: number): boolean {
  const forward = (hour - start + 24) % 24;
  return forward < 1.25 || forward > 22.75;
}

function purposeForBuilding(
  building: Building,
  resident?: Pick<Resident, "occupation" | "workId" | "homeId">,
): Purpose {
  switch (building.kind) {
    case "office":
      return "work";
    case "school":
      return resident?.occupation === "student" ? "study" : "work";
    case "hospital":
      return resident?.workId === building.id ? "work" : "care";
    case "restaurant":
      return resident?.workId === building.id ? "work" : "meal";
    case "park":
      return "leisure";
    case "shop":
      return resident?.workId === building.id ? "work" : "shop";
    case "home":
      return building.id === resident?.homeId ? "home" : "visit";
  }
}

function chooseByKind(
  world: World,
  current: Building,
  kind: Building["kind"],
): Building | null {
  return chooseLeisurePlace(
    world,
    current,
    buildingsWithRoom(world, kind).filter(
      (building) => building.id !== current.id,
    ),
  );
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
    case "study":
      return POPULATION_TIMING.workStayMin;
    case "care":
      return (
        POPULATION_TIMING.careStayMin +
        Math.floor(random(world) * POPULATION_TIMING.careStayRange)
      );
    case "meal":
      return (
        POPULATION_TIMING.mealStayMin +
        Math.floor(random(world) * POPULATION_TIMING.mealStayRange)
      );
    case "leisure":
      return (
        POPULATION_TIMING.leisureStayMin +
        Math.floor(random(world) * POPULATION_TIMING.leisureStayRange)
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
  const current = world.buildings.find((building) => building.id === currentId);
  if (!current) return null;
  const hour = cityHour(world);
  const atHome = currentId === resident.homeId;
  const atRoutine = currentId === resident.workId;
  const startHour = routineStartHour(world, resident);
  const hospitalNightStart =
    atHome && startHour === 23 && hour >= 22.25 && hour < 24;

  // Except for hospital night staff, the city settles rather than generating
  // synthetic errands through the night.
  if ((hour >= 22 || hour < 6) && !hospitalNightStart) {
    if (atHome) return null;
    return { destinationId: resident.homeId, purpose: "home" };
  }

  if (atRoutine) {
    if (current.kind === "school") {
      if (
        (resident.occupation === "student" && hour < 14.5) ||
        (resident.occupation === "teacher" && hour < 15.5)
      )
        return { destinationId: resident.homeId, purpose: "home" };
    }
    if (current.kind === "hospital")
      return { destinationId: resident.homeId, purpose: "home" };
    if ((hour >= 11.25 && hour <= 13.5) || (hour >= 17.25 && hour <= 19.75)) {
      const restaurant = chooseByKind(world, current, "restaurant");
      if (restaurant && random(world) < 0.72)
        return { destinationId: restaurant.id, purpose: "meal" };
    }
  }

  if (atHome) {
    const routine = world.buildings.find(
      (building) => building.id === resident.workId,
    );
    const shouldStartRoutine = nearRoutineStart(hour, startHour);
    if (routine && shouldStartRoutine)
      return {
        destinationId: routine.id,
        purpose: purposeForBuilding(routine, resident),
      };

    if ((hour >= 11.25 && hour <= 13.5) || (hour >= 17.25 && hour <= 20)) {
      const restaurant = chooseByKind(world, current, "restaurant");
      if (restaurant && random(world) < 0.5)
        return { destinationId: restaurant.id, purpose: "meal" };
    }
    if (hour >= 9 && hour <= 16.5 && random(world) < 0.12) {
      const hospital = chooseByKind(world, current, "hospital");
      if (hospital) return { destinationId: hospital.id, purpose: "care" };
    }
    if (hour >= 9.5 && hour <= 21 && random(world) < 0.34) {
      const park = chooseByKind(world, current, "park");
      if (park) return { destinationId: park.id, purpose: "leisure" };
    }
  }

  const favorite = chooseFavoriteDestination(world, resident, currentId);
  const favoriteBuilding = world.buildings.find(
    (building) => building.id === favorite,
  );
  const favoritePurpose = favoriteBuilding
    ? purposeForBuilding(favoriteBuilding, resident)
    : "visit";
  if (atHome)
    return favorite && hour >= 9 && hour < 21 && random(world) < 0.25
      ? { destinationId: favorite, purpose: favoritePurpose }
      : null;
  const roll = random(world);
  if (atRoutine) {
    if (favorite && roll < 0.78)
      return { destinationId: favorite, purpose: favoritePurpose };
    return fallbackDestination(world, resident, currentId);
  }

  if (roll < 0.72) return fallbackDestination(world, resident, currentId);
  if (favorite && roll < 0.9)
    return { destinationId: favorite, purpose: favoritePurpose };
  return fallbackDestination(world, resident, currentId);
}

function routineAssignment(
  world: World,
  home: Building,
  cityIndex: number,
  counts: Map<string, number>,
): { occupation: Occupation; building: Building } | null {
  const hasCivicDestinations = world.buildings.some(
    (building) =>
      building.kind === "school" ||
      building.kind === "hospital" ||
      building.kind === "restaurant",
  );
  const roleCycle: Occupation[] = hasCivicDestinations
    ? [
        "student",
        "student",
        "student",
        "student",
        "teacher",
        "worker",
        "medic",
        "service",
      ]
    : ["worker"];
  const preferred = roleCycle[cityIndex % roleCycle.length]!;
  const alternatives = [
    preferred,
    "worker",
    "student",
    "teacher",
    "medic",
    "service",
  ].filter(
    (occupation, index, values): occupation is Occupation =>
      values.indexOf(occupation) === index,
  );
  for (const occupation of alternatives) {
    const building = chooseRoutinePlace(world, home, occupation, counts);
    if (building) return { occupation, building };
  }
  return null;
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

  if (count > availableJobSlots(world))
    throw new Error("New residents need available commissioned jobs.");
  const hasCivicDestinations = world.buildings.some(
    (building) =>
      building.kind === "school" ||
      building.kind === "hospital" ||
      building.kind === "restaurant" ||
      building.kind === "park",
  );
  const placeCandidates = world.buildings.filter(
    (building) =>
      building.id !== actualHome.id &&
      (building.kind === "shop" ||
        building.kind === "restaurant" ||
        building.kind === "park" ||
        building.kind === "home"),
  );
  const residents: Resident[] = [];
  const jobs = jobCounts(world);

  for (let index = 0; index < count; index += 1) {
    const cityIndex = world.residents.length + index;
    const residentId = id(world, "resident-");
    const assignment = routineAssignment(world, actualHome, cityIndex, jobs);
    if (!assignment)
      throw new Error("New residents need available commissioned jobs.");
    const work = assignment.building;
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
    const routineIdentity = {
      id: residentId,
      workId: work.id,
      occupation: assignment.occupation,
    };
    let departure =
      index === 0
        ? POPULATION_TIMING.firstDepartureAt + Math.floor(random(world) * 15)
        : POPULATION_TIMING.firstDepartureAt +
          index * POPULATION_TIMING.departureSpacing +
          Math.floor(random(world) * POPULATION_TIMING.departureJitter);
    if (
      !nearRoutineStart(
        cityHour(world),
        routineStartHour(world, routineIdentity),
      )
    )
      departure =
        nextLocalTime(
          world,
          routineStartHour(world, routineIdentity),
          stableHash(residentId) % (45 * 60),
        ) - world.time;

    const firstPlace =
      !hasCivicDestinations && index % 4 === 2 && placeCandidates.length
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
      purpose: purposeForBuilding(firstPlace, {
        workId: work.id,
        homeId: actualHome.id,
        occupation: assignment.occupation,
      }),
      status: "inside",
      journey: null,
      // Seconds of perceived time per fare unit.  It remains fixed after creation.
      fareSensitivity: 6 + Math.floor(random(world) * 15),
      trips: 0,
      occupation: assignment.occupation,
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

  const occupation = resident.occupation ?? "worker";
  resident.occupation ??= occupation;
  const alternateRoutine = world.buildings.some(
    (building) => building.id !== resident.workId,
  );
  if (alternateRoutine && random(world) < 0.055) {
    const home = world.buildings.find(
      (building) => building.id === resident.homeId,
    );
    const nextWork = home
      ? chooseRoutinePlace(world, home, occupation, undefined, resident.workId)
      : null;
    if (nextWork) resident.workId = nextWork.id;
  }
  if (favoriteCandidates(world, resident).length && random(world) < 0.08)
    setFavorites(world, resident);

  const selectedIntent = chooseNextIntent(world, resident, current.id);
  const intent =
    selectedIntent ??
    (current.id === resident.homeId
      ? null
      : fallbackDestination(world, resident, current.id));
  if (!intent && current.id === resident.homeId) {
    resident.nextDestinationId = resident.homeId;
    resident.purpose = "home";
    const hour = cityHour(world);
    if (hour >= 6 && hour < 22) {
      // Reconsider later needs without polling every tick or synchronizing homes.
      resident.nextDeparture =
        world.time + 30 * 60 + (stableHash(resident.id) % (30 * 60 + 1));
    } else {
      const jitter = stableHash(resident.id) % (45 * 60);
      resident.nextDeparture = nextLocalTime(
        world,
        routineStartHour(world, resident),
        jitter,
      );
    }
    return;
  }
  if (
    !intent ||
    !world.buildings.some((building) => building.id === intent.destinationId)
  )
    return;

  // `purpose` still describes the activity just reached.  Its dwell time must
  // be chosen before overwriting the field with the next intention.
  let departure = world.time + dwellSeconds(world, resident.purpose);
  if (current.kind === "school" && current.id === resident.workId) {
    const endHour = resident.occupation === "student" ? 14.5 : 15.5;
    if (cityHour(world) < endHour)
      departure = nextLocalTime(
        world,
        endHour,
        stableHash(resident.id) % (35 * 60),
      );
  } else if (
    current.kind === "hospital" &&
    current.id === resident.workId &&
    (resident.occupation === "medic" || resident.occupation === "service")
  ) {
    // Hospital workers share three durable shift cohorts without synchronizing.
    departure = world.time + 7 * 3600 + (stableHash(resident.id) % (50 * 60));
  }
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
 * Compatibility helper for older callers. Runtime departures use decideTravel;
 * this pure comparison uses the current rate and an optional physical distance.
 * Older callers without distance use a conservative quarter-kilometer estimate.
 */
export function chooseTravelMode(
  world: World,
  resident: Resident,
  walkSeconds: number,
  podSeconds: number,
  distanceKm = 0.25,
): "walk" | "pod" {
  if (!Number.isFinite(walkSeconds) || !Number.isFinite(podSeconds))
    return "walk";
  if (walkSeconds <= POPULATION_TIMING.shortWalkSeconds) return "walk";
  const fare = fareForDistance(distanceKm, fareRate(world));
  const podGeneralizedSeconds = podSeconds + fare * resident.fareSensitivity;
  return podGeneralizedSeconds < walkSeconds ? "pod" : "walk";
}
