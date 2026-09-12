import type {
  Berth,
  Building,
  Command,
  CommandResult,
  Journey,
  PendingEdit,
  Point,
  Resident,
  ServicePlan,
  Side,
  World,
} from "../shared/types";
import {
  ALIGHT_SECONDS,
  BOARD_SECONDS,
  CELL_METERS,
  MAX_PODS,
  PARKING_COST,
  PLATFORM_COST,
  POD_COST,
  POD_METERS_PER_SECOND,
  TRACK_UPGRADE_COST,
  WALK_METERS_PER_SECOND,
} from "../shared/constants";
import { distance, id, pathLength, pointKey, samePoint } from "../shared/math";
import {
  buildingDoor,
  corridorNodeResources,
  edgeKey,
  findTrackPath,
  findWalkPath,
  isBlocked,
  trackResources,
  validateTrackDraft,
} from "../network";
import { createResidents, planNextActivity } from "../population";
import { decideTravel } from "../population/choice";
import {
  accruePodMovement,
  book,
  createEconomy,
  fareForDistance,
  fareRate,
  loadedDistanceKm,
  money,
  repayLoan,
  takeLoan,
} from "../economy";
import { MIN_FARE_PER_KM, MAX_FARE_PER_KM } from "../economy/config";
import {
  commitPlan,
  planRelocation,
  planService,
  terminalOwner,
} from "../scheduler";
import {
  claimGrant,
  initialBuildings,
  initializeCityGrowth,
  recordDelivery,
  updateEconomy,
  updateGrowth,
} from "../city";
import {
  parkingEditAllowed,
  parkingPurchaseShortage,
  reachableIdlePods,
} from "./fleet";

function notice(
  world: World,
  text: string,
  textEn: string,
  kind: "info" | "success" | "warning" = "info",
) {
  world.notices.push({
    id: world.nextId++,
    time: world.time,
    text,
    textEn,
    kind,
  });
  world.notices = world.notices.slice(-8);
}
function result(
  ok: boolean,
  message: string,
  messageEn: string,
): CommandResult {
  return { ok, message, messageEn };
}

export function berthPlacement(
  world: World,
  building: Building,
  kind: Berth["kind"],
  side: Side,
): Omit<Berth, "id" | "paid"> | null {
  const horizontal = side === "north" || side === "south";
  const length = horizontal ? building.w : building.h;
  const offsets = Array.from({ length }, (_, i) => i).sort(
    (a, b) => Math.abs(a - (length - 1) / 2) - Math.abs(b - (length - 1) / 2),
  );
  for (const offset of offsets) {
    const dx = side === "west" ? -1 : side === "east" ? 1 : 0;
    const dy = side === "north" ? -1 : side === "south" ? 1 : 0;
    const p = horizontal
      ? {
          x: building.x + offset,
          y: side === "north" ? building.y - 1 : building.y + building.h,
        }
      : {
          x: side === "west" ? building.x - 1 : building.x + building.w,
          y: building.y + offset,
        };
    const access = { x: p.x + dx, y: p.y + dy };
    if (
      [p, access].some(
        (q) =>
          q.x < 1 ||
          q.y < 1 ||
          q.x >= world.width - 1 ||
          q.y >= world.height - 1 ||
          isBlocked(world, q),
      )
    )
      continue;
    if (
      world.berths.some(
        (b) =>
          samePoint(b.point, p) ||
          samePoint(b.point, access) ||
          samePoint(b.access, p),
      )
    )
      continue;
    if (world.tracks.some((t) => samePoint(t.a, p) || samePoint(t.b, p)))
      continue;
    return { buildingId: building.id, kind, point: p, access, side };
  }
  return null;
}

const sideOffsets: Record<Side, Point> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

function freeBerth(world: World, point: Point, access: Point): boolean {
  return (
    [point, access].every(
      (p) =>
        Number.isInteger(p.x) &&
        Number.isInteger(p.y) &&
        p.x >= 1 &&
        p.y >= 1 &&
        p.x < world.width - 1 &&
        p.y < world.height - 1 &&
        !isBlocked(world, p),
    ) &&
    !world.berths.some(
      (b) =>
        samePoint(b.point, point) ||
        samePoint(b.point, access) ||
        samePoint(b.access, point),
    ) &&
    !world.tracks.some((t) => samePoint(t.a, point) || samePoint(t.b, point))
  );
}

export function canPlaceBerth(world: World, point: Point, side: Side): boolean {
  const offset = sideOffsets[side];
  return (
    !!offset &&
    freeBerth(world, point, { x: point.x + offset.x, y: point.y + offset.y })
  );
}

/** Convenience placement near a platform, with separately priced connecting
 * track. The completed parking bay has no station or building owner. */
export function parkingPlacement(world: World, platform: Berth, side: Side) {
  if (platform.kind !== "platform" || !sideOffsets[side]) return null;
  const outward = sideOffsets[side];
  const candidates: Point[] = [];
  for (let radius = 1; radius <= 6; radius++)
    for (let offset = -(radius - 1); offset <= radius - 1; offset++)
      candidates.push({
        x: platform.access.x + outward.x * radius - outward.y * offset,
        y: platform.access.y + outward.y * radius + outward.x * offset,
      });
  for (const point of candidates) {
    const access = { x: point.x - outward.x, y: point.y - outward.y };
    if (!freeBerth(world, point, access)) continue;
    // Cardinal BFS stays within the station yard and cannot pass through a bay.
    const queue: Point[][] = [[access]];
    const seen = new Set([pointKey(access)]);
    let path: Point[] | undefined;
    for (let i = 0; i < queue.length && !path; i++) {
      const route = queue[i],
        last = route.at(-1)!;
      if (samePoint(last, platform.access)) {
        path = route;
        break;
      }
      for (const delta of Object.values(sideOffsets)) {
        const next = { x: last.x + delta.x, y: last.y + delta.y };
        if (
          seen.has(pointKey(next)) ||
          distance(next, platform.access) > 8 ||
          next.x < 1 ||
          next.y < 1 ||
          next.x >= world.width - 1 ||
          next.y >= world.height - 1 ||
          isBlocked(world, next) ||
          samePoint(next, point) ||
          world.berths.some((b) => samePoint(b.point, next))
        )
          continue;
        seen.add(pointKey(next));
        queue.push([...route, next]);
      }
    }
    if (!path) continue;
    const draft =
      path.length === 1
        ? { edges: [], cost: 0, error: undefined }
        : validateTrackDraft(world, path);
    if (draft.error) continue;
    return {
      berth: {
        kind: "parking" as const,
        point,
        access,
        side,
      },
      tracks: draft.edges,
      trackCost: draft.cost,
    };
  }
  return null;
}

