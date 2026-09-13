import {
  ALIGHT_SECONDS,
  BOARD_SECONDS,
  CELL_METERS,
  CLEARANCE_SECONDS,
  NODE_SECONDS,
  POD_METERS_PER_SECOND,
} from "./constants";
import { distance, samePoint } from "./math";
import {
  berthAtPoint,
  canonicalMovementResources,
  dwellResources,
  edgeResources,
  movementNodeResources,
  movementLaneIndex,
  movementResources,
  nodeKey,
} from "../network";
import type { MotionSegment, ServicePlan, World } from "./types";

const EPSILON = 1e-6;

/**
 * Resource ordering matches `localeCompare` exactly; a shared collator just
 * avoids re-deriving the default one on every comparison.
 */
const resourceCollator = new Intl.Collator();
const compareResource = resourceCollator.compare;

/**
 * Collation is settled for the lifetime of a session, so each resource name is
 * placed once in a global order and compared by integer rank afterwards. A
 * network of fixed size stops adding names after its first few plans, and
 * ordering its resources then costs no collator calls at all.
 */
const resourceRanks = new Map<string, number>();
const compareByRank = (left: string, right: string) =>
  resourceRanks.get(left)! - resourceRanks.get(right)!;

function rankResources(resources: Iterable<string>): void {
  const ordered = [...new Set([...resourceRanks.keys(), ...resources])].sort(
    compareResource,
  );
  resourceRanks.clear();
  for (let index = 0; index < ordered.length; index += 1)
    resourceRanks.set(ordered[index], index);
}

/** Place any unranked name in the table, so `resourceRank` can answer for it. */
export function ensureRanked(resources: Iterable<string>): void {
  for (const resource of resources)
    if (!resourceRanks.has(resource)) {
      rankResources(resources);
      return;
    }
}

/** Collation rank of a resource passed through `ensureRanked`. */
export function resourceRank(resource: string): number {
  return resourceRanks.get(resource)!;
}

/** Sort into collator order, in place, via the shared rank table. */
export function sortResources(resources: string[]): string[] {
  ensureRanked(resources);
  return resources.sort(compareByRank);
}

export interface TrajectoryReservationWindow {
  resource: string;
  start: number;
  end: number;
}

function pointResources(world: World, point: MotionSegment["from"]): string[] {
  const berth = berthAtPoint(world, point);
  return [nodeKey(point), ...(berth ? [`berth:${berth.id}`] : [])];
}

function segmentMovementResources(
  world: World,
  segment: MotionSegment,
): string[] {
  return (
    canonicalMovementResources(
      world,
      segment.from,
      segment.to,
      segment.resources,
    ) ?? []
  );
}

function pointWindows(world: World, point: MotionSegment["from"]): string[] {
  return dwellResources(world, point);
}

/**
 * Group first, then order. Interval merging only ever compares windows that
 * share a resource, so the collator runs once per distinct resource instead of
 * once per comparison in a sort over every window.
 */
function mergeWindows(
  windows: TrajectoryReservationWindow[],
): TrajectoryReservationWindow[] {
  const groups = new Map<string, TrajectoryReservationWindow[]>();
  for (const window of windows) {
    if (window.end - window.start <= EPSILON) continue;
    const group = groups.get(window.resource);
    if (group) group.push(window);
    else groups.set(window.resource, [window]);
  }
  const merged: TrajectoryReservationWindow[] = [];
  for (const resource of sortResources([...groups.keys()])) {
    const group = groups.get(resource)!;
    group.sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    for (const window of group) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.resource === resource &&
        window.start <= previous.end + EPSILON
      ) {
        previous.end = Math.max(previous.end, window.end);
      } else {
        merged.push({ ...window });
      }
    }
  }
  return merged;
}

/**
 * Rebuild every physical reservation from geometry and time, never from the
 * resource arrays supplied by a planner or save file.
 *
 * A pass-through node owns a short clearance window after the instant the Pod
 * reaches it. That window is deliberately independent of visible motion: the
 * next edge may begin at the same instant, so a Pod does not stop at each cell.
 */
export function requiredTrajectoryWindows(
  world: World,
  segments: MotionSegment[],
  safetyBuffer: 0 | 1 = 1,
): TrajectoryReservationWindow[] {
  const windows: TrajectoryReservationWindow[] = [];
  const trajectoryEnd = segments.at(-1)?.end ?? 0;
  const add = (resources: string[], start: number, end: number) => {
    for (const resource of resources) windows.push({ resource, start, end });
  };
  // Each move is resolved by its own pass and again as its neighbours' buffer,
  // so both derivations are memoized per segment for the length of this call.
  const resolved: ({ lane: number | null; resources: string[] } | undefined)[] =
    new Array(segments.length);
  const resolve = (index: number) => {
    const cached = resolved[index];
    if (cached) return cached;
    const segment = segments[index];
    const lane = movementLaneIndex(
      world,
      segment.from,
      segment.to,
      segment.resources,
    );
    const entry = {
      lane,
      resources:
        lane === null
          ? []
          : movementResources(world, segment.from, segment.to, lane),
    };
    resolved[index] = entry;
    return entry;
  };
  const resourcesOf = (index: number): string[] => resolve(index).resources;
  const laneOf = (index: number): number | null => resolve(index).lane;

  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "move") {
      add(resourcesOf(index), segment.start, segment.end + CLEARANCE_SECONDS);
      if (safetyBuffer === 1) {
        const bufferedEnd = Math.min(
          trajectoryEnd,
          segment.end + CLEARANCE_SECONDS,
        );
        for (const offset of [-1, 1]) {
          const neighborIndex = index + offset;
          const neighbor = segments[neighborIndex];
          if (
            neighbor?.kind !== "move" ||
            !(
              samePoint(neighbor.to, segment.from) ||
              samePoint(segment.to, neighbor.from)
            )
          )
            continue;
          add(resourcesOf(neighborIndex), segment.start, bufferedEnd);
        }
      }

      // A continuous trajectory has no preceding dwell at its first point.
      if (index === 0) {
        add(
          pointWindows(world, segment.from),
          segment.start,
          segment.start + NODE_SECONDS + CLEARANCE_SECONDS,
        );
      }

      // Arrival reserves the junction/berth without extending visible travel.
      const next = segments[index + 1];
      const incomingLane = laneOf(index);
      const outgoingLane =
        next?.kind === "move" && samePoint(next.from, segment.to)
          ? laneOf(index + 1)
          : null;
      const arrivalResources =
        next?.kind === "move" &&
        incomingLane !== null &&
        incomingLane === outgoingLane
          ? movementNodeResources(
              world,
              segment.to,
              segment.from,
              next.to,
              incomingLane,
            )
          : pointWindows(world, segment.to);
      add(
        arrivalResources,
        segment.end,
        segment.end + NODE_SECONDS + CLEARANCE_SECONDS,
      );
    } else {
      add(
        pointWindows(world, segment.from),
        segment.start,
        segment.end + CLEARANCE_SECONDS,
      );
    }
  }

  return mergeWindows(windows);
}

