import {
  ALIGHT_SECONDS,
  BOARD_SECONDS,
  CELL_METERS,
  NODE_SECONDS,
  POD_METERS_PER_SECOND,
} from "../shared/constants";
import { pathLength, samePoint } from "../shared/math";
import type {
  Berth,
  MotionSegment,
  PlanResult,
  Pod,
  Reservation,
  Resident,
  ServicePlan,
  World,
} from "../shared/types";
import {
  findTrackPath,
  movementResourceOptions,
  movementResources,
  nodeKey,
} from "../network";
import {
  assertTrajectory,
  requiredTrajectoryWindows,
} from "../shared/trajectory";

const PLANNING_WINDOW_SECONDS = 1_800;
const MAX_SEARCH_STEPS = 4_096;
const EPSILON = 1e-9;
const BERTH_RESOURCE_PREFIX = "berth:";

interface RelativeReservation {
  resource: string;
  start: number;
  end: number;
}

interface TerminalCandidate {
  berth: Berth;
  relocationPath: ReturnType<typeof findTrackPath>;
}

interface TimedBlock {
  resource: string;
  start: number;
  end: number;
  ownerId: string;
}

const berthResource = (berthId: string) => `${BERTH_RESOURCE_PREFIX}${berthId}`;

function route(world: World, from: Berth, to: Berth) {
  if (samePoint(from.point, to.point)) return [from.point];
  return findTrackPath(world, from.point, to.point);
}

function terminalOwners(world: World, berthId: string): string[] {
  const owners: string[] = [];
  for (const pod of world.pods) {
    const terminalId = pod.plan ? pod.plan.finalBerthId : pod.berthId;
    if (terminalId === berthId) owners.push(pod.id);
  }
  return owners;
}

/** The Pod with the durable tail commitment to a berth, if any. */
export function terminalOwner(
  world: World,
  berthId: string,
): string | undefined {
  return terminalOwners(world, berthId)[0];
}

function occupiedByIdlePod(
  world: World,
  berthId: string,
  exceptPodId: string,
): boolean {
  return world.pods.some(
    (pod) =>
      pod.id !== exceptPodId && pod.plan === null && pod.berthId === berthId,
  );
}

function terminalAvailable(
  world: World,
  berthId: string,
  podId: string,
): boolean {
  return terminalOwners(world, berthId).every((ownerId) => ownerId === podId);
}

function pathIsUsable(
  path: ReturnType<typeof findTrackPath>,
): path is NonNullable<typeof path> {
  return path !== null && path.length > 0;
}

function appendSegment(
  segments: MotionSegment[],
  segment: Omit<MotionSegment, "start" | "end">,
  cursor: number,
  duration: number,
): number {
  segments.push({ ...segment, start: cursor, end: cursor + duration });
  return cursor + duration;
}

function appendTravel(
  world: World,
  segments: MotionSegment[],
  path: NonNullable<ReturnType<typeof findTrackPath>>,
  stage: MotionSegment["stage"],
  cursor: number,
  laneProfile: number,
): number {
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    cursor = appendSegment(
      segments,
      {
        from,
        to,
        kind: "move",
        stage,
        resources: movementResources(
          world,
          from,
          to,
          Math.min(
            laneProfile,
            movementResourceOptions(world, from, to).length - 1,
          ),
        ),
      },
      cursor,
      (Math.hypot(to.x - from.x, to.y - from.y) * CELL_METERS) /
        POD_METERS_PER_SECOND,
    );
  }
  return cursor;
}

function appendBerthOperation(
  segments: MotionSegment[],
  berth: Berth,
  kind: "boarding" | "alighting",
  stage: "empty" | "loaded",
  cursor: number,
  duration: number,
): number {
  return appendSegment(
    segments,
    {
      from: berth.point,
      to: berth.point,
      kind,
      stage,
      resources: [nodeKey(berth.point), berthResource(berth.id)],
    },
    cursor,
    duration,
  );
}