export function createWorld(seed = 7): World {
  const world: World = {
    version: 2,
    seed,
    rng: seed >>> 0 || 7,
    time: 0,
    paused: true,
    speed: 1,
    width: 64,
    height: 44,
    nextId: 1,
    networkVersion: 0,
    buildings: initialBuildings(),
    berths: [],
    tracks: [],
    residents: [],
    pods: [],
    reservations: [],
    economy: createEconomy(),
    metrics: {
      served: 0,
      walked: 0,
      savedSeconds: 0,
      totalWait: 0,
      recentTrips: [],
    },
    growth: {
      model: 2,
      nextKind: "expansion",
      wave: 0,
      nextAt: 3600,
      announced: false,
      enabled: true,
      complete: false,
    },
    notices: [],
    pendingEdits: [],
  };
  const home = world.buildings.find((b) => b.kind === "home")!;
  for (const side of ["north", "north", "north", "north", "west"] as Side[]) {
    const place = berthPlacement(world, home, "parking", side);
    if (place)
      world.berths.push({ ...place, id: id(world, "berth-"), paid: 0 });
  }
  const platform = berthPlacement(world, home, "platform", "west");
  if (platform)
    world.berths.push({ ...platform, id: id(world, "berth-"), paid: 0 });
  for (const berth of world.berths.filter((b) => b.kind === "parking")) {
    delete berth.buildingId;
  }
  // A visible, finite starter yard. No inter-building track is prebuilt.
  const accesses = world.berths.map((b) => b.access);
  const minX = Math.min(...accesses.map((p) => p.x));
  const minY = Math.min(...accesses.map((p) => p.y));
  for (const p of accesses) {
    const draft = validateTrackDraft(world, [
      { x: minX, y: minY },
      { x: p.x, y: minY },
      p,
    ]);
    for (const edge of draft.edges)
      if (!world.tracks.some((t) => t.id === edge.id))
        world.tracks.push({ ...edge, paid: 0 });
  }
  world.berths
    .filter((b) => b.kind === "parking")
    .slice(0, 4)
    .forEach((berth) =>
      world.pods.push({
        id: id(world, "pod-"),
        berthId: berth.id,
        parkedSince: 0,
        plan: null,
        trips: 0,
        paid: 0,
      }),
    );
  world.residents.push(...createResidents(world, home, 24));
  initializeCityGrowth(world);
  world.networkVersion++;
  notice(
    world,
    "从一位居民的旅程开始。为办公楼加平台，再把它接到住宅小站。",
    "Begin with one resident. Add an office platform and connect it to the home station.",
  );
  return world;
}

function walkDuration(path: Point[]) {
  return Math.max(1, (pathLength(path) * CELL_METERS) / WALK_METERS_PER_SECOND);
}

/** Bound route-pair work to three walk-reachable stations at each end. */
function stationCandidates(world: World, building: Building) {
  const door = buildingDoor(building);
  const ordered = world.berths
    .filter(
      (b) =>
        b.kind === "platform" &&
        !world.pendingEdits.some((edit) => edit.id === b.id),
    )
    .sort(
      (a, b) =>
        (a.buildingId === building.id ? -1 : distance(a.point, door)) -
        (b.buildingId === building.id ? -1 : distance(b.point, door)),
    );
  const candidates: { berth: Berth; path: Point[]; seconds: number }[] = [];
  for (const berth of ordered) {
    if (berth.buildingId === building.id)
      candidates.push({ berth, path: [], seconds: 0 });
    else {
      const path = findWalkPath(world, door, berth.point);
      if (path) candidates.push({ berth, path, seconds: walkDuration(path) });
    }
    if (candidates.length === 3) break;
  }
  return candidates;
}
function beginJourney(world: World, resident: Resident) {
  const origin = world.buildings.find((b) => b.id === resident.atBuildingId);
  const destination = world.buildings.find(
    (b) => b.id === resident.nextDestinationId,
  );
  if (!origin || !destination || origin.id === destination.id) {
    planNextActivity(world, resident);
    return;
  }
  const direct = findWalkPath(
    world,
    buildingDoor(origin),
    buildingDoor(destination),
  );
  if (!direct) {
    resident.nextDeparture = world.time + 60;
    return;
  }
  const baseline = walkDuration(direct);
  let best: {
    pickup: Berth;
    dropoff: Berth;
    estimate: number;
    waitSeconds: number;
    rideSeconds: number;
    distanceKm: number;
    score: number;
    accessPath: Point[];
    accessSeconds: number;
  } | null = null;
  let unavailable: "no-platform" | "disconnected" | "no-pod" = "no-platform";
  const pickups = stationCandidates(world, origin);
  const dropoffs = stationCandidates(world, destination);
  for (const access of pickups) {
    const pickup = access.berth;
    for (const egress of dropoffs) {
      const dropoff = egress.berth;
      if (pickup.id === dropoff.id) continue;
      const route = findTrackPath(world, pickup.point, dropoff.point);
      if (unavailable === "no-platform") unavailable = "disconnected";
      if (!route) continue;
      unavailable = "no-pod";
      let emptySeconds = Infinity;
      for (const pod of world.pods) {
        const source = world.berths.find(
          (b) => b.id === (pod.plan?.finalBerthId ?? pod.berthId),
        );
        if (!source) continue;
        const approach = findTrackPath(world, source.point, pickup.point);
        if (approach)
          emptySeconds = Math.min(
            emptySeconds,
            Math.max(0, (pod.plan?.end ?? world.time) - world.time) +
              (pathLength(approach) * CELL_METERS) / POD_METERS_PER_SECOND,
          );
      }
      if (!Number.isFinite(emptySeconds)) continue;
      const distanceKm = (pathLength(route) * CELL_METERS) / 1000;
      const rideSeconds = (distanceKm * 1000) / POD_METERS_PER_SECOND;
      const queued = world.residents.filter(
        (r) =>
          r.status === "waiting" &&
          r.journey?.pickupId === pickup.id &&
          !r.journey.podId,
      ).length;
      const waitSeconds =
        emptySeconds +
        (queued * (rideSeconds + BOARD_SECONDS + ALIGHT_SECONDS)) /
          Math.max(1, world.pods.length);
      const estimate =
        access.seconds +
        egress.seconds +
        waitSeconds +
        BOARD_SECONDS +
        ALIGHT_SECONDS +
        rideSeconds;
      const score =
        estimate +
        fareForDistance(distanceKm, fareRate(world)) * resident.fareSensitivity;
      if (!best || score < best.score)
        best = {
          pickup,
          dropoff,
          estimate,
          waitSeconds,
          rideSeconds,
          distanceKm,
          score,
          accessPath: access.path,
          accessSeconds: access.seconds,
        };
    }
  }
  resident.decision = decideTravel(
    world,
    resident,
    baseline,
    best
      ? {
          podSeconds: best.estimate,
          waitSeconds: best.waitSeconds,
          rideSeconds: best.rideSeconds,
          distanceKm: best.distanceKm,
        }
      : null,
    unavailable,
  );
  resident.decision.destinationId = destination.id;
  const usePod = resident.decision.mode === "pod";
  const journey: Journey = {
    originId: origin.id,
    destinationId: destination.id,
    startedAt: world.time,
    walkBaseline: baseline,
    purpose: resident.purpose,
    mode: usePod ? "pod" : "walk",
    stage: usePod ? "queue" : "direct",
  };
  if (usePod && best) {
    journey.pickupId = best.pickup.id;
    journey.dropoffId = best.dropoff.id;
    journey.farePerKm = fareRate(world);
    journey.waitReason = "no-pod";
    journey.eta = world.time + best.estimate;
    if (best.accessSeconds > 0) {
      journey.stage = "access";
      journey.walk = {
        path: best.accessPath,
        start: world.time,
        end: world.time + best.accessSeconds,
      };
      journey.waitReason = undefined;
    }
  } else {
    journey.walk = {
      path: direct,
      start: world.time,
      end: world.time + baseline,
    };
    journey.eta = journey.walk.end;
  }
  resident.atBuildingId = null;
  resident.status = usePod && journey.stage === "queue" ? "waiting" : "walking";
  resident.journey = journey;
}

