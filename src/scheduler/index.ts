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
  Point,
  Pod,
  Reservation,
  Resident,
  ServicePlan,
  World,
} from "../shared/types";
import {
  findTrackPath,
  findTrackPathOptions,
  movementResourceOptions,
  nodeKey,
  trackPathLength,
  trackResources,
} from "../network";
import {
  assertTrajectory,
  ensureRanked,
  mergeSortedTrajectoryWindows,
  mergeTrajectoryWindows,
  resourceRank,
  sortResources,
  trajectoryWindowRange,
} from "../shared/trajectory";

const PLANNING_WINDOW_SECONDS = 1_800;
const MAX_SEARCH_STEPS = 4_096;
/**
 * How many parking berths a service weighs, nearest to the drop-off first.
 *
 * A Pod parks where it finishes; a bay on the far side of the city costs empty
 * running nobody is paid for, and in a city with hundreds of bays, pricing them
 * all is most of the work a request that finds nothing ever does. Measured on a
 * congested morning, every plan that was found parked within the first nine.
 */
const MAX_SERVICE_TERMINALS = 12;
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

interface GeometryCache {
  version: number;
  berths: Berth[];
  paths: Map<string, Point[][]>;
  templates: Map<string, ReturnType<typeof computeServiceTemplate>>;
  openings: Map<string, RelativeReservation[]>;
}
const geometryCaches = new WeakMap<World, GeometryCache>();
const pathIds = new WeakMap<Point[], number>();
let nextPathId = 0;
const compiledWindows = new WeakMap<MotionSegment[], RelativeReservation[]>();
const compiledOpenings = new WeakMap<MotionSegment[], RelativeReservation[]>();
const navigationCaches = new WeakMap<
  World,
  {
    stamp: string;
    tracks: World["tracks"];
    berths: Berth[];
    view: World;
  }
>();

/** Navigation only: physical reservation resources always use the real world. */
export function planningNetwork(world: World): World {
  if (!world.pendingEdits.length) return world;
  const stamp = JSON.stringify([world.networkVersion, world.pendingEdits]);
  const cached = navigationCaches.get(world);
  if (
    cached?.stamp === stamp &&
    cached.tracks === world.tracks &&
    cached.berths === world.berths
  )
    return cached.view;
  const nodes = new Set<string>();
  const resources = new Set<string>();
  for (const edit of world.pendingEdits) {
    if (edit.type !== "remove-track" && edit.type !== "upgrade-track") continue;
    const track = world.tracks.find((item) => item.id === edit.id);
    if (!track) continue;
    if (edit.type === "remove-track") {
      nodes.add(nodeKey(track.a));
      nodes.add(nodeKey(track.b));
    }
    for (const resource of trackResources(world, track))
      resources.add(resource);
  }
  const view = {
    ...world,
    tracks: world.tracks.filter(
      (track) =>
        !nodes.has(nodeKey(track.a)) &&
        !nodes.has(nodeKey(track.b)) &&
        !trackResources(world, track).some((resource) =>
          resources.has(resource),
        ),
    ),
    berths: world.berths.filter(
      (berth) =>
        !nodes.has(nodeKey(berth.point)) && !nodes.has(nodeKey(berth.access)),
    ),
  };
  navigationCaches.set(world, {
    stamp,
    tracks: world.tracks,
    berths: world.berths,
    view,
  });
  return view;
}

function geometryCache(world: World): GeometryCache {
  world = planningNetwork(world);
  let cache = geometryCaches.get(world);
  if (
    !cache ||
    cache.version !== world.networkVersion ||
    cache.berths !== world.berths
  ) {
    cache = {
      version: world.networkVersion,
      berths: world.berths,
      paths: new Map(),
      templates: new Map(),
      openings: new Map(),
    };
    geometryCaches.set(world, cache);
  }
  return cache;
}
function pathId(path: Point[]): number {
  let id = pathIds.get(path);
  if (id === undefined) {
    id = ++nextPathId;
    pathIds.set(path, id);
  }
  return id;
}

function route(world: World, from: Berth, to: Berth) {
  if (samePoint(from.point, to.point)) return [from.point];
  const cache = geometryCache(world);
  const key = `single:${from.id}:${to.id}`;
  const cached = cache.paths.get(key);
  if (cached) return cached[0] ?? null;
  const path = findTrackPath(planningNetwork(world), from.point, to.point);
  if (cache.paths.size >= 4096)
    cache.paths.delete(cache.paths.keys().next().value!);
  cache.paths.set(key, path ? [path] : []);
  return path;
}