function mergeRelativeReservations(
  reservations: RelativeReservation[],
): RelativeReservation[] {
  const sorted = reservations
    .filter((reservation) => reservation.end - reservation.start > EPSILON)
    .slice()
    .sort(
      (left, right) =>
        left.resource.localeCompare(right.resource) ||
        left.start - right.start ||
        left.end - right.end,
    );
  const merged: RelativeReservation[] = [];
  for (const reservation of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.resource === reservation.resource &&
      reservation.start <= previous.end + EPSILON
    ) {
      previous.end = Math.max(previous.end, reservation.end);
    } else {
      merged.push({ ...reservation });
    }
  }
  return merged;
}

function relativeReservations(
  world: World,
  segments: MotionSegment[],
): RelativeReservation[] {
  return requiredTrajectoryWindows(world, segments, 1);
}

function mergeReservations(
  reservations: Reservation[],
  ownerId: string,
): Reservation[] {
  return mergeRelativeReservations(
    reservations.map(({ resource, start, end }) => ({ resource, start, end })),
  ).map((reservation) => ({ ...reservation, ownerId }));
}

function mergeCalendar(reservations: Reservation[]): Reservation[] {
  const groups = new Map<string, Reservation[]>();
  for (const reservation of reservations) {
    const key = `${reservation.ownerId}\u0000${reservation.resource}`;
    const group = groups.get(key) ?? [];
    group.push(reservation);
    groups.set(key, group);
  }
  return [...groups.values()]
    .flatMap((group) => mergeReservations(group, group[0].ownerId))
    .sort(
      (left, right) =>
        left.resource.localeCompare(right.resource) ||
        left.start - right.start ||
        left.end - right.end ||
        left.ownerId.localeCompare(right.ownerId),
    );
}

function terminalBlocks(world: World, exceptPodId: string): TimedBlock[] {
  const blocks: TimedBlock[] = [];
  for (const pod of world.pods) {
    if (pod.id === exceptPodId) continue;
    if (pod.plan) {
      if (pod.berthId && pod.plan.departure > world.time) {
        blocks.push({
          resource: berthResource(pod.berthId),
          start: world.time,
          end: pod.plan.departure,
          ownerId: pod.id,
        });
      }
      blocks.push({
        resource: berthResource(pod.plan.finalBerthId),
        start: pod.plan.end,
        end: Number.POSITIVE_INFINITY,
        ownerId: pod.id,
      });
    } else if (pod.berthId) {
      blocks.push({
        resource: berthResource(pod.berthId),
        start: world.time,
        end: Number.POSITIVE_INFINITY,
        ownerId: pod.id,
      });
    }
  }
  return blocks;
}

function overlaps(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart < rightEnd - EPSILON && rightStart < leftEnd - EPSILON;
}

function existingBlocks(world: World, podId: string): TimedBlock[] {
  return [
    ...world.reservations
      .filter(
        (reservation) =>
          reservation.ownerId !== podId &&
          Number.isFinite(reservation.start) &&
          Number.isFinite(reservation.end) &&
          reservation.end > world.time,
      )
      .map((reservation) => ({ ...reservation })),
    ...terminalBlocks(world, podId),
  ];
}

function absoluteSegments(
  segments: MotionSegment[],
  departure: number,
): MotionSegment[] {
  return segments.map((segment) => ({
    ...segment,
    from: { ...segment.from },
    to: { ...segment.to },
    resources: [...segment.resources],
    start: segment.start + departure,
    end: segment.end + departure,
  }));
}