function finishJourney(world: World, resident: Resident) {
  const journey = resident.journey;
  if (!journey) return;
  recordDelivery(world, {
    residentId: resident.id,
    originId: journey.originId,
    destinationId: journey.destinationId,
    mode: journey.mode,
    startedAt: journey.startedAt,
    endedAt: world.time,
    walkBaseline: journey.walkBaseline,
    waited: Math.max(0, (journey as Journey & { waited?: number }).waited ?? 0),
    distanceKm: journey.distanceKm,
    farePerKm: journey.farePerKm,
  });
  resident.atBuildingId = journey.destinationId;
  resident.journey = null;
  resident.status = "inside";
  resident.trips++;
  planNextActivity(world, resident);
}

function updatePods(world: World, dt: number) {
  for (const pod of world.pods) {
    const plan = pod.plan;
    if (!plan) continue;
    accruePodMovement(world, plan, world.time - dt, world.time);
    if (world.time >= plan.departure) pod.berthId = null;
    const resident = plan.residentId
      ? world.residents.find((r) => r.id === plan.residentId)
      : undefined;
    if (resident?.journey && resident.journey.podId === pod.id) {
      const journey = resident.journey;
      if (
        plan.dropoffEnd !== undefined &&
        world.time >= plan.dropoffEnd &&
        journey.stage !== "egress"
      ) {
        journey.distanceKm = loadedDistanceKm(plan);
        const destination = world.buildings.find(
          (b) => b.id === journey.destinationId,
        )!;
        const dropoff = world.berths.find((b) => b.id === journey.dropoffId)!;
        if (dropoff.buildingId === destination.id)
          finishJourney(world, resident);
        else {
          const path =
            journey.egressPath ??
            findWalkPath(world, dropoff.point, buildingDoor(destination));
          if (path) {
            journey.stage = "egress";
            journey.podId = undefined;
            journey.walk = {
              path,
              start: world.time,
              end: world.time + walkDuration(path),
            };
            journey.eta = journey.walk.end;
            resident.status = "walking";
          }
        }
      } else if (journey.stage !== "egress") {
        if (plan.dropoffStart !== undefined && world.time >= plan.dropoffStart)
          resident.status = "alighting";
        else if (plan.pickupEnd !== undefined && world.time >= plan.pickupEnd) {
          resident.status = "riding";
          journey.stage = "onboard";
        } else if (
          plan.pickupStart !== undefined &&
          world.time >= plan.pickupStart
        ) {
          resident.status = "boarding";
          journey.stage = "onboard";
          journey.waitReason = undefined;
        }
      }
    }
    if (world.time >= plan.end) {
      pod.berthId = plan.finalBerthId;
      pod.parkedSince = plan.end;
      pod.plan = null;
      if (plan.residentId) pod.trips++;
    }
  }
}

function fallbackWalk(world: World, resident: Resident) {
  const journey = resident.journey;
  if (!journey || journey.podId) return;
  const source =
    world.berths.find((b) => b.id === journey.pickupId)?.point ??
    journey.walk?.path.at(-1);
  const destination = world.buildings.find(
    (b) => b.id === journey.destinationId,
  );
  if (!source || !destination) return;
  const path = findWalkPath(world, source, buildingDoor(destination));
  if (!path) return;
  journey.mode = "walk";
  journey.stage = "direct";
  journey.walk = {
    path,
    start: world.time,
    end: world.time + walkDuration(path),
  };
  journey.eta = journey.walk.end;
  journey.waitReason = undefined;
  resident.status = "walking";
  if (resident.decision)
    resident.decision = {
      ...resident.decision,
      mode: "walk",
      reason: "wait-abandoned",
    };
}

function planUsesTrack(
  plan: ServicePlan,
  track: World["tracks"][number],
): boolean {
  const key = edgeKey(track.a, track.b);
  return plan.segments.some(
    (segment) =>
      segment.kind === "move" && edgeKey(segment.from, segment.to) === key,
  );
}

function planTouchesPoint(plan: ServicePlan, point: Point): boolean {
  return plan.segments.some(
    (segment) => samePoint(segment.from, point) || samePoint(segment.to, point),
  );
}

