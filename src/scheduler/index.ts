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
  nodeKey,
  trackPathLength,
} from "../network";
import {
  assertTrajectory,
  ensureRanked,
  resourceRank,
  sortResources,
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

/** Length of `route`, or null where `route` yields nothing usable. */
function routeLength(world: World, from: Berth, to: Berth): number | null {
  if (samePoint(from.point, to.point)) return 0;
  return trackPathLength(world, from.point, to.point);
}

function terminalOwners(world: World, berthId: string): string[] {
  const owners: string[] = [];
  for (const pod of world.pods) {
    const terminalId = pod.plan ? pod.plan.finalBerthId : pod.berthId;
    if (terminalId === berthId) owners.push(pod.id);
  }
  return owners;
}

/**
 * Every berth's durable tail commitments in one pass. Callers that ask about a
 * whole berth list would otherwise rescan the fleet per berth — and a dispatch
 * pass asks berth after berth, so the index is kept until a Pod's berth or plan
 * moves it somewhere else.
 */
export function terminalOwnerIndex(world: World): Map<string, string[]> {
  const cache = planningCache(world);
  if (cache.owners) return cache.owners;
  const owners = new Map<string, string[]>();
  for (const pod of world.pods) {
    const terminalId = pod.plan ? pod.plan.finalBerthId : pod.berthId;
    if (terminalId === null) continue;
    const existing = owners.get(terminalId);
    if (existing) existing.push(pod.id);
    else owners.set(terminalId, [pod.id]);
  }
  cache.owners = owners;
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
    const options = movementResourceOptions(world, from, to);
    cursor = appendSegment(
      segments,
      {
        from,
        to,
        kind: "move",
        stage,
        resources: [...options[Math.min(laneProfile, options.length - 1)]],
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
  const groups = new Map<string, RelativeReservation[]>();
  for (const reservation of reservations) {
    if (reservation.end - reservation.start <= EPSILON) continue;
    const group = groups.get(reservation.resource);
    if (group) group.push(reservation);
    else groups.set(reservation.resource, [reservation]);
  }
  const merged: RelativeReservation[] = [];
  for (const resource of sortResources([...groups.keys()])) {
    const group = groups.get(resource)!;
    group.sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    for (const reservation of group) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.resource === resource &&
        reservation.start <= previous.end + EPSILON
      ) {
        previous.end = Math.max(previous.end, reservation.end);
      } else {
        merged.push({ ...reservation });
      }
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
  const merged = [...groups.values()].flatMap((group) =>
    mergeReservations(group, group[0].ownerId),
  );
  ensureRanked(merged.map((reservation) => reservation.resource));
  return merged.sort(
    (left, right) =>
      resourceRank(left.resource) - resourceRank(right.resource) ||
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
  const blocks: TimedBlock[] = [];
  for (const reservation of world.reservations)
    if (
      reservation.ownerId !== podId &&
      Number.isFinite(reservation.start) &&
      Number.isFinite(reservation.end) &&
      reservation.end > world.time
    )
      blocks.push(reservation);
  for (const block of terminalBlocks(world, podId)) blocks.push(block);
  return blocks;
}

/**
 * One resource's blocked intervals, ordered by start with a running maximum of
 * their ends. Every departure query is "does anything busy overlap this
 * window, and how far must I jump past it", which both arrays answer in
 * O(log n) instead of a scan: the blocks that could overlap are a prefix, and
 * only the largest end in that prefix can decide the answer.
 */
interface ResourceCalendar {
  starts: Float64Array;
  runningEnd: Float64Array;
}

/** The furthest end among blocks that start before `limit`, or -Infinity. */
function latestEndBefore(calendar: ResourceCalendar, limit: number): number {
  const starts = calendar.starts;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] < limit) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? Number.NEGATIVE_INFINITY : calendar.runningEnd[low - 1];
}

/**
 * A dispatch pass asks the same questions over and over: the same Pod against
 * the same calendar, and the same Pod-pickup-dropoff service for every waiting
 * passenger who happens to share that pair of platforms. None of those answers
 * depend on who is waiting, so they are kept until something they actually read
 * changes: the reservation list, the clock, the network, a pending edit, or any
 * Pod's berth or plan boundaries.
 */
interface CalendarCache {
  reservations: Reservation[];
  pods: Pod[];
  berths: Berth[];
  networkVersion: number;
  pendingEdits: World["pendingEdits"];
  pendingIds: string[];
  time: number;
  stamp: (string | number | null | undefined)[];
  byPod: Map<string, Map<string, ResourceCalendar>>;
  byService: Map<string, ServiceOutcome>;
  owners?: Map<string, string[]>;
}

/**
 * A finished service computation with the passenger left out: everything
 * `planService` derives before it stamps a Resident onto the plan.
 */
type ServiceOutcome =
  | { ok: false; reason: (PlanResult & { ok: false })["reason"] }
  | {
      ok: true;
      originBerthId: string;
      finalBerthId: string;
      pickupId: string;
      dropoffId: string;
      departure: number;
      pickupStart: number;
      pickupEnd: number;
      dropoffStart: number;
      dropoffEnd: number;
      end: number;
      segments: MotionSegment[];
      reservations: Reservation[];
    };

const calendarCaches = new WeakMap<World, CalendarCache>();
const PLAN_STAMP_FIELDS = 4;

function pendingMatches(cache: CalendarCache, world: World): boolean {
  if (cache.pendingEdits === world.pendingEdits) return true;
  if (cache.pendingIds.length !== world.pendingEdits.length) return false;
  for (let index = 0; index < world.pendingEdits.length; index += 1)
    if (cache.pendingIds[index] !== world.pendingEdits[index].id) return false;
  return true;
}

function planStampMatches(cache: CalendarCache, pods: Pod[]): boolean {
  if (cache.stamp.length !== pods.length * PLAN_STAMP_FIELDS) return false;
  for (let index = 0; index < pods.length; index += 1) {
    const pod = pods[index];
    const at = index * PLAN_STAMP_FIELDS;
    if (
      cache.stamp[at] !== pod.berthId ||
      cache.stamp[at + 1] !== pod.plan?.departure ||
      cache.stamp[at + 2] !== pod.plan?.end ||
      cache.stamp[at + 3] !== pod.plan?.finalBerthId
    )
      return false;
  }
  return true;
}

function planStamp(pods: Pod[]): (string | number | null | undefined)[] {
  const stamp: (string | number | null | undefined)[] = new Array(
    pods.length * PLAN_STAMP_FIELDS,
  );
  for (let index = 0; index < pods.length; index += 1) {
    const pod = pods[index];
    const at = index * PLAN_STAMP_FIELDS;
    stamp[at] = pod.berthId;
    stamp[at + 1] = pod.plan?.departure;
    stamp[at + 2] = pod.plan?.end;
    stamp[at + 3] = pod.plan?.finalBerthId;
  }
  return stamp;
}

function planningCache(world: World): CalendarCache {
  const cache = calendarCaches.get(world);
  if (
    cache &&
    cache.reservations === world.reservations &&
    cache.pods === world.pods &&
    cache.berths === world.berths &&
    cache.networkVersion === world.networkVersion &&
    cache.time === world.time &&
    pendingMatches(cache, world) &&
    planStampMatches(cache, world.pods)
  )
    return cache;
  const fresh: CalendarCache = {
    reservations: world.reservations,
    pods: world.pods,
    berths: world.berths,
    networkVersion: world.networkVersion,
    pendingEdits: world.pendingEdits,
    pendingIds: world.pendingEdits.map((edit) => edit.id),
    time: world.time,
    stamp: planStamp(world.pods),
    byPod: new Map(),
    byService: new Map(),
  };
  calendarCaches.set(world, fresh);
  return fresh;
}

function blockedResources(
  world: World,
  podId: string,
): Map<string, ResourceCalendar> {
  const cache = planningCache(world);
  const cached = cache.byPod.get(podId);
  if (cached) return cached;
  const calendars = computeBlockedResources(world, podId);
  cache.byPod.set(podId, calendars);
  return calendars;
}

/**
 * The calendar a Pod has to fit into, grouped by resource. It only depends on
 * the world and the Pod, so one planning call shares it across every terminal,
 * lane profile and candidate departure it tries.
 */
function computeBlockedResources(
  world: World,
  podId: string,
): Map<string, ResourceCalendar> {
  const grouped = new Map<string, TimedBlock[]>();
  for (const block of existingBlocks(world, podId)) {
    const entries = grouped.get(block.resource);
    if (entries) entries.push(block);
    else grouped.set(block.resource, [block]);
  }
  const calendars = new Map<string, ResourceCalendar>();
  for (const [resource, blocks] of grouped) {
    blocks.sort((left, right) => left.start - right.start);
    const starts = new Float64Array(blocks.length);
    const runningEnd = new Float64Array(blocks.length);
    let furthest = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < blocks.length; index += 1) {
      starts[index] = blocks[index].start;
      furthest = Math.max(furthest, blocks[index].end);
      runningEnd[index] = furthest;
    }
    calendars.set(resource, { starts, runningEnd });
  }
  return calendars;
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
  calendars: Map<string, ResourceCalendar>,
): {
  departure: number;
  segments: MotionSegment[];
  reservations: Reservation[];
} | null {
  const relative = relativeReservations(world, template);
  const duration = template[template.length - 1]?.end ?? 0;
  if (duration > PLANNING_WINDOW_SECONDS + EPSILON) return null;
  const latestDeparture =
    world.time + Math.max(0, PLANNING_WINDOW_SECONDS - duration);
  let departure = world.time;

  // Only the windows that can actually collide are rescanned per candidate
  // departure; on a quiet resource there is nothing to compare against.
  const contested: {
    window: RelativeReservation;
    calendar: ResourceCalendar;
  }[] = [];
  for (const proposed of relative) {
    const calendar = calendars.get(proposed.resource);
    if (calendar?.starts.length) contested.push({ window: proposed, calendar });
  }
  const finalCalendar = calendars.get(berthResource(finalBerth.id));
  const finalEnd = finalCalendar?.starts.length
    ? finalCalendar.runningEnd[finalCalendar.starts.length - 1]
    : Number.NEGATIVE_INFINITY;

  // Candidate departures only ever move forward, so each window's set of
  // possibly-overlapping blocks only ever grows: a cursor walks it once in
  // total instead of being re-derived on every attempt. A window whose blocks
  // are all behind the candidate can never come back, so it leaves the scan
  // for good and later attempts only look at what is still in the way.
  const cursors = new Int32Array(contested.length);
  let active = contested.length;

  for (
    let step = 0;
    step < MAX_SEARCH_STEPS && departure <= latestDeparture + EPSILON;
    step += 1
  ) {
    let jump = departure;
    let impossible = false;
    for (let index = 0; index < active; index += 1) {
      const { window: proposed, calendar } = contested[index];
      const starts = calendar.starts;
      const limit = proposed.end + departure - EPSILON;
      let cursor = cursors[index];
      while (cursor < starts.length && starts[cursor] < limit) cursor += 1;
      cursors[index] = cursor;
      // Only the block reaching furthest past this window can set the jump;
      // every other overlap it hides would move the departure less.
      const blockedUntil =
        cursor === 0
          ? Number.NEGATIVE_INFINITY
          : calendar.runningEnd[cursor - 1];
      if (!(proposed.start + departure < blockedUntil - EPSILON)) {
        // Nothing is left to walk into and this window already clears what it
        // found, so no later, later-still departure can be blocked by it.
        if (cursor === starts.length) {
          active -= 1;
          contested[index] = contested[active];
          cursors[index] = cursors[active];
          index -= 1;
        }
        continue;
      }
      if (!Number.isFinite(blockedUntil)) {
        impossible = true;
        break;
      }
      const candidate = blockedUntil - proposed.start;
      if (candidate > jump) jump = candidate;
    }
    if (impossible) return null;

    // A final berth becomes a durable tail commitment at plan end. Delay the
    // entire plan until every already-approved finite visit to that berth is over.
    const proposedEnd = departure + duration;
    if (finalEnd > proposedEnd + EPSILON) {
      if (!Number.isFinite(finalEnd)) return null;
      jump = Math.max(jump, finalEnd - duration);
    }

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
        reservations.some((reservation) => {
          const calendar = calendars.get(reservation.resource);
          if (!calendar) return false;
          const blockedUntil = latestEndBefore(
            calendar,
            reservation.end - EPSILON,
          );
          return reservation.start < blockedUntil - EPSILON;
        })
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
  const owners = terminalOwnerIndex(world);
  const pending = new Set(world.pendingEdits.map((edit) => edit.id));

  const add = (berth: Berth) => {
    if (
      berth.kind !== "parking" ||
      seen.has(berth.id) ||
      !(owners.get(berth.id) ?? []).every((ownerId) => ownerId === pod.id) ||
      pending.has(berth.id)
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
      const length = routeLength(world, dropoff, berth);
      return length === null ? [] : [{ berth, distance: length }];
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

function idlePodFailure(pod: Pod): (PlanResult & { ok: false }) | null {
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

/**
 * Build a complete empty-to-pickup, loaded, and terminal-parking candidate.
 *
 * Only the plan's identity fields depend on the passenger, so the search itself
 * is shared by everyone waiting for the same Pod between the same platforms —
 * the common case in a rush-hour queue. Segments and reservations are copied
 * out of the shared result so no two callers ever hold the same arrays.
 */
export function planService(
  world: World,
  pod: Pod,
  resident: Resident,
  pickup: Berth,
  dropoff: Berth,
): PlanResult {
  const cache = planningCache(world);
  const key = `${pod.id}\u0000${pickup.id}\u0000${dropoff.id}`;
  let outcome = cache.byService.get(key);
  if (!outcome) {
    outcome = computeService(world, pod, pickup, dropoff);
    cache.byService.set(key, outcome);
  }
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const requestedAt = resident.journey?.startedAt ?? world.time;
  return {
    ok: true,
    plan: {
      id: `service:${pod.id}:${resident.id}:${requestedAt}`,
      podId: pod.id,
      residentId: resident.id,
      originBerthId: outcome.originBerthId,
      finalBerthId: outcome.finalBerthId,
      pickupId: outcome.pickupId,
      dropoffId: outcome.dropoffId,
      requestedAt,
      departure: outcome.departure,
      pickupStart: outcome.pickupStart,
      pickupEnd: outcome.pickupEnd,
      dropoffStart: outcome.dropoffStart,
      dropoffEnd: outcome.dropoffEnd,
      end: outcome.end,
      safetyBuffer: 1,
      segments: outcome.segments.map((segment) => ({ ...segment })),
      reservations: outcome.reservations.map((reservation) => ({
        ...reservation,
      })),
    },
  };
}

function computeService(
  world: World,
  pod: Pod,
  pickup: Berth,
  dropoff: Berth,
): ServiceOutcome {
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
  const calendars = blockedResources(world, pod.id);
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
        calendars,
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
  const { departure } = best.scheduled;
  return {
    ok: true,
    originBerthId: origin.id,
    finalBerthId: best.terminal.berth.id,
    pickupId: actualPickup.id,
    dropoffId: actualDropoff.id,
    departure,
    pickupStart: best.template.pickupStart + departure,
    pickupEnd: best.template.pickupEnd + departure,
    dropoffStart: best.template.dropoffStart + departure,
    dropoffEnd: best.template.dropoffEnd + departure,
    end: best.scheduled.segments.at(-1)!.end,
    segments: best.scheduled.segments,
    reservations: best.scheduled.reservations,
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
  const calendars = blockedResources(world, pod.id);
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
      calendars,
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
  // Only blocks on the same resource can conflict, and grouping keeps them in
  // the order a scan of the whole list would have met them, so the first
  // conflict reported is still the first conflict there is.
  const blocksByResource = new Map<string, TimedBlock[]>();
  for (const block of blocks) {
    const group = blocksByResource.get(block.resource);
    if (group) group.push(block);
    else blocksByResource.set(block.resource, [block]);
  }
  for (const reservation of reservations) {
    const conflict = blocksByResource
      .get(reservation.resource)
      ?.find((block) =>
        overlaps(reservation.start, reservation.end, block.start, block.end),
      );
    if (conflict) {
      throw new Error(
        `Cannot commit plan ${plan.id}: resource ${reservation.resource} conflicts with ${conflict.ownerId}`,
      );
    }
  }
  const finalResource = berthResource(plan.finalBerthId);
  const futureFinalConflict = blocksByResource
    .get(finalResource)
    ?.find((block) => block.end > plan.end + EPSILON);
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