function searchDeparture(
  world: World,
  pod: Pod,
  origin: Berth,
  finalBerth: Berth,
  template: MotionSegment[],
): {
  departure: number;
  segments: MotionSegment[];
  reservations: Reservation[];
} | null {
  const relative = relativeReservations(world, template);
  const blocks = existingBlocks(world, pod.id);
  const blocksByResource = new Map<string, TimedBlock[]>();
  for (const block of blocks) {
    const entries = blocksByResource.get(block.resource) ?? [];
    entries.push(block);
    blocksByResource.set(block.resource, entries);
  }
  const duration = template[template.length - 1]?.end ?? 0;
  if (duration > PLANNING_WINDOW_SECONDS + EPSILON) return null;
  const latestDeparture =
    world.time + Math.max(0, PLANNING_WINDOW_SECONDS - duration);
  let departure = world.time;

  for (
    let step = 0;
    step < MAX_SEARCH_STEPS && departure <= latestDeparture + EPSILON;
    step += 1
  ) {
    let jump = departure;
    let impossible = false;
    for (const proposed of relative) {
      const start = proposed.start + departure;
      const end = proposed.end + departure;
      for (const block of blocksByResource.get(proposed.resource) ?? []) {
        if (!overlaps(start, end, block.start, block.end)) continue;
        if (!Number.isFinite(block.end)) {
          impossible = true;
          break;
        }
        jump = Math.max(jump, block.end - proposed.start);
      }
      if (impossible) break;
    }
    if (impossible) return null;

    // A final berth becomes a durable tail commitment at plan end. Delay the
    // entire plan until every already-approved finite visit to that berth is over.
    const proposedEnd = departure + duration;
    for (const block of blocksByResource.get(berthResource(finalBerth.id)) ??
      []) {
      if (block.end <= proposedEnd + EPSILON) {
        continue;
      }
      if (!Number.isFinite(block.end)) {
        impossible = true;
        break;
      }
      jump = Math.max(jump, block.end - duration);
    }
    if (impossible) return null;

    if (jump <= departure + EPSILON) {
      const segments = absoluteSegments(template, departure);
      const reservations = mergeReservations(
        [
          ...relative.map((reservation) => ({
            ...reservation,
            start: reservation.start + departure,
            end: reservation.end + departure,
            ownerId: pod.id,
          })),
          ...(departure > world.time + EPSILON
            ? [
                {
                  resource: berthResource(origin.id),
                  start: world.time,
                  end: departure,
                  ownerId: pod.id,
                },
              ]
            : []),
        ],
        pod.id,
      );
      if (
        reservations.some((reservation) =>
          (blocksByResource.get(reservation.resource) ?? []).some(
            (block) =>
              block.resource === reservation.resource &&
              overlaps(
                reservation.start,
                reservation.end,
                block.start,
                block.end,
              ),
          ),
        )
      ) {
        return null;
      }
      return { departure, segments, reservations };
    }
    departure = jump;
  }
  return null;
}

function serviceTerminalCandidates(
  world: World,
  pod: Pod,
  origin: Berth,
  dropoff: Berth,
): TerminalCandidate[] {
  const candidates: TerminalCandidate[] = [];
  const seen = new Set<string>();

  const add = (berth: Berth) => {
    if (
      berth.kind !== "parking" ||
      seen.has(berth.id) ||
      !terminalAvailable(world, berth.id, pod.id) ||
      world.pendingEdits.some((edit) => edit.id === berth.id)
    )
      return;
    const relocationPath = route(world, dropoff, berth);
    if (!pathIsUsable(relocationPath)) return;
    seen.add(berth.id);
    candidates.push({ berth, relocationPath });
  };

  const nearbyParking = world.berths
    .filter((berth) => berth.kind === "parking")
    .flatMap((berth) => {
      const path = route(world, dropoff, berth);
      return pathIsUsable(path)
        ? [{ berth, path, distance: pathLength(path) }]
        : [];
    })
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.berth.id.localeCompare(right.berth.id),
    );
  for (const candidate of nearbyParking) add(candidate.berth);
  add(origin);
  for (const berth of world.berths) {
    if (berth.kind === "parking") add(berth);
  }
  return candidates;
}

function idlePodFailure(pod: Pod): PlanResult | null {
  if (pod.plan !== null || pod.berthId === null)
    return { ok: false, reason: "no-pod" };
  return null;
}