function planTouchesTrackEndpoint(
  plan: ServicePlan,
  track: World["tracks"][number],
): boolean {
  return planTouchesPoint(plan, track.a) || planTouchesPoint(plan, track.b);
}

function sameResources(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((resource) => right.includes(resource))
  );
}

function topologyChangeTouchesActivePlan(
  world: World,
  candidate: World,
  points: Point[],
): boolean {
  const changed = points.filter(
    (point, index) =>
      points.findIndex((entry) => samePoint(entry, point)) === index &&
      !sameResources(
        corridorNodeResources(world, point),
        corridorNodeResources(candidate, point),
      ),
  );
  return world.pods.some(
    (pod) =>
      pod.plan && changed.some((point) => planTouchesPoint(pod.plan!, point)),
  );
}

function touchesPending(world: World, plan: ServicePlan) {
  return world.pendingEdits.some((edit) => {
    if (edit.type === "remove-track" || edit.type === "upgrade-track") {
      const track = world.tracks.find((t) => t.id === edit.id);
      if (!track) return false;
      const resources = new Set(trackResources(world, track));
      return (
        plan.reservations.some((reservation) =>
          resources.has(reservation.resource),
        ) ||
        (edit.type === "remove-track" && planTouchesTrackEndpoint(plan, track))
      );
    }
    return [
      plan.originBerthId,
      plan.finalBerthId,
      plan.pickupId,
      plan.dropoffId,
    ].includes(edit.id);
  });
}

function relocateBlocked(world: World, berthId: string) {
  const owner = terminalOwner(world, berthId);
  const pod = world.pods.find((p) => p.id === owner && !p.plan);
  if (!pod) return false;
  const source = world.berths.find((b) => b.id === berthId);
  const options = world.berths
    .filter(
      (b) =>
        b.kind === "parking" &&
        b.id !== berthId &&
        !terminalOwner(world, b.id) &&
        !world.pendingEdits.some((edit) => edit.id === b.id),
    )
    .sort(
      (a, b) =>
        (a.kind === "parking" ? -100 : 0) +
        distance(a.point, source!.point) -
        ((b.kind === "parking" ? -100 : 0) + distance(b.point, source!.point)),
    );
  for (const target of options) {
    const candidate = planRelocation(world, pod, target);
    if (candidate.ok && !touchesPending(world, candidate.plan)) {
      commitPlan(world, candidate.plan);
      return true;
    }
  }
  return false;
}

function dispatch(world: World) {
  const waiting = world.residents
    .filter((r) => r.status === "waiting" && r.journey && !r.journey.podId)
    .sort(
      (a, b) =>
        a.journey!.startedAt - b.journey!.startedAt || a.id.localeCompare(b.id),
    );
  for (const resident of waiting) {
    const journey = resident.journey!;
    if (
      world.time - (journey.walk?.end ?? journey.startedAt) >
      Math.max(180, journey.walkBaseline * 0.65)
    ) {
      fallbackWalk(world, resident);
      continue;
    }
    const pickup = world.berths.find((b) => b.id === journey.pickupId);
    if (!pickup) {
      fallbackWalk(world, resident);
      continue;
    }
    const destination = world.buildings.find(
      (b) => b.id === journey.destinationId,
    )!;
    const stationOptions = stationCandidates(world, destination).filter(
      (entry) => entry.berth.id !== pickup.id,
    );
    const dropoffs = stationOptions.map((entry) => entry.berth);
    const egressSeconds = new Map(
      stationOptions.map((entry) => [entry.berth.id, entry.seconds]),
    );
    const loadedSeconds = new Map(
      dropoffs.map((dropoff) => {
        const path = findTrackPath(world, pickup.point, dropoff.point);
        return [
          dropoff.id,
          path
            ? (pathLength(path) * CELL_METERS) / POD_METERS_PER_SECOND +
              egressSeconds.get(dropoff.id)!
            : Infinity,
        ] as const;
      }),
    );
    const minimumLoaded = Math.min(...loadedSeconds.values());
    let best: ServicePlan | null = null;
    let reason: NonNullable<Journey["waitReason"]> = "no-pod";
    // Never let six geometrically nearby but unreachable vehicles hide the
    // seventh usable one. A failed station also must not mask another's queue.
    for (let attempt = 0; attempt < 2 && !best; attempt++) {
      const failures = new Set<NonNullable<Journey["waitReason"]>>();
      const idle = reachableIdlePods(world, pickup);
      for (const pod of idle) {
        const origin = world.berths.find((b) => b.id === pod.berthId)!;
        const emptyPath = findTrackPath(world, origin.point, pickup.point)!;
        const earliestBoardEnd =
          world.time +
          (pathLength(emptyPath) * CELL_METERS) / POD_METERS_PER_SECOND +
          BOARD_SECONDS;
        // Sorted reachable candidates may only be skipped once even an empty
        // calendar cannot beat the incumbent. This is a bound, never a cap.
        if (
          best &&
          earliestBoardEnd + minimumLoaded + ALIGHT_SECONDS >=
            best.dropoffEnd! + egressSeconds.get(best.dropoffId!)! - 1e-9
        )
          break;
        for (const dropoff of dropoffs) {
          if (
            best &&
            earliestBoardEnd +
              loadedSeconds.get(dropoff.id)! +
              ALIGHT_SECONDS >=
              best.dropoffEnd! + egressSeconds.get(best.dropoffId!)! - 1e-9
          )
            continue;
          const candidate = planService(world, pod, resident, pickup, dropoff);
          if (!candidate.ok) {
            failures.add(candidate.reason);
            continue;
          }
          if (touchesPending(world, candidate.plan)) {
            failures.add("track-busy");
            continue;
          }
          if (
            !best ||
            candidate.plan.dropoffEnd! + egressSeconds.get(dropoff.id)! <
              best.dropoffEnd! + egressSeconds.get(best.dropoffId!)!
          )
            best = candidate.plan;
        }
      }
      reason =
        (
          [
            "parking-full",
            "platform-busy",
            "track-busy",
            "disconnected",
            "no-pod",
          ] as const
        ).find((value) => failures.has(value)) ?? "no-pod";
      if (best || attempt === 1) break;
      let cleared = false;
      // Clear both ends independently of the last failed candidate's reason.
      for (const berth of [pickup, ...dropoffs])
        cleared = relocateBlocked(world, berth.id) || cleared;
      if (!cleared) break;
    }
    if (best) {
      commitPlan(world, best);
      journey.podId = best.podId;
      journey.dropoffId = best.dropoffId;
      const egress = stationOptions.find(
        (entry) => entry.berth.id === best.dropoffId,
      )!;
      journey.egressPath =
        egress.seconds > 0 ? [...egress.path].reverse() : undefined;
      journey.eta = best.dropoffEnd! + egressSeconds.get(best.dropoffId!)!;
      journey.distanceKm = loadedDistanceKm(best);
      journey.waitReason = "awaiting-pickup";
      (journey as Journey & { waited?: number }).waited = Math.max(
        0,
        best.pickupStart! - (journey.walk?.end ?? journey.startedAt),
      );
    } else {
      journey.waitReason = reason;
      journey.eta = undefined;
    }
  }
  // Older saves may contain idle platform residents. Let them leave physically,
  // without teleporting or deleting vehicles, even when nobody is calling here.
  for (const berth of world.berths.filter((b) => b.kind === "platform")) {
    const occupant = world.pods.find((p) => p.berthId === berth.id && !p.plan);
    if (occupant && world.time - occupant.parkedSince >= 6)
      relocateBlocked(world, berth.id);
  }
}