/**
 * Every route this leg could take, shortest first.
 *
 * The scheduler cannot make a Pod wait halfway, so a contested corridor can
 * only be answered by leaving later — or by going a different way. Offering the
 * other ways here is what lets the search choose between the two.
 */
function routeOptions(world: World, from: Berth, to: Berth): Point[][] {
  const cache = geometryCache(world);
  const key = `options:${from.id}:${to.id}`;
  const cached = cache.paths.get(key);
  if (cached) return cached;
  const paths = findTrackPathOptions(
    planningNetwork(world),
    from.point,
    to.point,
  );
  if (cache.paths.size >= 4096)
    cache.paths.delete(cache.paths.keys().next().value!);
  cache.paths.set(key, paths);
  return paths;
}

const travelSeconds = (path: Point[]) =>
  (pathLength(path) * CELL_METERS) / POD_METERS_PER_SECOND;

/**
 * What a set of legs would occupy, listed generously enough to answer "would
 * this route still run into that?" and no more. It deliberately stops short of
 * the junction channels a full trajectory also books: missing one can only make
 * a route look more promising than it is, which costs a search, while claiming
 * one it does not use would hide a route that works.
 */
function routeFootprint(world: World, paths: Point[][]): Set<string> {
  const footprint = new Set<string>();
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 1) {
      footprint.add(nodeKey(path[index]));
      if (index === 0) continue;
      for (const option of movementResourceOptions(
        world,
        path[index - 1],
        path[index],
      ))
        for (const resource of option) footprint.add(resource);
    }
  }
  return footprint;
}

/** Whether a route sidesteps anything that held the incumbent up. */
function relieves(blockers: Set<string>, footprint: Set<string>): boolean {
  for (const blocker of blockers) if (!footprint.has(blocker)) return true;
  return false;
}

/** Which of a leg's ways round a caller is asking about. */
export type RouteScope = "all" | "direct" | "detours";

interface RouteVariant {
  emptyPath: Point[];
  loadedPath: Point[];
  /** The leg this variant reroutes; the other one stays the shortest. */
  diverted: Point[];
}

/**
 * The leg pairings worth trying, the all-shortest one first.
 *
 * Only one leg is diverted at a time: two simultaneous detours cost more than
 * they can usually recover, and the pairings would multiply rather than add.
 * The loaded leg comes first at every depth because that is the one a passenger
 * is sitting in.
 */
function routeVariants(empties: Point[][], loadeds: Point[][]): RouteVariant[] {
  const variants: RouteVariant[] = [
    { emptyPath: empties[0], loadedPath: loadeds[0], diverted: [] },
  ];
  const depth = Math.max(empties.length, loadeds.length);
  for (let step = 1; step < depth; step += 1) {
    if (step < loadeds.length)
      variants.push({
        emptyPath: empties[0],
        loadedPath: loadeds[step],
        diverted: loadeds[step],
      });
    if (step < empties.length)
      variants.push({
        emptyPath: empties[step],
        loadedPath: loadeds[0],
        diverted: empties[step],
      });
  }
  return variants;
}