function serviceTemplate(
  world: World,
  emptyPath: NonNullable<ReturnType<typeof findTrackPath>>,
  loadedPath: NonNullable<ReturnType<typeof findTrackPath>>,
  relocationPath: NonNullable<ReturnType<typeof findTrackPath>>,
  pickup: Berth,
  dropoff: Berth,
  finalBerth: Berth,
  laneProfile: number,
): {
  segments: MotionSegment[];
  pickupStart: number;
  pickupEnd: number;
  dropoffStart: number;
  dropoffEnd: number;
} {
  const segments: MotionSegment[] = [];
  let cursor = appendTravel(
    world,
    segments,
    emptyPath,
    "empty",
    0,
    laneProfile,
  );
  const pickupStart = cursor;
  cursor = appendBerthOperation(
    segments,
    pickup,
    "boarding",
    "empty",
    cursor,
    BOARD_SECONDS,
  );
  const pickupEnd = cursor;
  cursor = appendTravel(
    world,
    segments,
    loadedPath,
    "loaded",
    cursor,
    laneProfile,
  );
  const dropoffStart = cursor;
  cursor = appendBerthOperation(
    segments,
    dropoff,
    "alighting",
    "loaded",
    cursor,
    ALIGHT_SECONDS,
  );
  const dropoffEnd = cursor;
  if (finalBerth.id !== dropoff.id) {
    appendTravel(
      world,
      segments,
      relocationPath,
      "relocate",
      cursor,
      laneProfile,
    );
  }
  return { segments, pickupStart, pickupEnd, dropoffStart, dropoffEnd };
}

/** Build a complete empty-to-pickup, loaded, and terminal-parking candidate. */
export function planService(
  world: World,
  pod: Pod,
  resident: Resident,
  pickup: Berth,
  dropoff: Berth,
): PlanResult {
  const podFailure = idlePodFailure(pod);
  if (podFailure) return podFailure;
  const actualPickup = world.berths.find((berth) => berth.id === pickup.id);
  const actualDropoff = world.berths.find((berth) => berth.id === dropoff.id);
  if (
    !actualPickup ||
    !actualDropoff ||
    actualPickup.kind !== "platform" ||
    actualDropoff.kind !== "platform"
  ) {
    return { ok: false, reason: "no-platform" };
  }
  const origin = world.berths.find((berth) => berth.id === pod.berthId);
  if (!origin) return { ok: false, reason: "no-pod" };
  if (
    occupiedByIdlePod(world, actualPickup.id, pod.id) ||
    occupiedByIdlePod(world, actualDropoff.id, pod.id)
  ) {
    return { ok: false, reason: "platform-busy" };
  }

  const emptyPath = route(world, origin, actualPickup);
  const loadedPath = route(world, actualPickup, actualDropoff);
  if (!pathIsUsable(emptyPath) || !pathIsUsable(loadedPath)) {
    return { ok: false, reason: "disconnected" };
  }

  const terminals = serviceTerminalCandidates(
    world,
    pod,
    origin,
    actualDropoff,
  );
  if (!terminals.length) {
    return {
      ok: false,
      reason: terminalOwner(world, actualDropoff.id)
        ? "platform-busy"
        : "parking-full",
    };
  }

  let best:
    | {
        terminal: TerminalCandidate;
        template: ReturnType<typeof serviceTemplate>;
        scheduled: NonNullable<ReturnType<typeof searchDeparture>>;
        laneProfile: number;
      }
    | undefined;
  for (const terminal of terminals) {
    if (!pathIsUsable(terminal.relocationPath)) continue;
    const seenProfiles = new Set<string>();
    for (const laneProfile of [0, 1, 2]) {
      const template = serviceTemplate(
        world,
        emptyPath,
        loadedPath,
        terminal.relocationPath,
        actualPickup,
        actualDropoff,
        terminal.berth,
        laneProfile,
      );
      const signature = template.segments
        .filter((segment) => segment.kind === "move")
        .map((segment) => segment.resources.join("|"))
        .join(";");
      if (seenProfiles.has(signature)) continue;
      seenProfiles.add(signature);
      const scheduled = searchDeparture(
        world,
        pod,
        origin,
        terminal.berth,
        template.segments,
      );
      if (!scheduled) continue;
      const arrival = template.dropoffEnd + scheduled.departure;
      const bestArrival = best
        ? best.template.dropoffEnd + best.scheduled.departure
        : Number.POSITIVE_INFINITY;
      const end = scheduled.segments.at(-1)!.end;
      const bestEnd =
        best?.scheduled.segments.at(-1)!.end ?? Number.POSITIVE_INFINITY;
      if (
        !best ||
        scheduled.departure < best.scheduled.departure - EPSILON ||
        (Math.abs(scheduled.departure - best.scheduled.departure) <= EPSILON &&
          (arrival < bestArrival - EPSILON ||
            (Math.abs(arrival - bestArrival) <= EPSILON &&
              (end < bestEnd - EPSILON ||
                (Math.abs(end - bestEnd) <= EPSILON &&
                  laneProfile < best.laneProfile)))))
      ) {
        best = { terminal, template, scheduled, laneProfile };
      }
    }
  }
  if (!best) return { ok: false, reason: "track-busy" };
  const requestedAt = resident.journey?.startedAt ?? world.time;
  const { departure } = best.scheduled;
  return {
    ok: true,
    plan: {
      id: `service:${pod.id}:${resident.id}:${requestedAt}`,
      podId: pod.id,
      residentId: resident.id,
      originBerthId: origin.id,
      finalBerthId: best.terminal.berth.id,
      pickupId: actualPickup.id,
      dropoffId: actualDropoff.id,
      requestedAt,
      departure,
      pickupStart: best.template.pickupStart + departure,
      pickupEnd: best.template.pickupEnd + departure,
      dropoffStart: best.template.dropoffStart + departure,
      dropoffEnd: best.template.dropoffEnd + departure,
      end: best.scheduled.segments.at(-1)!.end,
      safetyBuffer: 1,
      segments: best.scheduled.segments,
      reservations: best.scheduled.reservations,
    },
  };
}

