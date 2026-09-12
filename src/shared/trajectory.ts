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
  canonicalMovementResources,
  edgeResources,
  movementNodeResources,
  movementLaneIndex,
  nodeKey,
} from "../network";
import type { MotionSegment, ServicePlan, World } from "./types";

const EPSILON = 1e-6;

export interface TrajectoryReservationWindow {
  resource: string;
  start: number;
  end: number;
}

function pointResources(world: World, point: MotionSegment["from"]): string[] {
  const berth = world.berths.find((candidate) =>
    samePoint(candidate.point, point),
  );
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

function mergeWindows(
  windows: TrajectoryReservationWindow[],
): TrajectoryReservationWindow[] {
  const sorted = windows
    .filter((window) => window.end - window.start > EPSILON)
    .slice()
    .sort(
      (left, right) =>
        left.resource.localeCompare(right.resource) ||
        left.start - right.start ||
        left.end - right.end,
    );
  const merged: TrajectoryReservationWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.resource === window.resource &&
      window.start <= previous.end + EPSILON
    ) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
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

  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "move") {
      add(
        segmentMovementResources(world, segment),
        segment.start,
        segment.end + CLEARANCE_SECONDS,
      );
      if (safetyBuffer === 1) {
        const neighboringMoves = [
          segments[index - 1],
          segments[index + 1],
        ].filter(
          (neighbor): neighbor is MotionSegment =>
            neighbor?.kind === "move" &&
            (samePoint(neighbor.to, segment.from) ||
              samePoint(segment.to, neighbor.from)),
        );
        const bufferedEnd = Math.min(
          trajectoryEnd,
          segment.end + CLEARANCE_SECONDS,
        );
        for (const neighbor of neighboringMoves)
          add(
            segmentMovementResources(world, neighbor),
            segment.start,
            bufferedEnd,
          );
      }

      // A continuous trajectory has no preceding dwell at its first point.
      if (index === 0) {
        add(
          pointResources(world, segment.from),
          segment.start,
          segment.start + NODE_SECONDS + CLEARANCE_SECONDS,
        );
      }

      // Arrival reserves the junction/berth without extending visible travel.
      const next = segments[index + 1];
      const incomingLane = movementLaneIndex(
        world,
        segment.from,
        segment.to,
        segment.resources,
      );
      const outgoingLane =
        next?.kind === "move" && samePoint(next.from, segment.to)
          ? movementLaneIndex(world, next.from, next.to, next.resources)
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
          : pointResources(world, segment.to);
      add(
        arrivalResources,
        segment.end,
        segment.end + NODE_SECONDS + CLEARANCE_SECONDS,
      );
    } else {
      add(
        pointResources(world, segment.from),
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