/** Length of `route`, or null where `route` yields nothing usable. */
function routeLength(world: World, from: Berth, to: Berth): number | null {
  if (samePoint(from.point, to.point)) return 0;
  return trackPathLength(planningNetwork(world), from.point, to.point);
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

/**
 * The windows a candidate owes, given the ones its shared opening already owes.
 *
 * Every terminal a service could park at replays the same run to the pickup and
 * the same run with the passenger aboard; only the tail differs. The opening is
 * derived once and handed in here, so what a terminal costs is the tail it adds
 * rather than the whole trajectory over again.
 */
function relativeReservations(
  world: World,
  segments: MotionSegment[],
  prefix: RelativeReservation[],
  prefixLength: number,
): RelativeReservation[] {
  const cached = compiledWindows.get(segments);
  if (cached) return cached;
  if (prefixLength >= segments.length) return prefix;
  const windows = mergeSortedTrajectoryWindows(
    prefix,
    mergeTrajectoryWindows(
      trajectoryWindowRange(world, segments, prefixLength, segments.length, 1),
    ),
  );
  compiledWindows.set(segments, windows);
  return windows;
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

function terminalBlocks(
  world: World,
  excluded: ReadonlySet<string>,
): TimedBlock[] {
  const blocks: TimedBlock[] = [];
  for (const pod of world.pods) {
    if (excluded.has(pod.id)) continue;
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

function existingBlocks(
  world: World,
  excluded: ReadonlySet<string>,
): TimedBlock[] {
  const blocks: TimedBlock[] = [];
  for (const reservation of world.reservations)
    if (
      !excluded.has(reservation.ownerId) &&
      Number.isFinite(reservation.start) &&
      Number.isFinite(reservation.end) &&
      reservation.end > world.time
    )
      blocks.push(reservation);
  for (const block of terminalBlocks(world, excluded)) blocks.push(block);
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

/**
 * What one Pod has to fit into: everything the city holds, minus its own.
 *
 * Every idle Pod reads the same few thousand resources and differs on the
 * handful it wrote itself, so the shared table is read through rather than
 * copied once per query. An entry in `own` overrides the shared one; `null`
 * there means the Pod was the only claimant and the resource is free to it.
 */
interface Calendars {
  own: Map<string, ResourceCalendar | null>;
  shared: Map<string, ResourceCalendar>;
}

function calendarFor(
  calendars: Calendars,
  resource: string,
): ResourceCalendar | undefined {
  const own = calendars.own.get(resource);
  return own !== undefined
    ? (own ?? undefined)
    : calendars.shared.get(resource);
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
  reservationCount: number;
  pods: Pod[];
  berths: Berth[];
  networkVersion: number;
  pendingEdits: World["pendingEdits"];
  pendingIds: string[];
  time: number;
  stamp: (string | number | null | undefined)[];
  byPod: Map<string, Calendars>;
  byService: Map<string, ServiceOutcome>;
  owners?: Map<string, string[]>;
  shared?: Map<string, ResourceCalendar>;
  blocksByResource?: Map<string, TimedBlock[]>;
  ownedResources?: Map<string, Set<string>>;
  parking?: Map<string, number>;
  berthById?: Map<string, Berth>;
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
  if (cache.pendingIds.length !== world.pendingEdits.length) return false;
  for (let index = 0; index < world.pendingEdits.length; index += 1)
    if (cache.pendingIds[index] !== JSON.stringify(world.pendingEdits[index]))
      return false;
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
    cache.reservationCount === world.reservations.length &&
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
    reservationCount: world.reservations.length,
    pods: world.pods,
    berths: world.berths,
    networkVersion: world.networkVersion,
    pendingEdits: world.pendingEdits,
    pendingIds: world.pendingEdits.map((edit) => JSON.stringify(edit)),
    time: world.time,
    stamp: planStamp(world.pods),
    byPod: new Map(),
    byService: new Map(),
  };
  calendarCaches.set(world, fresh);
  return fresh;
}

/** Every berth by id, for one planning state. */
function berthIndex(world: World): Map<string, Berth> {
  const cache = planningCache(world);
  if (!cache.berthById)
    cache.berthById = new Map(world.berths.map((berth) => [berth.id, berth]));
  return cache.berthById;
}

function blockedResources(world: World, podId: string): Calendars {
  const cache = planningCache(world);
  const cached = cache.byPod.get(podId);
  if (cached) return cached;
  if (!cache.shared) {
    const blocks = existingBlocks(world, new Set());
    cache.shared = buildCalendars(blocks);
    cache.blocksByResource = new Map();
    cache.ownedResources = new Map();
    for (const block of blocks) {
      const group = cache.blocksByResource.get(block.resource) ?? [];
      group.push(block);
      cache.blocksByResource.set(block.resource, group);
      const owned =
        cache.ownedResources.get(block.ownerId) ?? new Set<string>();
      owned.add(block.resource);
      cache.ownedResources.set(block.ownerId, owned);
    }
  }
  // Share every unaffected calendar; remove only this Pod's own commitments.
  const own = new Map<string, ResourceCalendar | null>();
  for (const resource of cache.ownedResources!.get(podId) ?? []) {
    const others = cache
      .blocksByResource!.get(resource)!
      .filter((block) => block.ownerId !== podId);
    own.set(
      resource,
      others.length ? buildCalendars(others).get(resource)! : null,
    );
  }
  const calendars: Calendars = { own, shared: cache.shared! };
  cache.byPod.set(podId, calendars);
  return calendars;
}

/**
 * The calendar a Pod has to fit into, grouped by resource. It only depends on
 * the world and the Pod, so one planning call shares it across every terminal,
 * lane profile and candidate departure it tries.
 */
function buildCalendars(blocks: TimedBlock[]): Map<string, ResourceCalendar> {
  const grouped = new Map<string, TimedBlock[]>();
  for (const block of blocks) {
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

/**
 * A departure the search has settled on, with the windows it was settled
 * against.
 *
 * Out of the hundreds of candidates a plan weighs, exactly one is ever
 * committed. What that costs to build — shifting every segment, merging every
 * reservation — is therefore left to `commitDeparture`, and a losing candidate
 * pays for none of it.
 */
interface Departure {
  departure: number;
  /** Owed windows relative to departure. Read-only: openings are shared. */
  relative: RelativeReservation[];
}

/** When the whole plan ends, without building it. */
function departureEnd(template: MotionSegment[], settled: Departure): number {
  return settled.departure + (template[template.length - 1]?.end ?? 0);
}

/** The absolute segments and reservations a settled departure stands for. */
function commitDeparture(
  world: World,
  pod: Pod,
  origin: Berth,
  template: MotionSegment[],
  settled: Departure,
): { segments: MotionSegment[]; reservations: Reservation[] } {
  const { departure, relative } = settled;
  return {
    segments: absoluteSegments(template, departure),
    reservations: mergeReservations(
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
    ),
  };
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

interface WindowScan {
  contested: { window: RelativeReservation; calendar: ResourceCalendar }[];
  cursors: Int32Array;
  active: number;
  /** The resource that set the jump last returned, where one did. */
  binding: string | null;
  /** A resource whose hold never ends, met on the last pass. */
  never: string | null;
}

/**
 * Prepares to weigh a trajectory's windows against what already holds them.
 *
 * Only the windows that can actually collide are kept; on a quiet resource
 * there is nothing to compare against.
 */
function beginScan(
  windows: RelativeReservation[],
  calendars: Calendars,
): WindowScan {
  const contested: WindowScan["contested"] = [];
  for (const proposed of windows) {
    const calendar = calendarFor(calendars, proposed.resource);
    if (calendar?.starts.length) contested.push({ window: proposed, calendar });
  }
  return {
    contested,
    cursors: new Int32Array(contested.length),
    active: contested.length,
    binding: null,
    never: null,
  };
}

/**
 * The soonest departure after this one that some window still objects to, or
 * this one when none does.
 *
 * Candidate departures only ever move forward, so each window's set of
 * possibly-overlapping blocks only ever grows: a cursor walks it once in total
 * instead of being re-derived on every attempt. A window whose blocks are all
 * behind the candidate can never come back, so it leaves the scan for good and
 * later attempts only look at what is still in the way. That state lives in the
 * scan, so it must be walked forward in time and never reused for an earlier
 * departure.
 */
function scanDeparture(scan: WindowScan, departure: number): number {
  const { contested, cursors } = scan;
  let jump = departure;
  scan.binding = null;
  scan.never = null;
  for (let index = 0; index < scan.active; index += 1) {
    const { window: proposed, calendar } = contested[index];
    const starts = calendar.starts;
    const limit = proposed.end + departure - EPSILON;
    let cursor = cursors[index];
    while (cursor < starts.length && starts[cursor] < limit) cursor += 1;
    cursors[index] = cursor;
    // Only the block reaching furthest past this window can set the jump;
    // every other overlap it hides would move the departure less.
    const blockedUntil =
      cursor === 0 ? Number.NEGATIVE_INFINITY : calendar.runningEnd[cursor - 1];
    if (!(proposed.start + departure < blockedUntil - EPSILON)) {
      // Nothing is left to walk into and this window already clears what it
      // found, so no later, later-still departure can be blocked by it.
      if (cursor === starts.length) {
        scan.active -= 1;
        contested[index] = contested[scan.active];
        cursors[index] = cursors[scan.active];
        index -= 1;
      }
      continue;
    }
    if (!Number.isFinite(blockedUntil)) {
      scan.never = proposed.resource;
      return departure;
    }
    const candidate = blockedUntil - proposed.start;
    if (candidate > jump) {
      jump = candidate;
      scan.binding = proposed.resource;
    }
  }
  return jump;
}

/** What is known about when a shared opening can be left. */
type OpeningBound =
  { kind: "clears"; at: number } | { kind: "never" } | { kind: "unknown" };

/**
 * The soonest a shared opening could be left, whatever a candidate does after.
 *
 * Every terminal a service might park at owes these same windows first, so none
 * of them can leave before the opening clears. That makes this a floor under
 * every candidate's departure, and it settles two questions at once: reaching
 * the floor proves no terminal further down the list departs sooner, and a
 * floor that leaves too little of the planning window for the run itself proves
 * no terminal has a plan in it at all.
 *
 * `never` is a hold on the shared run that does not end, which no terminal can
 * wait out. `unknown` is the search giving up first — nothing is proven then,
 * and every terminal is priced as it was before.
 */
function openingFloor(
  world: World,
  opening: RelativeReservation[],
  calendars: Calendars,
  blockers?: Set<string>,
): OpeningBound {
  const scan = beginScan(opening, calendars);
  let departure = world.time;
  for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
    const jump = scanDeparture(scan, departure);
    if (scan.never) {
      blockers?.add(scan.never);
      return { kind: "never" };
    }
    if (jump <= departure + EPSILON) return { kind: "clears", at: departure };
    if (scan.binding) blockers?.add(scan.binding);
    departure = jump;
  }
  return { kind: "unknown" };
}

/**
 * Records the resources that actually pushed a departure back, so a caller can
 * tell whether going a different way would have met the same obstacle.
 */
function searchDeparture(
  world: World,
  pod: Pod,
  origin: Berth,
  finalBerth: Berth,
  template: MotionSegment[],
  calendars: Calendars,
  prefix: RelativeReservation[],
  prefixLength: number,
  floor: number,
  blockers?: Set<string>,
  departureLimit = Infinity,
): Departure | null {
  const relative = relativeReservations(world, template, prefix, prefixLength);
  const duration = template[template.length - 1]?.end ?? 0;
  if (duration > PLANNING_WINDOW_SECONDS + EPSILON) return null;
  const latestDeparture = Math.min(
    departureLimit,
    world.time + Math.max(0, PLANNING_WINDOW_SECONDS - duration),
  );
  // Nothing this candidate owes can be met before the run it shares with every
  // other candidate has cleared, so the search opens there rather than walking
  // the same jumps up to it once per terminal.
  let departure = Math.max(world.time, floor);

  const scan = beginScan(relative, calendars);
  const finalCalendar = calendarFor(calendars, berthResource(finalBerth.id));
  const finalEnd = finalCalendar?.starts.length
    ? finalCalendar.runningEnd[finalCalendar.starts.length - 1]
    : Number.NEGATIVE_INFINITY;

  for (
    let step = 0;
    step < MAX_SEARCH_STEPS && departure <= latestDeparture + EPSILON;
    step += 1
  ) {
    let jump = scanDeparture(scan, departure);
    let binding = scan.binding;
    if (scan.never) {
      blockers?.add(scan.never);
      return null;
    }

    // A final berth becomes a durable tail commitment at plan end. Delay the
    // entire plan until every already-approved finite visit to that berth is over.
    const proposedEnd = departure + duration;
    if (finalEnd > proposedEnd + EPSILON) {
      if (!Number.isFinite(finalEnd)) {
        blockers?.add(berthResource(finalBerth.id));
        return null;
      }
      if (finalEnd - duration > jump) {
        jump = finalEnd - duration;
        binding = berthResource(finalBerth.id);
      }
    }

    if (jump <= departure + EPSILON) {
      // The scan above has cleared every window the trajectory owns. The one
      // claim it never saw is the berth the Pod holds while it waits out a
      // delayed departure, so that interval — joined to whatever the
      // trajectory itself owes the same berth — is all that is left to check.
      if (departure > world.time + EPSILON) {
        const resource = berthResource(origin.id);
        const held: RelativeReservation[] = [
          { resource, start: world.time, end: departure },
        ];
        for (const window of relative) {
          if (window.resource !== resource) continue;
          held.push({
            resource,
            start: window.start + departure,
            end: window.end + departure,
          });
        }
        const calendar = calendarFor(calendars, resource);
        if (calendar) {
          for (const reservation of mergeRelativeReservations(held)) {
            const blockedUntil = latestEndBefore(
              calendar,
              reservation.end - EPSILON,
            );
            if (reservation.start < blockedUntil - EPSILON) return null;
          }
        }
      }
      return { departure, relative };
    }
    if (binding) blockers?.add(binding);
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
  for (const candidate of nearbyParking) {
    add(candidate.berth);
    if (candidates.length >= MAX_SERVICE_TERMINALS) break;
  }
  // Where the Pod already stands is always worth keeping, however far out the
  // drop-off leaves it: it is the one berth nothing else can be holding.
  add(origin);
  return candidates;
}

function idlePodFailure(pod: Pod): (PlanResult & { ok: false }) | null {
  if (pod.plan !== null || pod.berthId === null)
    return { ok: false, reason: "no-pod" };
  return null;
}

function serviceTemplate(
  world: World,
  emptyPath: Point[],
  loadedPath: Point[],
  relocationPath: Point[],
  pickup: Berth,
  dropoff: Berth,
  finalBerth: Berth,
  laneProfile: number,
): ReturnType<typeof computeServiceTemplate> {
  const cache = geometryCache(world);
  const key = `${pathId(emptyPath)}:${pathId(loadedPath)}:${pathId(relocationPath)}:${pickup.id}:${dropoff.id}:${finalBerth.id}:${laneProfile}`;
  const cached = cache.templates.get(key);
  if (cached) return cached;
  const template = computeServiceTemplate(
    world,
    emptyPath,
    loadedPath,
    relocationPath,
    pickup,
    dropoff,
    finalBerth,
    laneProfile,
  );
  if (cache.templates.size >= 1024)
    cache.templates.delete(cache.templates.keys().next().value!);
  cache.templates.set(key, template);
  return template;
}

/**
 * What a service owes up to the moment the passenger steps out.
 *
 * The terminal is chosen after all of this has already happened, and nothing
 * inside the opening can see past the alighting dwell, so every terminal that
 * shares the two legs and the lane shares this list as well — including the
 * ones a later request, or a later Pod, asks about. It is geometry, so it
 * outlives the reservations it will be weighed against.
 */
function openingReservations(
  world: World,
  emptyPath: Point[],
  loadedPath: Point[],
  pickup: Berth,
  dropoff: Berth,
  laneProfile: number,
  template: ReturnType<typeof serviceTemplate>,
): RelativeReservation[] {
  const cache = geometryCache(world);
  const key = `${pathId(emptyPath)}:${pathId(loadedPath)}:${pickup.id}:${dropoff.id}:${laneProfile}`;
  const cached = cache.openings.get(key);
  if (cached) return cached;
  const opening = mergeTrajectoryWindows(
    trajectoryWindowRange(
      world,
      template.segments.slice(0, template.prefixLength),
      0,
      template.prefixLength,
      1,
    ),
  );
  if (cache.openings.size >= 2048)
    cache.openings.delete(cache.openings.keys().next().value!);
  cache.openings.set(key, opening);
  return opening;
}

function computeServiceTemplate(
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
  prefixLength: number;
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
  // Everything up to here is the same whichever berth the Pod parks at.
  const prefixLength = segments.length;
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
  return {
    segments,
    prefixLength,
    pickupStart,
    pickupEnd,
    dropoffStart,
    dropoffEnd,
  };
}

/**
 * Build a complete empty-to-pickup, loaded, and terminal-parking candidate.
 *
 * Only the plan's identity fields depend on the passenger, so the search itself
 * is shared by everyone waiting for the same Pod between the same platforms —
 * the common case in a rush-hour queue. Segments and reservations are copied
 * out of the shared result so no two callers ever hold the same arrays.
 * `latestArrival` is an exclusive drop-off deadline, after the caller subtracts
 * egress walking time from its incumbent door-to-door arrival. Failure under a
 * deadline says nothing about unbounded feasibility; its cache key is separate.
 */
export function planService(
  world: World,
  pod: Pod,
  resident: Resident,
  pickup: Berth,
  dropoff: Berth,
  latestArrival = Infinity,
  routes: RouteScope = "all",
): PlanResult {
  const cache = planningCache(world);
  const key = `${pod.id}\u0000${pickup.id}\u0000${dropoff.id}\u0000${latestArrival}\u0000${routes}`;
  let outcome = cache.byService.get(key);
  if (!outcome) {
    outcome = computeService(
      world,
      pod,
      pickup,
      dropoff,
      latestArrival,
      routes,
    );
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
  latestArrival: number,
  routes: RouteScope = "all",
): ServiceOutcome {
  const podFailure = idlePodFailure(pod);
  if (podFailure) return podFailure;
  const berths = berthIndex(world);
  const actualPickup = berths.get(pickup.id);
  const actualDropoff = berths.get(dropoff.id);
  if (
    !actualPickup ||
    !actualDropoff ||
    actualPickup.kind !== "platform" ||
    actualDropoff.kind !== "platform"
  ) {
    return { ok: false, reason: "no-platform" };
  }
  const origin = pod.berthId ? berths.get(pod.berthId) : undefined;
  if (!origin) return { ok: false, reason: "no-pod" };
  if (
    world.pendingEdits.some((edit) =>
      [origin.id, actualPickup.id, actualDropoff.id].includes(edit.id),
    )
  )
    return { ok: false, reason: "platform-busy" };
  if (
    occupiedByIdlePod(world, actualPickup.id, pod.id) ||
    occupiedByIdlePod(world, actualDropoff.id, pod.id)
  ) {
    return { ok: false, reason: "platform-busy" };
  }

  const emptyRoutes = routeOptions(world, origin, actualPickup);
  const loadedRoutes = routeOptions(world, actualPickup, actualDropoff);
  if (!emptyRoutes.length || !loadedRoutes.length) {
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
        scheduled: Departure;
        laneProfile: number;
        variant: number;
      }
    | undefined;
  const calendars = blockedResources(world, pod.id);
  const variants = routeVariants(emptyRoutes, loadedRoutes);
  // "detours" resumes where "direct" stopped: the shortest pairing has already
  // been priced under a deadline no looser than this one, so pricing it twice
  // can only return the same answer.
  const first = routes === "detours" ? 1 : 0;
  const last = routes === "direct" ? 1 : variants.length;
  const blockers = new Set<string>();
  for (let variant = first; variant < last; variant += 1) {
    const { emptyPath, loadedPath } = variants[variant];
    const duration =
      travelSeconds(emptyPath) +
      BOARD_SECONDS +
      travelSeconds(loadedPath) +
      ALIGHT_SECONDS;
    const cannotImprove = (arrival: number) =>
      arrival >= latestArrival - EPSILON ||
      (best !== undefined &&
        arrival >
          best.template.dropoffEnd + best.scheduled.departure + EPSILON);
    // These are optimistic bounds, not guesses about which detour/Pod works.
    if (cannotImprove(world.time + duration)) continue;
    // One opening per lane profile, shared by every terminal that follows.
    const openings: (RelativeReservation[] | undefined)[] = [];
    const bounds: OpeningBound[] = [];
    // A floor bounds nothing until every lane profile has been weighed, and
    // they all are while the first terminal is priced — so from the second on.
    let floor: number | null = null;
    const scope = terminals;
    for (let index = 0; index < scope.length; index += 1) {
      // Prune the group before constructing any of its terminal templates.
      if (floor !== null && cannotImprove(floor + duration)) break;
      const terminal = scope[index];
      if (!pathIsUsable(terminal.relocationPath)) continue;
      let hopeless = false;
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
        // Openings are settled before a repeated lane profile is dropped: what
        // a lane profile owes up to the drop-off is the same whichever terminal
        // asked for it, and a floor is only a floor once they all have one.
        let opening = openings[laneProfile];
        if (!opening) {
          opening = openingReservations(
            world,
            emptyPath,
            loadedPath,
            actualPickup,
            actualDropoff,
            laneProfile,
            template,
          );
          openings[laneProfile] = opening;
          // A shared prefix floor earns its scan by pruning later terminals.
          // With only one terminal, the full departure scan suffices.
          bounds[laneProfile] =
            scope.length > 1
              ? openingFloor(
                  world,
                  opening,
                  calendars,
                  variant === 0 ? blockers : undefined,
                )
              : { kind: "unknown" };
        }
        // A candidate cannot leave before the opening every terminal shares has
        // cleared. Where even that leaves the planning window too short for the
        // run itself, this terminal has no plan in it — and nor has any
        // terminal further out, since the list only reaches further from here.
        if (
          floor !== null &&
          floor + (template.segments[template.segments.length - 1]?.end ?? 0) >
            world.time + PLANNING_WINDOW_SECONDS + EPSILON
        ) {
          hopeless = true;
          break;
        }
        const bound = bounds[laneProfile];
        if (
          bound.kind === "never" ||
          (bound.kind === "clears" &&
            cannotImprove(bound.at + template.dropoffEnd))
        )
          continue;
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
          opening,
          template.prefixLength,
          floor ?? world.time,
          variant === 0 ? blockers : undefined,
          Math.min(
            latestArrival,
            best
              ? best.template.dropoffEnd + best.scheduled.departure + EPSILON
              : Infinity,
          ) - template.dropoffEnd,
        );
        if (!scheduled) continue;
        const arrival = template.dropoffEnd + scheduled.departure;
        if (arrival >= latestArrival - EPSILON) continue;
        const bestArrival = best
          ? best.template.dropoffEnd + best.scheduled.departure
          : Number.POSITIVE_INFINITY;
        const end = departureEnd(template.segments, scheduled);
        const bestEnd = best
          ? departureEnd(best.template.segments, best.scheduled)
          : Number.POSITIVE_INFINITY;
        // Within one route, leaving earliest is leaving best: every candidate
        // covers the same ground, so the ranking is the one it always was.
        // Between routes it cannot be — a detour that leaves now to arrive late
        // helps nobody — so those are judged on when the passenger gets out,
        // and a tie leaves the shorter route in place.
        const improves = !best
          ? true
          : best.variant !== variant
            ? arrival < bestArrival - EPSILON ||
              (Math.abs(arrival - bestArrival) <= EPSILON &&
                end < bestEnd - EPSILON)
            : scheduled.departure < best.scheduled.departure - EPSILON ||
              (Math.abs(scheduled.departure - best.scheduled.departure) <=
                EPSILON &&
                (arrival < bestArrival - EPSILON ||
                  (Math.abs(arrival - bestArrival) <= EPSILON &&
                    (end < bestEnd - EPSILON ||
                      (Math.abs(end - bestEnd) <= EPSILON &&
                        laneProfile < best.laneProfile)))));
        if (improves) {
          best = { terminal, template, scheduled, laneProfile, variant };
        }
      }
      if (hopeless) break;
      // A lane profile the opening never clears rules its own candidates out
      // rather than lowering the bound; one the search gave up on proves
      // nothing, and leaves every terminal to be priced as before.
      if (floor === null && bounds.length === 3) {
        const clears = bounds.flatMap((bound) =>
          bound.kind === "clears" ? [bound.at] : [],
        );
        if (!clears.length && bounds.every((bound) => bound.kind === "never"))
          break;
        if (clears.length && bounds.every((bound) => bound.kind !== "unknown"))
          floor = Math.min(...clears);
      }
      // Nothing can leave before the opening every terminal shares has cleared,
      // so a terminal that leaves exactly then cannot be beaten to the drop-off
      // — and the list runs from the nearest parking berth outwards, so nothing
      // behind it finishes sooner either. Berths the same distance out are
      // still priced: those can finish level and win on the lane they take.
      const held = best?.terminal.relocationPath;
      if (
        floor !== null &&
        best &&
        held &&
        best.variant === variant &&
        best.scheduled.departure <= floor + EPSILON
      ) {
        const next = scope[index + 1]?.relocationPath;
        if (!next || pathLength(next) > pathLength(held) + EPSILON) break;
      }
    }
  }
  if (!best) {
    return { ok: false, reason: "track-busy" };
  }
  const { departure } = best.scheduled;
  const committed = commitDeparture(
    world,
    pod,
    origin,
    best.template.segments,
    best.scheduled,
  );
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
    end: committed.segments.at(-1)!.end,
    segments: committed.segments,
    reservations: committed.reservations,
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
  const relocationRoutes = routeOptions(world, origin, actualTarget);
  if (!relocationRoutes.length) return { ok: false, reason: "disconnected" };

  let scheduled: Departure | null = null;
  let bestTemplate: MotionSegment[] = [];
  let bestVariant = -1;
  const calendars = blockedResources(world, pod.id);
  const blockers = new Set<string>();
  for (let variant = 0; variant < relocationRoutes.length; variant += 1) {
    const relocationPath = relocationRoutes[variant];
    if (variant > 0) {
      if (!blockers.size) break;
      if (!relieves(blockers, routeFootprint(world, [relocationPath])))
        continue;
    }
    // As in a service plan, a longer way round is only searched while it could
    // still finish first.
    if (scheduled) {
      const earliest = world.time + travelSeconds(relocationPath);
      if (earliest >= departureEnd(bestTemplate, scheduled) - EPSILON) continue;
    }
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
        [],
        0,
        world.time,
        variant === 0 ? blockers : undefined,
      );
      if (!candidate) continue;
      // An empty move is judged by when it clears: within one route that is the
      // earliest departure, between routes it is the earliest arrival.
      const end = departureEnd(template, candidate);
      const bestEnd = scheduled
        ? departureEnd(bestTemplate, scheduled)
        : Number.POSITIVE_INFINITY;
      const improves = !scheduled
        ? true
        : bestVariant !== variant
          ? end < bestEnd - EPSILON
          : candidate.departure < scheduled.departure - EPSILON ||
            (Math.abs(candidate.departure - scheduled.departure) <= EPSILON &&
              end < bestEnd - EPSILON);
      if (improves) {
        scheduled = candidate;
        bestTemplate = template;
        bestVariant = variant;
      }
    }
  }
  if (!scheduled) return { ok: false, reason: "track-busy" };
  const committed = commitDeparture(
    world,
    pod,
    origin,
    bestTemplate,
    scheduled,
  );
  const plan: ServicePlan = {
    id: `relocate:${pod.id}:${actualTarget.id}:${world.time}`,
    podId: pod.id,
    residentId: null,
    originBerthId: origin.id,
    finalBerthId: actualTarget.id,
    requestedAt: world.time,
    departure: scheduled.departure,
    end: committed.segments[committed.segments.length - 1].end,
    safetyBuffer: 1,
    segments: committed.segments,
    reservations: committed.reservations,
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
  const blocks = existingBlocks(world, new Set([plan.podId]));
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