/** Build a complete empty move to a real, uncommitted terminal berth. */
export function planRelocation(
  world: World,
  pod: Pod,
  target: Berth,
): PlanResult {
  const podFailure = idlePodFailure(pod);
  if (podFailure) return podFailure;
  const origin = world.berths.find((berth) => berth.id === pod.berthId);
  if (!origin) return { ok: false, reason: "no-pod" };
  const actualTarget = world.berths.find((berth) => berth.id === target.id);
  if (!actualTarget) return { ok: false, reason: "disconnected" };
  if (!terminalAvailable(world, actualTarget.id, pod.id)) {
    return {
      ok: false,
      reason:
        actualTarget.kind === "platform" ? "platform-busy" : "parking-full",
    };
  }
  const relocationPath = route(world, origin, actualTarget);
  if (!pathIsUsable(relocationPath))
    return { ok: false, reason: "disconnected" };

  let scheduled: ReturnType<typeof searchDeparture> = null;
  const seenProfiles = new Set<string>();
  for (const laneProfile of [0, 1, 2]) {
    const template: MotionSegment[] = [];
    appendTravel(world, template, relocationPath, "relocate", 0, laneProfile);
    // Preserve the existing no-op relocation contract without putting fixed
    // dwell segments into any route that actually travels.
    if (!template.length) {
      appendSegment(
        template,
        {
          from: origin.point,
          to: origin.point,
          kind: "node",
          stage: "relocate",
          resources: [nodeKey(origin.point), berthResource(origin.id)],
        },
        0,
        NODE_SECONDS,
      );
    }
    const signature = template
      .map((segment) => segment.resources.join("|"))
      .join(";");
    if (seenProfiles.has(signature)) continue;
    seenProfiles.add(signature);
    const candidate = searchDeparture(
      world,
      pod,
      origin,
      actualTarget,
      template,
    );
    if (
      candidate &&
      (!scheduled ||
        candidate.departure < scheduled.departure - EPSILON ||
        (Math.abs(candidate.departure - scheduled.departure) <= EPSILON &&
          candidate.segments.at(-1)!.end <
            scheduled.segments.at(-1)!.end - EPSILON))
    ) {
      scheduled = candidate;
    }
  }
  if (!scheduled) return { ok: false, reason: "track-busy" };
  const plan: ServicePlan = {
    id: `relocate:${pod.id}:${actualTarget.id}:${world.time}`,
    podId: pod.id,
    residentId: null,
    originBerthId: origin.id,
    finalBerthId: actualTarget.id,
    requestedAt: world.time,
    departure: scheduled.departure,
    end: scheduled.segments[scheduled.segments.length - 1].end,
    safetyBuffer: 1,
    segments: scheduled.segments,
    reservations: scheduled.reservations,
  };
  return { ok: true, plan };
}