export function capacityValid(world: World): boolean {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let x = key;
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const join = (a: Point, b: Point) =>
    parent.set(root(pointKey(a)), root(pointKey(b)));
  world.tracks.forEach((t) => join(t.a, t.b));
  world.berths.forEach((b) => join(b.point, b.access));
  const counts = new Map<string, { berths: number; pods: number }>();
  for (const berth of world.berths) {
    const key = root(pointKey(berth.point));
    const c = counts.get(key) ?? { berths: 0, pods: 0 };
    c.berths++;
    counts.set(key, c);
  }
  for (const pod of world.pods) {
    const berth = world.berths.find(
      (b) => b.id === (pod.plan?.finalBerthId ?? pod.berthId),
    );
    if (!berth) return false;
    const c = counts.get(root(pointKey(berth.point)));
    if (!c) return false;
    c.pods++;
  }
  return [...counts.values()].every((c) => c.berths >= c.pods);
}

function editBusy(world: World, edit: PendingEdit): boolean {
  if (edit.type === "remove-track" || edit.type === "upgrade-track") {
    const track = world.tracks.find((t) => t.id === edit.id);
    if (!track) return false;
    const resources = trackResources(world, track);
    return (
      world.reservations.some(
        (r) => r.end > world.time && resources.includes(r.resource),
      ) ||
      world.pods.some(
        (p) =>
          p.plan &&
          (planUsesTrack(p.plan, track) ||
            (edit.type === "remove-track" &&
              planTouchesTrackEndpoint(p.plan, track))),
      )
    );
  }
  return (
    world.pods.some(
      (p) =>
        p.berthId === edit.id ||
        (p.plan &&
          [
            p.plan.originBerthId,
            p.plan.finalBerthId,
            p.plan.pickupId,
            p.plan.dropoffId,
          ].includes(edit.id)),
    ) ||
    world.residents.some(
      (r) =>
        r.journey &&
        [r.journey.pickupId, r.journey.dropoffId].includes(edit.id),
    )
  );
}

function executeEdit(world: World, edit: PendingEdit): CommandResult {
  if (edit.type === "remove-track") {
    const track = world.tracks.find((t) => t.id === edit.id);
    if (!track)
      return result(false, "轨道已经不存在。", "Track no longer exists.");
    const candidate = {
      ...world,
      tracks: world.tracks.filter((t) => t.id !== edit.id),
    };
    if (!capacityValid(candidate) || !parkingEditAllowed(world, candidate))
      return result(
        false,
        "拆除后有车无法获得周转空位，请先补停车位或连接。",
        "Add parking or a connection before splitting this network.",
      );
    world.tracks = candidate.tracks;
    book(world, "refund", track.paid);
  } else if (edit.type === "upgrade-track") {
    const track = world.tracks.find((t) => t.id === edit.id);
    const target = edit.targetLanes ?? 2;
    if (!track || (track.lanes ?? 1) >= target)
      return result(
        false,
        "轨道无法升级。",
        "Track can no longer be upgraded.",
      );
    track.lanes = target;
    track.paid += edit.paid;
  } else {
    const berth = world.berths.find((b) => b.id === edit.id);
    if (!berth)
      return result(false, "泊位已经不存在。", "Berth no longer exists.");
    const candidate = {
      ...world,
      berths: world.berths.filter((b) => b.id !== edit.id),
    };
    if (edit.type === "move-berth") {
      const building = world.buildings.find((b) => b.id === berth.buildingId);
      if (!building || berth.kind === "parking")
        return result(
          false,
          "请拆除后在新位置重建。",
          "Remove and rebuild this berth at its new location.",
        );
      const placement = berthPlacement(
        candidate,
        building,
        berth.kind,
        edit.side,
      );
      if (!placement)
        return result(
          false,
          "这一侧没有足够空间。",
          "Not enough room on this side.",
        );
      candidate.berths.push({ ...berth, ...placement });
    }
    if (!capacityValid(candidate) || !parkingEditAllowed(world, candidate))
      return result(
        false,
        "请为车辆保留足够的停车与周转空间。",
        "Keep a reachable parking bay for every Pod.",
      );
    world.berths = candidate.berths;
    if (edit.type === "remove-berth") book(world, "refund", berth.paid);
  }
  world.reservations = world.reservations.filter((r) => r.end > world.time);
  world.networkVersion++;
  return result(
    true,
    "改造完成，已结算退款。",
    "Edit complete; refund settled.",
  );
}