/** Reconstruct and validate a plan's physical requirements. */
export function assertTrajectory(world: World, plan: ServicePlan): void {
  const require = (ok: unknown, detail: string) => {
    if (!ok) throw new Error(`Invalid trajectory: ${detail}`);
  };
  const first = plan.segments[0];
  const last = plan.segments.at(-1);
  const origin = world.berths.find((berth) => berth.id === plan.originBerthId);
  const terminal = world.berths.find((berth) => berth.id === plan.finalBerthId);
  require(plan.safetyBuffer === undefined ||
    plan.safetyBuffer === 1, "invalid safety buffer");
  require(first && last && origin && terminal, "missing endpoint");
  require(samePoint(first.from, origin!.point) &&
    samePoint(last!.to, terminal!.point), "endpoint position");
  require(Math.abs(first.start - plan.departure) < EPSILON &&
    Math.abs(last!.end - plan.end) < EPSILON, "endpoint time");

  const edges = new Set([
    ...world.tracks.map((track) => edgeResources(track.a, track.b)[0]),
    ...world.berths.map((berth) => edgeResources(berth.point, berth.access)[0]),
  ]);
  const calendar = new Map<string, ServicePlan["reservations"]>();
  for (const reservation of plan.reservations) {
    require(reservation.ownerId === plan.podId &&
      Number.isFinite(reservation.start) &&
      Number.isFinite(reservation.end) &&
      reservation.end > reservation.start, "invalid reservation");
    const list = calendar.get(reservation.resource) ?? [];
    list.push(reservation);
    calendar.set(reservation.resource, list);
  }

  for (let index = 0; index < plan.segments.length; index += 1) {
    const segment = plan.segments[index];
    const prior = plan.segments[index - 1];
    require(Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end > segment.start, "invalid duration");
    require(!prior ||
      (samePoint(prior.to, segment.from) &&
        Math.abs(prior.end - segment.start) <
          EPSILON), "discontinuous movement");
    const keys =
      segment.kind === "move"
        ? segmentMovementResources(world, segment)
        : pointResources(world, segment.from);
    if (segment.kind === "move") {
      require(edges.has(
        edgeResources(segment.from, segment.to)[0],
      ), "movement outside network");
      require(segment.end - segment.start + EPSILON >=
        (distance(segment.from, segment.to) * CELL_METERS) /
          POD_METERS_PER_SECOND, "speed exceeds limit");
      require(keys.length > 0, "illegal lane selection");
    } else {
      require(samePoint(segment.from, segment.to), "moving dwell");
      const minimum =
        segment.kind === "boarding"
          ? BOARD_SECONDS
          : segment.kind === "alighting"
            ? ALIGHT_SECONDS
            : NODE_SECONDS;
      require(segment.end - segment.start + EPSILON >=
        minimum, "dwell duration");
      if (segment.kind === "boarding" || segment.kind === "alighting") {
        const berth = world.berths.find((candidate) =>
          samePoint(candidate.point, segment.from),
        );
        require(berth?.kind === "platform", "passenger dwell outside platform");
      }
    }
    if (segment.kind !== "move")
      require(keys.length === segment.resources.length &&
        keys.every((key) =>
          segment.resources.includes(key),
        ), "resource mismatch");
  }

  for (const required of requiredTrajectoryWindows(
    world,
    plan.segments,
    plan.safetyBuffer ?? 0,
  )) {
    require(calendar
      .get(required.resource)
      ?.some(
        (reservation) =>
          reservation.start <= required.start + EPSILON &&
          reservation.end >= required.end - EPSILON,
      ), `missing trajectory reservation ${required.resource}`);
  }

  if (plan.residentId) {
    const boarding = plan.segments.filter(
      (segment) => segment.kind === "boarding",
    );
    const alighting = plan.segments.filter(
      (segment) => segment.kind === "alighting",
    );
    require(boarding.length === 1 &&
      alighting.length === 1, "passenger operations");
    require(boarding[0].start === plan.pickupStart &&
      boarding[0].end === plan.pickupEnd &&
      alighting[0].start === plan.dropoffStart &&
      alighting[0].end === plan.dropoffEnd, "passenger timeline");
    require(samePoint(
      boarding[0].from,
      world.berths.find((berth) => berth.id === plan.pickupId)!.point,
    ) &&
      samePoint(
        alighting[0].from,
        world.berths.find((berth) => berth.id === plan.dropoffId)!.point,
      ), "passenger location");
  }
}