function assertFinitePlan(plan: ServicePlan) {
  const numbers = [plan.requestedAt, plan.departure, plan.end];
  for (const segment of plan.segments) numbers.push(segment.start, segment.end);
  for (const reservation of plan.reservations)
    numbers.push(reservation.start, reservation.end);
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw new Error(
      `Cannot commit plan ${plan.id}: plan contains a non-finite time`,
    );
  }
  if (!plan.segments.length || plan.end < plan.departure) {
    throw new Error(`Cannot commit plan ${plan.id}: invalid timeline`);
  }
}

/** Atomically recheck and publish a candidate plan. */
export function commitPlan(world: World, plan: ServicePlan): void {
  const pod = world.pods.find((candidate) => candidate.id === plan.podId);
  if (!pod || pod.plan !== null) {
    throw new Error(
      `Cannot commit plan ${plan.id}: pod ${plan.podId} is not idle`,
    );
  }
  if (pod.berthId !== plan.originBerthId) {
    throw new Error(
      `Cannot commit plan ${plan.id}: pod ${plan.podId} is no longer at origin berth ${plan.originBerthId}`,
    );
  }
  if (!world.berths.some((berth) => berth.id === plan.finalBerthId)) {
    throw new Error(
      `Cannot commit plan ${plan.id}: final berth ${plan.finalBerthId} is missing`,
    );
  }
  if (!terminalAvailable(world, plan.finalBerthId, plan.podId)) {
    throw new Error(
      `Cannot commit plan ${plan.id}: final berth ${plan.finalBerthId} is committed`,
    );
  }
  assertFinitePlan(plan);
  assertTrajectory(world, plan);
  if (plan.departure < world.time - EPSILON) {
    throw new Error(`Cannot commit plan ${plan.id}: departure is in the past`);
  }

  if (
    plan.reservations.some((reservation) => reservation.ownerId !== plan.podId)
  ) {
    throw new Error(
      `Cannot commit plan ${plan.id}: reservation owner mismatch`,
    );
  }
  const reservations = mergeReservations(plan.reservations, plan.podId);
  if (
    reservations.some(
      (reservation) =>
        reservation.ownerId !== plan.podId ||
        reservation.end <= reservation.start,
    )
  ) {
    throw new Error(`Cannot commit plan ${plan.id}: invalid reservation`);
  }
  const blocks = existingBlocks(world, plan.podId);
  for (const reservation of reservations) {
    const conflict = blocks.find(
      (block) =>
        block.resource === reservation.resource &&
        overlaps(reservation.start, reservation.end, block.start, block.end),
    );
    if (conflict) {
      throw new Error(
        `Cannot commit plan ${plan.id}: resource ${reservation.resource} conflicts with ${conflict.ownerId}`,
      );
    }
  }
  const finalResource = berthResource(plan.finalBerthId);
  const futureFinalConflict = blocks.find(
    (block) =>
      block.resource === finalResource && block.end > plan.end + EPSILON,
  );
  if (futureFinalConflict) {
    throw new Error(
      `Cannot commit plan ${plan.id}: final berth ${plan.finalBerthId} has a later visit by ${futureFinalConflict.ownerId}`,
    );
  }

  const committedPlan: ServicePlan = {
    ...plan,
    segments: plan.segments.map((segment) => ({
      ...segment,
      from: { ...segment.from },
      to: { ...segment.to },
      resources: [...segment.resources],
    })),
    reservations,
  };
  world.reservations = mergeCalendar([...world.reservations, ...reservations]);
  pod.plan = committedPlan;
}