function processPending(world: World) {
  for (const edit of [...world.pendingEdits]) {
    if (edit.type === "remove-berth" || edit.type === "move-berth")
      for (const r of world.residents)
        if (
          r.status === "waiting" &&
          !r.journey?.podId &&
          [r.journey?.pickupId, r.journey?.dropoffId].includes(edit.id)
        )
          fallbackWalk(world, r);
    if (editBusy(world, edit)) {
      if (edit.type === "remove-berth" || edit.type === "move-berth") {
        const pod = world.pods.find((p) => p.berthId === edit.id && !p.plan);
        if (pod) {
          for (const target of world.berths.filter(
            (b) => b.id !== edit.id && !terminalOwner(world, b.id),
          )) {
            const plan = planRelocation(world, pod, target);
            if (plan.ok && !touchesPending(world, plan.plan)) {
              commitPlan(world, plan.plan);
              break;
            }
          }
        }
      }
      continue;
    }
    const outcome = executeEdit(world, edit);
    if (!outcome.ok && edit.type === "upgrade-track")
      book(world, "refund", edit.paid);
    world.pendingEdits = world.pendingEdits.filter((e) => e !== edit);
    notice(
      world,
      outcome.message,
      outcome.messageEn,
      outcome.ok ? "success" : "warning",
    );
  }
}

export function stepWorld(world: World, seconds: number): void {
  if (world.paused || !Number.isFinite(seconds) || seconds <= 0) return;
  const end = world.time + seconds;
  while (world.time < end) {
    const dt = Math.min(1, end - world.time);
    world.time += dt;
    updatePods(world, dt);
    for (const resident of world.residents) {
      if (resident.status === "inside" && resident.nextDeparture <= world.time)
        beginJourney(world, resident);
      const journey = resident.journey;
      if (
        resident.status === "walking" &&
        journey?.walk &&
        world.time >= journey.walk.end
      ) {
        if (journey.stage === "access") {
          journey.stage = "queue";
          resident.status = "waiting";
          journey.waitReason = "no-pod";
        } else finishJourney(world, resident);
      }
    }
    if (Math.floor(world.time) % 3 === 0) dispatch(world);
    processPending(world);
    updateEconomy(world, dt);
    updateGrowth(world);
    if (Math.floor(world.time) % 30 === 0)
      world.reservations = world.reservations.filter(
        (r) => r.end > world.time - 30,
      );
  }
}

export function applyCommand(world: World, command: Command): CommandResult {
  if (command.type === "set-fare") {
    if (
      !Number.isFinite(command.value) ||
      command.value < MIN_FARE_PER_KM ||
      command.value > MAX_FARE_PER_KM
    )
      return result(
        false,
        "每公里价格须在 2–60 之间。",
        "Price per km must be between 2 and 60.",
      );
    world.economy.farePerKm = money(command.value);
    return result(
      true,
      `后续出行按 ${world.economy.farePerKm}/公里计费。`,
      `New trips cost ${world.economy.farePerKm}/km.`,
    );
  }
  if (command.type === "take-loan") {
    const ok = takeLoan(world);
    return result(
      ok,
      ok
        ? "贷款 5000 已到账；每 24 小时偿还本金并结息。"
        : "领完 3 次补助后可贷款，已有贷款须先结清。",
      ok
        ? "Loan of 5,000 received; installments and interest every 24 hours."
        : "Claim all 3 grants and settle any existing loan first.",
    );
  }
  if (command.type === "repay-loan") {
    const ok = repayLoan(world);
    return result(
      ok,
      ok ? "贷款已结清。" : "没有未结清贷款，或现金不足以还清本金。",
      ok
        ? "Loan repaid in full."
        : "No outstanding loan, or insufficient cash to repay it.",
    );
  }
  if (command.type === "claim-grant") {
    const amount = claimGrant(world);
    return result(
      amount > 0,
      amount > 0 ? `已领取补助 +${amount}。` : "暂无可领取的补助。",
      amount > 0 ? `Grant claimed: +${amount}.` : "No grant is ready to claim.",
    );
  }
  if (command.type === "pause" || command.type === "toggle-pause") {
    // Toggle the authoritative state, not a potentially stale UI snapshot.
    world.paused =
      command.type === "toggle-pause" ? !world.paused : command.value;
    return result(
      true,
      world.paused ? "已暂停，可继续设计。" : "城市开始运行。",
      world.paused ? "Paused. Keep designing." : "City running.",
    );
  }
  if (command.type === "speed") {
    if (![1, 2, 4].includes(command.value))
      return result(false, "无效速度。", "Invalid speed.");
    world.speed = command.value;
    return result(true, `${command.value} 倍速`, `${command.value}× speed`);
  }
  if (command.type === "growth") {
    world.growth.enabled = command.value;
    return result(
      true,
      command.value ? "城市增长已开启。" : "城市增长已暂缓。",
      command.value ? "City growth enabled." : "City growth deferred.",
    );
  }
  if (command.type === "cancel-edits") {
    book(
      world,
      "refund",
      world.pendingEdits.reduce(
        (sum, edit) => sum + (edit.type === "upgrade-track" ? edit.paid : 0),
        0,
      ),
    );
    world.pendingEdits = [];
    return result(true, "已取消待执行改造。", "Pending edits cancelled.");
  }
  if (command.type === "reset")
    return result(
      false,
      "请通过运行管理器新建城市。",
      "Start a new city through the runtime.",
    );
  if (command.type === "build-track") {
    const draft = validateTrackDraft(world, command.points);
    if (draft.error)
      return result(false, draft.error, draft.errorEn ?? "Invalid route.");
    if (!draft.edges.length)
      return result(false, "这里已经有轨道。", "This track already exists.");
    if (world.economy.cash < draft.cost)
      return result(
        false,
        "预算不足；可以改短路线，或在补助可用后手动领取。",
        "Not enough budget. Shorten the route or claim a grant when ready.",
      );
    const candidate = { ...world, tracks: [...world.tracks, ...draft.edges] };
    if (
      topologyChangeTouchesActivePlan(
        world,
        candidate,
        draft.edges.flatMap((track) => [track.a, track.b]),
      )
    )
      return result(
        false,
        "此处有车辆计划正在通过，请等待排空后再施工。",
        "An active journey uses this junction. Wait for it to clear before building.",
      );
    world.tracks.push(...draft.edges);
    book(world, "track-build", -draft.cost);
    world.networkVersion++;
    return result(
      true,
      `已铺设 ${draft.edges.length} 段轨道。`,
      `Built ${draft.edges.length} track sections.`,
    );
  }
  if (
    command.type === "add-berth" ||
    command.type === "add-platform" ||
    command.type === "add-parking"
  ) {
    if (!["north", "east", "south", "west"].includes(command.side))
      return result(false, "无效方向。", "Invalid side.");
    const kind =
      command.type === "add-parking"
        ? "parking"
        : command.type === "add-platform"
          ? "platform"
          : command.kind;
    const building =
      command.type !== "add-parking"
        ? world.buildings.find((b) => b.id === command.buildingId)
        : undefined;
    if (command.type === "add-berth" && !building)
      return result(false, "建筑已经不存在。", "Building no longer exists.");
    const platform =
      kind === "parking"
        ? world.berths.find(
            (b) =>
              b.kind === "platform" &&
              (command.type === "add-parking"
                ? "nearPlatformId" in command && b.id === command.nearPlatformId
                : b.buildingId === building?.id),
          )
        : undefined;
    if (
      kind === "parking" &&
      command.type === "add-parking" &&
      "nearPlatformId" in command &&
      (!platform || world.pendingEdits.some((edit) => edit.id === platform.id))
    )
      return result(
        false,
        "请先选择一个可用的乘客平台。",
        "Select an available passenger platform first.",
      );
    const parking = platform
      ? parkingPlacement(world, platform, command.side)
      : null;
    let place: Omit<Berth, "id" | "paid"> | null = parking?.berth ?? null;
    if (
      kind === "parking" &&
      command.type === "add-parking" &&
      "point" in command
    ) {
      const offset = sideOffsets[command.side];
      const access = {
        x: command.point.x + offset.x,
        y: command.point.y + offset.y,
      };
      if (freeBerth(world, command.point, access))
        place = {
          kind,
          point: { ...command.point },
          access,
          side: command.side,
        };
    } else if (kind === "parking" && building && !platform) {
      place = berthPlacement(world, building, kind, command.side);
      if (place) delete place.buildingId;
    } else if (kind === "platform") {
      if (building)
        place = berthPlacement(world, building, "platform", command.side);
      else if (
        command.type === "add-platform" &&
        !command.buildingId &&
        command.point
      ) {
        const offset = sideOffsets[command.side];
        const access = {
          x: command.point.x + offset.x,
          y: command.point.y + offset.y,
        };
        if (freeBerth(world, command.point, access))
          place = {
            kind,
            point: { ...command.point },
            access,
            side: command.side,
          };
      }
    }
    if (!place)
      return result(
        false,
        "这一侧没有空间，请换一个方向。",
        "No room on this side. Try another side.",
      );
    const berthCost = kind === "platform" ? PLATFORM_COST : PARKING_COST;
    const cost = berthCost + (parking?.trackCost ?? 0);
    if (world.economy.cash < cost)
      return result(
        false,
        "预算不足，费用包含停车接入轨道。",
        "Not enough budget, including parking access track.",
      );
    const candidateBerth = {
      ...place,
      id: "candidate-berth",
      paid: berthCost,
    };
    const candidate = {
      ...world,
      berths: [...world.berths, candidateBerth],
      tracks: [...world.tracks, ...(parking?.tracks ?? [])],
    };
    if (
      topologyChangeTouchesActivePlan(world, candidate, [
        place.point,
        place.access,
        ...(parking?.tracks.flatMap((track) => [track.a, track.b]) ?? []),
      ])
    )
      return result(
        false,
        "此处有车辆计划正在通过，请等待排空后再建泊位。",
        "An active journey uses this junction. Wait for it to clear before adding a berth.",
      );
    world.berths.push({ ...place, id: id(world, "berth-"), paid: berthCost });
    world.tracks.push(...(parking?.tracks ?? []));
    if (parking?.trackCost) book(world, "track-build", -parking.trackCost);
    book(
      world,
      kind === "platform" ? "platform-build" : "parking-build",
      -berthCost,
    );
    world.networkVersion++;
    return result(
      true,
      kind === "parking"
        ? "独立停车位已建好；连接外侧接点即可加入路网。"
        : "平台已建好，请将外侧接点连入轨道。",
      kind === "parking"
        ? "Independent parking built. Connect its outer access point to the network."
        : "Platform built. Connect its outer access point to the network.",
    );
  }
  if (command.type === "upgrade-tracks") {
    const target = command.lanes ?? 2;
    if (target !== 2 && target !== 3)
      return result(
        false,
        "请选择两车道或三车道。",
        "Choose two or three shared lanes.",
      );
    if (
      !Array.isArray(command.ids) ||
      command.ids.length === 0 ||
      command.ids.some((trackId) => typeof trackId !== "string")
    )
      return result(false, "请选择要升级的轨道。", "Select tracks to upgrade.");
    const ids = [...new Set(command.ids)];
    if (ids.length !== command.ids.length)
      return result(
        false,
        "升级列表包含重复轨道。",
        "The upgrade list contains duplicate tracks.",
      );
    const tracks = ids.map((trackId) =>
      world.tracks.find((track) => track.id === trackId),
    );
    if (tracks.some((track) => !track))
      return result(
        false,
        "部分轨道已经不存在。",
        "Some selected tracks no longer exist.",
      );
    if (
      ids.some((trackId) =>
        world.pendingEdits.some((edit) => edit.id === trackId),
      )
    )
      return result(
        false,
        "部分轨道已有待执行改造。",
        "Some selected tracks already have pending edits.",
      );
    const upgrades = tracks.filter(
      (track): track is NonNullable<typeof track> =>
        !!track && (track.lanes ?? 1) < target,
    );
    if (!upgrades.length)
      return result(
        false,
        "所选轨道已达到指定容量。",
        "The selected tracks already have this capacity.",
      );
    const costs = upgrades.map((track) => ({
      track,
      paid:
        TRACK_UPGRADE_COST *
        distance(track.a, track.b) *
        (target - (track.lanes ?? 1)),
    }));
    const total = costs.reduce((sum, upgrade) => sum + upgrade.paid, 0);
    if (world.economy.cash < total)
      return result(
        false,
        "升级预算不足。",
        "Not enough budget for this upgrade.",
      );
    const busy = costs.map((upgrade) => ({
      ...upgrade,
      busy: editBusy(world, {
        type: "upgrade-track",
        id: upgrade.track.id,
        paid: upgrade.paid,
        targetLanes: target,
      }),
    }));
    book(world, "track-build", -total);
    let completed = 0;
    for (const upgrade of busy) {
      if (upgrade.busy) {
        world.pendingEdits.push({
          type: "upgrade-track",
          id: upgrade.track.id,
          paid: upgrade.paid,
          targetLanes: target,
        });
      } else {
        upgrade.track.lanes = target;
        upgrade.track.paid += upgrade.paid;
        completed++;
      }
    }
    if (completed) world.networkVersion++;
    const queued = busy.length - completed;
    return result(
      true,
      queued
        ? `已升级 ${completed} 段，另有 ${queued} 段排空后升级。`
        : `已升级 ${completed} 段为 ${target} 条共享车道。`,
      queued
        ? `Upgraded ${completed}; ${queued} more will upgrade after traffic clears.`
        : `Upgraded ${completed} track sections to ${target} shared lanes.`,
    );
  }
  if (command.type === "remove-tracks") {
    if (
      !Array.isArray(command.ids) ||
      command.ids.length === 0 ||
      command.ids.some(
        (trackId) => typeof trackId !== "string" || trackId.trim().length === 0,
      )
    )
      return result(false, "请选择要拆除的轨道。", "Select tracks to remove.");
    const ids = [...new Set(command.ids)];
    if (ids.length !== command.ids.length)
      return result(
        false,
        "拆除列表包含重复轨道。",
        "The removal list contains duplicate tracks.",
      );
    const tracks = ids.map((trackId) =>
      world.tracks.find((track) => track.id === trackId),
    );
    if (tracks.some((track) => !track))
      return result(
        false,
        "部分轨道已经不存在。",
        "Some selected tracks no longer exist.",
      );
    if (
      ids.some((trackId) =>
        world.pendingEdits.some((edit) => edit.id === trackId),
      )
    )
      return result(
        false,
        "部分轨道已有待执行改造。",
        "Some selected tracks already have pending edits.",
      );
    const selected = tracks as World["tracks"];
    const selectedIds = new Set(ids);
    const candidate = {
      ...world,
      tracks: world.tracks.filter((track) => !selectedIds.has(track.id)),
    };
    if (!capacityValid(candidate) || !parkingEditAllowed(world, candidate))
      return result(
        false,
        "拆除后有车无法获得周转空位，请先补停车位或连接。",
        "Add parking or a connection before splitting this network.",
      );

    // Topology-dependent lane and node resources can change after the first
    // removal, so classify the whole selection against one unchanged world.
    const classified = selected.map((track) => ({
      track,
      busy: editBusy(world, { type: "remove-track", id: track.id }),
    }));
    const queued = classified.filter((entry) => entry.busy);
    if (world.pendingEdits.length + queued.length > 256)
      return result(
        false,
        "待执行改造过多，请先恢复运行完成现有改造。",
        "Too many edits are queued. Resume and let existing edits finish first.",
      );

    const immediate = classified.filter((entry) => !entry.busy);
    const immediateIds = new Set(immediate.map((entry) => entry.track.id));
    const refund = immediate.reduce((sum, entry) => sum + entry.track.paid, 0);
    if (immediate.length) {
      world.tracks = world.tracks.filter(
        (track) => !immediateIds.has(track.id),
      );
      book(world, "refund", refund);
      world.networkVersion++;
    }
    for (const entry of queued)
      world.pendingEdits.push({ type: "remove-track", id: entry.track.id });
    world.reservations = world.reservations.filter(
      (reservation) => reservation.end > world.time,
    );
    return result(
      true,
      `已拆除 ${immediate.length} 段，退款 ${refund}；另有 ${queued.length} 段排空后拆除。`,
      `Removed ${immediate.length} track sections with a ${refund} refund; ${queued.length} more queued until traffic clears.`,
    );
  }
  if (command.type === "buy-pod") {
    const berth = world.berths.find((b) => b.id === command.berthId);
    if (berth?.kind !== "parking")
      return result(
        false,
        "请在专用停车位购车，平台要留给上下客。",
        "Buy Pods at dedicated parking; keep passenger platforms clear.",
      );
    const missingParking = parkingPurchaseShortage(world, berth.id);
    if (missingParking)
      return result(
        false,
        `此路网还需 ${missingParking} 个停车位，每辆 Pod 需要一个。`,
        `This network needs ${missingParking} more parking slots, one per Pod.`,
      );
    if (
      !berth ||
      terminalOwner(world, berth.id) ||
      world.pods.some((p) => p.berthId === berth.id)
    )
      return result(
        false,
        "请选择一个空的泊位接收新车。",
        "Choose an empty berth to receive a Pod.",
      );
    if (world.pods.length >= MAX_PODS)
      return result(
        false,
        `当前性能保护上限为 ${MAX_PODS} 辆 Pod。`,
        `The current performance guardrail is ${MAX_PODS} Pods.`,
      );
    if (world.economy.cash < POD_COST)
      return result(false, "购车预算不足。", "Not enough budget for a Pod.");
    const pod = {
      id: `pod-${world.nextId}`,
      berthId: berth.id,
      parkedSince: world.time,
      plan: null,
      trips: 0,
      paid: POD_COST,
    };
    if (!capacityValid({ ...world, pods: [...world.pods, pod] }))
      return result(
        false,
        "请先加一个可达停车位。",
        "Add a reachable parking bay first.",
      );
    world.nextId++;
    world.pods.push(pod);
    book(world, "pod-buy", -POD_COST);
    return result(
      true,
      "新 Pod 已进入车队。",
      "A new Pod has joined the fleet.",
    );
  }
  if (command.type === "sell-pod") {
    const pod = world.pods.find((p) => p.id === command.id);
    if (!pod || pod.plan)
      return result(
        false,
        "请等待这辆车完成接送。",
        "Wait for this Pod to finish its journey.",
      );
    if (world.pods.length <= 1)
      return result(false, "保留至少一辆 Pod。", "Keep at least one Pod.");
    world.pods = world.pods.filter((p) => p.id !== pod.id);
    book(world, "refund", Math.floor(pod.paid * 0.85));
    return result(true, "Pod 已回售。", "Pod returned.");
  }
  if (
    command.type === "remove-track" ||
    command.type === "remove-berth" ||
    command.type === "move-berth"
  ) {
    if (world.pendingEdits.some((e) => e.id === command.id))
      return result(
        false,
        "此处已有待执行改造。",
        "An edit is already pending here.",
      );
    if (editBusy(world, command)) {
      world.pendingEdits.push(command);
      return result(
        true,
        "已安排改造，恢复运行后排空并执行。",
        "Edit queued. Resume to clear existing journeys and apply it.",
      );
    }
    return executeEdit(world, command);
  }
  return result(false, "未知操作。", "Unknown command.");
}
