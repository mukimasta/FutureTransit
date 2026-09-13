import { TRACK_COST } from "../shared/constants";
import { distance, pathTotalLength, samePoint } from "../shared/math";
import type {
  Berth,
  Building,
  Point,
  Track,
  TrackDraft,
  World,
} from "../shared/types";

const EPSILON = 1e-9;

interface PathCache {
  networkVersion: number;
  width: number;
  height: number;
  buildingCount: number;
  berthCount: number;
  trackCount: number;
  paths: Map<number | string, Point[] | null>;
}
const pathCaches = new WeakMap<World, PathCache>();

/**
 * Walking reads the building footprints and nothing else, so pedestrian routes
 * survive every track and berth edit. They are kept against the obstacle mask
 * itself, which is already rebuilt exactly when a building appears, moves or
 * goes away.
 */
interface WalkPathCache {
  occupied: Uint8Array;
  paths: Map<number | string, Point[] | null>;
}
const walkPathCaches = new WeakMap<World, WalkPathCache>();

interface ResourceConnection {
  point: Point;
  track?: Track;
}
interface ResourceIndex {
  networkVersion: number;
  trackCount: number;
  berthCount: number;
  tracksByEdge: Map<string, Track>;
  connectionsByNode: Map<string, ResourceConnection[]>;
  /** Derived, per-topology memos. Rebuilt whenever the stamp changes. */
  berthsByPoint: Map<string, Berth>;
  laneOptions: Map<string, string[][]>;
  laneOptionsById: Map<number, string[][]>;
  corridors: Map<string, LaneCorridor | null>;
  nodeResources: Map<string, string[]>;
  dwellResources: Map<string, string[]>;
  trackGraph: Map<string, GraphEdge[]> | null;
  trackTrees: Map<string, TrackTree>;
  trackAlternatives: Map<number | string, Point[][]>;
  bridges: Set<string> | null;
}
const resourceIndexes = new WeakMap<World, ResourceIndex>();

function resourceIndex(world: World): ResourceIndex {
  // Compared field by field: this runs on nearly every resource lookup, so it
  // must not build a stamp string each time.
  const existing = resourceIndexes.get(world);
  if (
    existing !== undefined &&
    existing.networkVersion === world.networkVersion &&
    existing.trackCount === world.tracks.length &&
    existing.berthCount === world.berths.length
  )
    return existing;
  const tracksByEdge = new Map<string, Track>();
  const connectionsByNode = new Map<string, ResourceConnection[]>();
  const berthsByPoint = new Map<string, Berth>();
  const connect = (a: Point, b: Point, track?: Track) => {
    const entries = connectionsByNode.get(nodeKey(a)) ?? [];
    entries.push({ point: b, track });
    connectionsByNode.set(nodeKey(a), entries);
  };
  for (const track of world.tracks) {
    tracksByEdge.set(edgeKey(track.a, track.b), track);
    connect(track.a, track.b, track);
    connect(track.b, track.a, track);
  }
  for (const berth of world.berths) {
    connect(berth.point, berth.access);
    connect(berth.access, berth.point);
    const key = nodeKey(berth.point);
    if (!berthsByPoint.has(key)) berthsByPoint.set(key, berth);
  }
  const index: ResourceIndex = {
    networkVersion: world.networkVersion,
    trackCount: world.tracks.length,
    berthCount: world.berths.length,
    tracksByEdge,
    connectionsByNode,
    berthsByPoint,
    laneOptions: new Map(),
    laneOptionsById: new Map(),
    corridors: new Map(),
    nodeResources: new Map(),
    dwellResources: new Map(),
    trackGraph: null,
    trackTrees: new Map(),
    trackAlternatives: new Map(),
    bridges: null,
  };
  resourceIndexes.set(world, index);
  return index;
}

/** Through-corridor geometry is not part of the index stamp, so edits to it
 * must drop the memos derived from it. */
function invalidateCorridors(world: World): void {
  const index = resourceIndexes.get(world);
  if (!index) return;
  index.corridors.clear();
  index.nodeResources.clear();
  index.dwellResources.clear();
}

/** First berth standing on this grid point, without scanning the berth list. */
export function berthAtPoint(world: World, point: Point): Berth | undefined {
  return resourceIndex(world).berthsByPoint.get(nodeKey(point));
}

/** The track joining two adjacent points, without scanning the track list. */
export function trackBetween(
  world: World,
  a: Point,
  b: Point,
): Track | undefined {
  return resourceIndex(world).tracksByEdge.get(edgeKey(a, b));
}
/** An allocation-free cache key for in-bounds grid endpoints, which is all of
 * them in practice; anything else falls back to a descriptive string. */
function pathCacheKey(
  world: World,
  from: Point,
  to: Point,
  walking: boolean,
): number | string {
  const { width, height } = world;
  const cells = width * height;
  if (
    Number.isInteger(from.x) &&
    Number.isInteger(from.y) &&
    Number.isInteger(to.x) &&
    Number.isInteger(to.y) &&
    from.x >= 0 &&
    from.y >= 0 &&
    to.x >= 0 &&
    to.y >= 0 &&
    from.x < width &&
    from.y < height &&
    to.x < width &&
    to.y < height &&
    cells * cells * 2 <= Number.MAX_SAFE_INTEGER
  )
    return (
      ((from.y * width + from.x) * cells + (to.y * width + to.x)) * 2 +
      (walking ? 1 : 0)
    );
  return `${walking ? "walk" : "track"}:${from.x},${from.y}:${to.x},${to.y}`;
}

/** A numeric, canonical id for an edge between two in-bounds grid points, or
 * null when the endpoints leave the grid. Memo lookups keyed on it skip the
 * string build and hash that `edgeKey` would cost on every movement query. */
function edgeId(world: World, a: Point, b: Point): number | null {
  const { width, height } = world;
  const cells = width * height;
  if (
    !Number.isInteger(a.x) ||
    !Number.isInteger(a.y) ||
    !Number.isInteger(b.x) ||
    !Number.isInteger(b.y) ||
    a.x < 0 ||
    a.y < 0 ||
    b.x < 0 ||
    b.y < 0 ||
    a.x >= width ||
    a.y >= height ||
    b.x >= width ||
    b.y >= height ||
    cells * cells > Number.MAX_SAFE_INTEGER
  )
    return null;
  const [first, second] = comparePoints(a, b) <= 0 ? [a, b] : [b, a];
  return (first.y * width + first.x) * cells + (second.y * width + second.x);
}

/** The shared, cached route. Callers outside this module get their own copy. */
function storedPath(
  world: World,
  from: Point,
  to: Point,
  walking: boolean,
): Point[] | null {
  if (walking) {
    const occupied = walkOccupancy(world);
    let walkCache = walkPathCaches.get(world);
    if (walkCache === undefined || walkCache.occupied !== occupied) {
      walkCache = { occupied, paths: new Map() };
      walkPathCaches.set(world, walkCache);
    }
    const key = pathCacheKey(world, from, to, walking);
    const cached = walkCache.paths.get(key);
    if (cached !== undefined) return cached;
    const path = computeWalkPath(world, from, to);
    walkCache.paths.set(key, path);
    return path;
  }
  // All production topology edits increment networkVersion. Counts additionally
  // protect construction fixtures; direct coordinate edits must bump the version.
  let cache = pathCaches.get(world);
  if (
    cache === undefined ||
    cache.networkVersion !== world.networkVersion ||
    cache.width !== world.width ||
    cache.height !== world.height ||
    cache.buildingCount !== world.buildings.length ||
    cache.berthCount !== world.berths.length ||
    cache.trackCount !== world.tracks.length
  ) {
    cache = {
      networkVersion: world.networkVersion,
      width: world.width,
      height: world.height,
      buildingCount: world.buildings.length,
      berthCount: world.berths.length,
      trackCount: world.tracks.length,
      paths: new Map(),
    };
    pathCaches.set(world, cache);
  }
  const key = pathCacheKey(world, from, to, walking);
  const cached = cache.paths.get(key);
  if (cached !== undefined) return cached;
  const path = computeTrackPath(world, from, to);
  cache.paths.set(key, path);
  return path;
}
function cachedPath(
  world: World,
  from: Point,
  to: Point,
  walking: boolean,
): Point[] | null {
  const path = storedPath(world, from, to, walking);
  if (!path) return null;
  const copy = new Array<Point>(path.length);
  for (let index = 0; index < path.length; index += 1)
    copy[index] = { x: path[index].x, y: path[index].y };
  return copy;
}
export function findTrackPath(
  world: World,
  from: Point,
  to: Point,
): Point[] | null {
  return cachedPath(world, from, to, false);
}
export function findWalkPath(
  world: World,
  from: Point,
  to: Point,
): Point[] | null {
  return cachedPath(world, from, to, true);
}

/**
 * Grid length of the shortest route, or null when there is none. Planners that
 * only rank routes never need a private copy of the point list.
 */
export function trackPathLength(
  world: World,
  from: Point,
  to: Point,
): number | null {
  const path = storedPath(world, from, to, false);
  return path ? pathTotalLength(path) : null;
}
export function walkPathLength(
  world: World,
  from: Point,
  to: Point,
): number | null {
  const path = storedPath(world, from, to, true);
  return path ? pathTotalLength(path) : null;
}

function isGridPoint(point: Point): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isInteger(point.x) &&
    Number.isInteger(point.y)
  );
}

function comparePoints(a: Point, b: Point): number {
  return a.x - b.x || a.y - b.y;
}

function canonicalPair(a: Point, b: Point): [Point, Point] {
  return comparePoints(a, b) <= 0 ? [a, b] : [b, a];
}

/** A direction-independent resource id for one physical track unit. */
export function edgeKey(a: Point, b: Point): string {
  return comparePoints(a, b) <= 0
    ? `edge:${a.x},${a.y}~${b.x},${b.y}`
    : `edge:${b.x},${b.y}~${a.x},${a.y}`;
}

/** A stable resource id for a network node. */
export function nodeKey(point: Point): string {
  return `node:${point.x},${point.y}`;
}

/**
 * Resources occupied while traversing an edge. Opposite diagonal edges in the
 * same unit square deliberately share the doubled-midpoint crossing id.
 */
export function edgeResources(a: Point, b: Point): string[] {
  const resources = [edgeKey(a, b)];
  if (a.x !== b.x && a.y !== b.y) {
    resources.push(`crossing:${a.x + b.x},${a.y + b.y}`);
  }
  return resources;
}

const legacyDirectedLaneKey = (a: Point, b: Point) =>
  `lane:${a.x},${a.y}>${b.x},${b.y}`;

function legacyCrossingChannels(a: Point, b: Point): string[] {
  if (a.x === b.x || a.y === b.y) return [];
  const crossing = `${a.x + b.x},${a.y + b.y}`;
  const positiveSlope = (b.x - a.x) * (b.y - a.y) > 0;
  const forward = comparePoints(a, b) <= 0;
  const indexes = positiveSlope
    ? forward
      ? [0, 1]
      : [2, 3]
    : forward
      ? [0, 2]
      : [1, 3];
  return indexes.map((index) => `crossing-lane:${crossing}:${index}`);
}

function trackLaneCount(world: World, a: Point, b: Point): 1 | 2 | 3 {
  return trackBetween(world, a, b)?.lanes ?? 1;
}

/** A direction-independent resource id for one lane of a physical edge. */
export function laneKey(a: Point, b: Point, laneIndex: number): string {
  return `lane:${edgeKey(a, b).slice("edge:".length)}:${laneIndex}`;
}

/**
 * Crossing slots use a small row/column matrix. Lanes on the same diagonal
 * have disjoint rows (or columns), while every lane on the other diagonal
 * intersects them in exactly one resource.
 */
function crossingSlotResources(
  a: Point,
  b: Point,
  laneIndex: number,
): string[] {
  if (a.x === b.x || a.y === b.y) return [];
  const crossing = `${a.x + b.x},${a.y + b.y}`;
  const positiveSlope = (b.x - a.x) * (b.y - a.y) > 0;
  return [0, 1, 2].map((other) =>
    positiveSlope
      ? `crossing-slot:${crossing}:${laneIndex},${other}`
      : `crossing-slot:${crossing}:${other},${laneIndex}`,
  );
}

function sameResourceSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((resource) => right.includes(resource))
  );
}

/**
 * Every legal physical-lane choice for this movement. The result is memoized
 * per topology, so callers must treat it as read-only.
 */
export function movementResourceOptions(
  world: World,
  a: Point,
  b: Point,
): string[][] {
  const index = resourceIndex(world);
  const id = edgeId(world, a, b);
  if (id !== null) {
    const hit = index.laneOptionsById.get(id);
    if (hit) return hit;
  }
  const key = edgeKey(a, b);
  const memo = index.laneOptions.get(key);
  if (memo) {
    if (id !== null) index.laneOptionsById.set(id, memo);
    return memo;
  }
  const lanes = index.tracksByEdge.get(key)?.lanes ?? 1;
  const options = Array.from({ length: lanes }, (_, laneIndex) => [
    lanes === 1 ? key : `lane:${key.slice("edge:".length)}:${laneIndex}`,
    ...crossingSlotResources(a, b, laneIndex),
  ]);
  index.laneOptions.set(key, options);
  if (id !== null) index.laneOptionsById.set(id, options);
  return options;
}

/**
 * Resources occupied by one selected physical lane. Lane indices have no
 * travel direction: either direction may reserve any free lane.
 */
export function movementResources(
  world: World,
  a: Point,
  b: Point,
  laneIndex = 0,
): string[] {
  const options = movementResourceOptions(world, a, b);
  if (
    !Number.isInteger(laneIndex) ||
    laneIndex < 0 ||
    laneIndex >= options.length
  )
    throw new Error(`Illegal lane ${laneIndex} for ${edgeKey(a, b)}`);
  // The memo is shared; hand every caller its own array to keep or mutate.
  return [...options[laneIndex]];
}

/** Exact movement resources written by the former directional-lane format. */
function legacyMovementResources(world: World, a: Point, b: Point): string[] {
  if (trackLaneCount(world, a, b) === 2)
    return [legacyDirectedLaneKey(a, b), ...legacyCrossingChannels(a, b)];
  return edgeResources(a, b);
}

/**
 * Resolve stored resources to a legal shared lane. This accepts the old v1
 * directional encoding only where it could actually have been produced.
 */
export function movementLaneIndex(
  world: World,
  a: Point,
  b: Point,
  resources: string[],
): number | null {
  const options = movementResourceOptions(world, a, b);
  const current = options.findIndex((option) =>
    sameResourceSet(option, resources),
  );
  if (current >= 0) return current;
  if (!sameResourceSet(legacyMovementResources(world, a, b), resources))
    return null;
  const lanes = trackLaneCount(world, a, b);
  if (lanes === 1) return 0;
  if (lanes === 2) return comparePoints(a, b) <= 0 ? 0 : 1;
  return null;
}

/** Canonical shared resources represented by a current or legacy movement. */
export function canonicalMovementResources(
  world: World,
  a: Point,
  b: Point,
  resources: string[],
): string[] | null {
  const laneIndex = movementLaneIndex(world, a, b, resources);
  return laneIndex === null ? null : movementResources(world, a, b, laneIndex);
}

/** Every resource name that may describe occupancy of this track unit. */
export function trackResources(world: World, track: Track): string[] {
  return [
    ...new Set([
      ...edgeResources(track.a, track.b),
      ...movementResourceOptions(world, track.a, track.b).flat(),
      ...legacyMovementResources(world, track.a, track.b),
      ...legacyMovementResources(world, track.b, track.a),
    ]),
  ];
}

interface LaneCorridor {
  neighbors: Point[];
  lanes: 2 | 3;
}

function laneCorridor(world: World, point: Point): LaneCorridor | null {
  const index = resourceIndex(world);
  const memoKey = nodeKey(point);
  const memo = index.corridors.get(memoKey);
  if (memo !== undefined) return memo;
  const corridor = computeLaneCorridor(world, point);
  index.corridors.set(memoKey, corridor);
  return corridor;
}

function computeLaneCorridor(world: World, point: Point): LaneCorridor | null {
  const neighbors: { point: Point; lanes: 1 | 2 | 3 }[] = [];
  const add = (neighbor: Point, lanes: 1 | 2 | 3) => {
    const existing = neighbors.find((entry) =>
      samePoint(entry.point, neighbor),
    );
    if (existing) existing.lanes = Math.min(existing.lanes, lanes) as 1 | 2 | 3;
    else neighbors.push({ point: { ...neighbor }, lanes });
  };
  for (const connection of resourceIndex(world).connectionsByNode.get(
    nodeKey(point),
  ) ?? []) {
    add(connection.point, connection.track?.lanes ?? 1);
  }
  if (world.resourceModel === 2) {
    const through = world.throughCorridors?.find((entry) =>
      samePoint(entry.point, point),
    );
    if (through) {
      const from = neighbors.find((entry) =>
        samePoint(entry.point, through.from),
      );
      const to = neighbors.find((entry) => samePoint(entry.point, through.to));
      if (from && to && from.lanes >= 2 && to.lanes >= 2)
        return {
          neighbors: [from.point, to.point].sort(comparePoints),
          lanes: Math.min(from.lanes, to.lanes) as 2 | 3,
        };
    }
  }
  if (
    neighbors.length !== 2 ||
    neighbors[0].lanes < 2 ||
    neighbors[1].lanes < 2 ||
    (world.resourceModel !== 2 && neighbors[0].lanes !== neighbors[1].lanes)
  )
    return null;
  return {
    neighbors: neighbors.map((entry) => entry.point).sort(comparePoints),
    lanes: Math.min(neighbors[0].lanes, neighbors[1].lanes) as 2 | 3,
  };
}

const corridorLaneKey = (point: Point, laneIndex: number) =>
  `node-lane:${point.x},${point.y}:${laneIndex}`;
const legacyCorridorLaneKey = (point: Point, from: Point, to: Point) =>
  `node-lane:${point.x},${point.y}:${from.x},${from.y}>${to.x},${to.y}`;

/** The shared node plus any legal physical-lane channels at this point. */
export function corridorNodeResources(world: World, point: Point): string[] {
  const index = resourceIndex(world);
  const memoKey = nodeKey(point);
  const memo = index.nodeResources.get(memoKey);
  if (memo) return memo;
  const resources = computeCorridorNodeResources(world, point);
  index.nodeResources.set(memoKey, resources);
  return resources;
}

function computeCorridorNodeResources(world: World, point: Point): string[] {
  const corridor = laneCorridor(world, point);
  if (!corridor) return [nodeKey(point)];
  return [
    nodeKey(point),
    ...Array.from({ length: corridor.lanes }, (_, laneIndex) =>
      corridorLaneKey(point, laneIndex),
    ),
    ...(corridor.lanes === 2
      ? [
          legacyCorridorLaneKey(
            point,
            corridor.neighbors[0],
            corridor.neighbors[1],
          ),
          legacyCorridorLaneKey(
            point,
            corridor.neighbors[1],
            corridor.neighbors[0],
          ),
        ]
      : []),
  ];
}

/** Turns and lane changes conflict with every through lane at the junction. */
export function exclusiveNodeResources(world: World, point: Point): string[] {
  return world.resourceModel === 2
    ? corridorNodeResources(world, point)
    : [nodeKey(point)];
}

/**
 * Everything a dwell at this point occupies: the berth resource, if any, plus
 * every exclusive junction channel. Memoized with the corridor geometry it is
 * derived from, because trajectories ask for the same points repeatedly.
 */
export function dwellResources(world: World, point: Point): string[] {
  const index = resourceIndex(world);
  const memoKey = nodeKey(point);
  const memo = index.dwellResources.get(memoKey);
  if (memo) return memo;
  const berth = index.berthsByPoint.get(memoKey);
  const resources = [
    ...new Set([
      memoKey,
      ...(berth ? [`berth:${berth.id}`] : []),
      ...exclusiveNodeResources(world, point),
    ]),
  ];
  index.dwellResources.set(memoKey, resources);
  return resources;
}

/** Preserve existing through geometry when new branches introduce a junction.
 * Old trains keep their lanes; new turning movements reserve all through lanes. */
export function preserveThroughCorridors(before: World, after: World): void {
  const saved = new Map(
    (before.throughCorridors ?? []).map((entry) => [
      nodeKey(entry.point),
      entry,
    ]),
  );
  const points = new Map(
    before.tracks
      .flatMap((track) => [track.a, track.b])
      .map((point) => [nodeKey(point), point]),
  );
  for (const [key, point] of points) {
    const prior = laneCorridor(before, point);
    const current = laneCorridor(after, point);
    if (prior && !current)
      saved.set(key, {
        point: { ...point },
        from: { ...prior.neighbors[0] },
        to: { ...prior.neighbors[1] },
      });
  }
  after.throughCorridors = [...saved.values()];
  invalidateCorridors(after);
}

/** Demolition still drains its junction first, then discards obsolete geometry. */
export function pruneThroughCorridors(world: World): void {
  const previous = world.throughCorridors;
  world.throughCorridors = world.throughCorridors?.filter((entry) => {
    const connections =
      resourceIndex(world).connectionsByNode.get(nodeKey(entry.point)) ?? [];
    return [entry.from, entry.to].every((point) =>
      connections.some(
        (connection) =>
          samePoint(connection.point, point) &&
          (connection.track?.lanes ?? 1) >= 2,
      ),
    );
  });
  if (world.throughCorridors !== previous) invalidateCorridors(world);
}

/** Resource used while continuously passing through a node. */
export function movementNodeResources(
  world: World,
  point: Point,
  from: Point,
  to: Point,
  laneIndex = 0,
): string[] {
  const corridor = laneCorridor(world, point);
  if (
    corridor &&
    laneIndex >= 0 &&
    laneIndex < corridor.lanes &&
    ((samePoint(from, corridor.neighbors[0]) &&
      samePoint(to, corridor.neighbors[1])) ||
      (samePoint(from, corridor.neighbors[1]) &&
        samePoint(to, corridor.neighbors[0])))
  ) {
    return [corridorLaneKey(point, laneIndex)];
  }
  return exclusiveNodeResources(world, point);
}

/** Returns the middle grid point immediately south of the building footprint. */
export function buildingDoor(building: Building): Point {
  return {
    x: building.x + Math.floor((building.w - 1) / 2),
    y: building.y + building.h,
  };
}

/** Out-of-bounds, non-integer, and building-occupied grid points are blocked. */
export function isBlocked(world: World, point: Point): boolean {
  if (
    !isGridPoint(point) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= world.width ||
    point.y >= world.height
  ) {
    return true;
  }
  return world.buildings.some(
    (building) =>
      point.x >= building.x &&
      point.x <= building.x + building.w - 1 &&
      point.y >= building.y &&
      point.y <= building.y + building.h - 1,
  );
}

function traceSegment(from: Point, to: Point): Point[] {
  let x = from.x;
  let y = from.y;
  const stepX = Math.sign(to.x - from.x);
  const stepY = Math.sign(to.y - from.y);
  const result: Point[] = [];

  while (true) {
    result.push({ x, y });
    if (x === to.x && y === to.y) break;
    // One diagonal run followed by one straight run, not a staircase of turns.
    if (x !== to.x) x += stepX;
    if (y !== to.y) y += stepY;
  }
  return result;
}

/** Rasterizes a polyline into consecutive, eight-direction grid nodes. */
export function tracePolyline(points: Point[]): Point[] {
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    points.some((point) => !isGridPoint(point))
  ) {
    return [];
  }
  if (points.length === 1) return [{ ...points[0] }];

  const traced: Point[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const segment = traceSegment(points[index - 1], points[index]);
    for (const point of segment) {
      if (!traced.length || !samePoint(traced[traced.length - 1], point))
        traced.push(point);
    }
  }
  return traced;
}

function invalidDraft(error: string, errorEn: string): TrackDraft {
  return { edges: [], cost: 0, error, errorEn };
}

/**
 * Produces a construction candidate without mutating the world. Existing and
 * repeated physical units are omitted, so cost depends only on new geometry.
 */
export function validateTrackDraft(world: World, points: Point[]): TrackDraft {
  if (!Array.isArray(points) || points.length < 2) {
    return invalidDraft(
      "轨道至少需要两个点。",
      "Track needs at least two points.",
    );
  }
  if (points.some((point) => !point || !isGridPoint(point))) {
    return invalidDraft(
      "轨道点必须是有限的整数网格点。",
      "Track points must be finite integer grid points.",
    );
  }
  if (
    points.some(
      (point) =>
        point.x < 0 ||
        point.y < 0 ||
        point.x >= world.width ||
        point.y >= world.height,
    )
  ) {
    return invalidDraft(
      "轨道点超出地图边界。",
      "A track point is outside the map bounds.",
    );
  }

  const traced = tracePolyline(points);
  if (traced.length < 2) {
    return invalidDraft(
      "轨道必须包含至少一个非零长度单元。",
      "Track must contain a non-zero grid unit.",
    );
  }
  if (traced.some((point) => isBlocked(world, point))) {
    return invalidDraft(
      "轨道不能穿过建筑。",
      "Track cannot pass through a building.",
    );
  }

  const berthPoints = new Set(
    world.berths.map((berth) => nodeKey(berth.point)),
  );
  if (traced.some((point) => berthPoints.has(nodeKey(point)))) {
    return invalidDraft(
      "轨道不能穿过或连接停靠泊位，请连接其 access 点。",
      "Track cannot cross or connect a berth; connect its access point.",
    );
  }

  const occupied = new Set(
    world.tracks.map((track) => edgeKey(track.a, track.b)),
  );
  const candidates = new Map<string, Track>();
  for (let index = 1; index < traced.length; index += 1) {
    const a = traced[index - 1];
    const b = traced[index];
    if (samePoint(a, b)) continue;
    const key = edgeKey(a, b);
    if (occupied.has(key) || candidates.has(key)) continue;
    const [first, second] = canonicalPair(a, b);
    const paid = TRACK_COST * distance(first, second);
    candidates.set(key, { id: key, a: { ...first }, b: { ...second }, paid });
  }

  const edges = [...candidates.values()];
  return { edges, cost: edges.reduce((sum, edge) => sum + edge.paid, 0) };
}

interface GraphEdge {
  point: Point;
  cost: number;
}

function addGraphEdge(
  graph: Map<string, GraphEdge[]>,
  a: Point,
  b: Point,
): void {
  if (!isGridPoint(a) || !isGridPoint(b) || samePoint(a, b)) return;
  const aKey = nodeKey(a);
  const bKey = nodeKey(b);
  const cost = distance(a, b);
  const addOne = (key: string, point: Point) => {
    const neighbors = graph.get(key) ?? [];
    if (
      !neighbors.some((neighbor) => nodeKey(neighbor.point) === nodeKey(point))
    ) {
      neighbors.push({ point: { ...point }, cost });
      graph.set(key, neighbors);
    }
  };
  addOne(aKey, b);
  addOne(bKey, a);
}

function reconstructPath(
  parents: Map<string, string>,
  points: Map<string, Point>,
  end: string,
): Point[] {
  const reversed: Point[] = [];
  let current: string | undefined = end;
  while (current !== undefined) {
    reversed.push({ ...points.get(current)! });
    current = parents.get(current);
  }
  return reversed.reverse();
}

/** A lazy-deletion binary heap keyed by a caller-supplied "is left smaller"
 * predicate. Priority queues replace the linear frontier scans that used to
 * make both searches quadratic in the number of visited nodes. */
class Frontier<T> {
  private readonly items: T[] = [];
  constructor(private readonly smaller: (a: T, b: T) => boolean) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let child = items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.smaller(items[child], items[parent])) break;
      const swap = items[parent];
      items[parent] = items[child];
      items[child] = swap;
      child = parent;
    }
  }
  pop(): T {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child =
          right < items.length && this.smaller(items[right], items[left])
            ? right
            : left;
        if (!this.smaller(items[child], items[parent])) break;
        const swap = items[parent];
        items[parent] = items[child];
        items[child] = swap;
        parent = child;
      }
    }
    return top;
  }
}

/** Track topology only changes with the index stamp, so the search graph is
 * built once per topology instead of once per route query. */
function trackGraph(world: World): Map<string, GraphEdge[]> {
  const index = resourceIndex(world);
  if (index.trackGraph) return index.trackGraph;
  const graph = new Map<string, GraphEdge[]>();
  for (const track of world.tracks) addGraphEdge(graph, track.a, track.b);
  for (const berth of world.berths)
    addGraphEdge(graph, berth.point, berth.access);
  index.trackGraph = graph;
  return graph;
}

interface TrackEntry {
  key: string;
  point: Point;
  cost: number;
}

/**
 * Every shortest route out of one origin, as the parent links a search leaves
 * behind.
 *
 * A berth is never travelled through, only entered as the final step, so the
 * search behind these links is the same one a single destination would have
 * run: the destination is a leaf, and nothing beyond it could have changed the
 * way there. One origin therefore answers for every destination — the shape of
 * the question a dispatch pass actually asks.
 */
interface TrackTree {
  parents: Map<string, string>;
  points: Map<string, Point>;
}

function trackTree(world: World, from: Point, startKey: string): TrackTree {
  const index = resourceIndex(world);
  const cached = index.trackTrees.get(startKey);
  if (cached) return cached;

  const graph = trackGraph(world);
  const terminalKeys = index.berthsByPoint;
  const distances = new Map<string, number>([[startKey, 0]]);
  const parents = new Map<string, string>();
  const pointsByKey = new Map<string, Point>([[startKey, { ...from }]]);
  const settled = new Set<string>();
  // Same order the former linear scan produced: lower distance first, then the
  // lexicographically smaller node key.
  const unsettled = new Frontier<TrackEntry>(
    (a, b) =>
      a.cost < b.cost - EPSILON ||
      (Math.abs(a.cost - b.cost) <= EPSILON && a.key < b.key),
  );
  unsettled.push({ key: startKey, point: from, cost: 0 });

  while (unsettled.size) {
    const entry = unsettled.pop();
    const current = entry.key;
    if (settled.has(current)) continue;
    settled.add(current);
    if (terminalKeys.has(current) && current !== startKey) continue;

    const currentCost = distances.get(current)!;
    // Neighbour order cannot matter: every neighbour updates a distinct key.
    for (const neighbor of graph.get(current) ?? []) {
      const key = nodeKey(neighbor.point);
      const candidate = currentCost + neighbor.cost;
      if (
        candidate <
        (distances.get(key) ?? Number.POSITIVE_INFINITY) - EPSILON
      ) {
        distances.set(key, candidate);
        parents.set(key, current);
        pointsByKey.set(key, { ...neighbor.point });
        unsettled.push({ key, point: neighbor.point, cost: candidate });
      }
    }
  }
  const tree: TrackTree = { parents, points: pointsByKey };
  index.trackTrees.set(startKey, tree);
  return tree;
}

/** Finds a shortest route over built track plus every automatic berth spur. */
function computeTrackPath(
  world: World,
  from: Point,
  to: Point,
): Point[] | null {
  if (!isGridPoint(from) || !isGridPoint(to)) return null;
  if (samePoint(from, to)) return [{ ...from }];

  const graph = trackGraph(world);

  const startKey = nodeKey(from);
  const endKey = nodeKey(to);
  if (!graph.has(startKey) || !graph.has(endKey)) return null;

  const tree = trackTree(world, from, startKey);
  if (!tree.points.has(endKey)) return null;
  return reconstructPath(tree.parents, tree.points, endKey);
}

/**
 * How many routes a single origin-destination pair offers, the shortest one
 * included, and how far past the shortest a detour may still be worth offering.
 * A cell of track costs five seconds to cross, while a contested corridor
 * routinely pushes a departure back by several hundred; the point of the cap is
 * not to protect travel time — the planner compares arrivals and will refuse a
 * slow detour on its own — but to keep the candidate list short.
 */
const MAX_ROUTE_ALTERNATIVES = 3;
const DETOUR_LENGTH_RATIO = 1.6;
/** Each earlier use of an edge makes it this much dearer to the next search. */
const DETOUR_PENALTY = 2;

const nodePairKey = (a: Point, b: Point) => {
  const left = nodeKey(a);
  const right = nodeKey(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
};

/**
 * The edges no route can avoid — remove one and the network falls in two.
 *
 * A network grown by hanging each new stop off its nearest neighbour is made
 * entirely of these, and so is every dead-end spur on a network that is not.
 * Knowing them turns "is there another way round?" into a question answered by
 * reading the route, rather than by searching for a second one and finding the
 * first again.
 */
function bridgeEdges(world: World): Set<string> {
  const index = resourceIndex(world);
  if (index.bridges) return index.bridges;
  const graph = trackGraph(world);
  const bridges = new Set<string>();
  const points = new Map<string, Point>();
  for (const [key, neighbors] of graph)
    for (const neighbor of neighbors) {
      if (!points.has(key)) points.set(key, neighbor.point);
      points.set(nodeKey(neighbor.point), neighbor.point);
    }
  const discovered = new Map<string, number>();
  const low = new Map<string, number>();
  let counter = 0;
  // Tarjan, with the recursion spelled out: a long corridor is a deep tree.
  for (const root of graph.keys()) {
    if (discovered.has(root)) continue;
    discovered.set(root, counter);
    low.set(root, counter);
    counter += 1;
    const stack = [{ key: root, parent: null as string | null, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbors = graph.get(frame.key) ?? [];
      if (frame.next < neighbors.length) {
        const child = nodeKey(neighbors[frame.next].point);
        frame.next += 1;
        // Edges are stored once each way, so the way back is not a second way.
        if (child === frame.parent) continue;
        const seen = discovered.get(child);
        if (seen !== undefined) {
          low.set(frame.key, Math.min(low.get(frame.key)!, seen));
          continue;
        }
        discovered.set(child, counter);
        low.set(child, counter);
        counter += 1;
        stack.push({ key: child, parent: frame.key, next: 0 });
        continue;
      }
      stack.pop();
      const parent = frame.parent;
      if (parent === null) continue;
      const reach = low.get(frame.key)!;
      low.set(parent, Math.min(low.get(parent)!, reach));
      if (reach > discovered.get(parent)!)
        bridges.add(nodePairKey(points.get(parent)!, points.get(frame.key)!));
    }
  }
  index.bridges = bridges;
  return bridges;
}

/** A route made only of unavoidable edges has no alternative, by definition. */
function routeIsForced(world: World, path: Point[]): boolean {
  const bridges = bridgeEdges(world);
  for (let index = 1; index < path.length; index += 1)
    if (!bridges.has(nodePairKey(path[index - 1], path[index]))) return false;
  return true;
}

/**
 * The shortest route that avoids, as far as it can, the edges already spent.
 * Penalising rather than deleting them keeps a route available where the
 * network offers no genuine second corridor: the search still returns
 * something, and the caller recognises the repeat and stops.
 */
function penalizedTrackPath(
  world: World,
  from: Point,
  to: Point,
  penalties: Map<string, number>,
): Point[] | null {
  const graph = trackGraph(world);
  const index = resourceIndex(world);
  const terminalKeys = index.berthsByPoint;
  const startKey = nodeKey(from);
  const endKey = nodeKey(to);
  const distances = new Map<string, number>([[startKey, 0]]);
  const parents = new Map<string, string>();
  const pointsByKey = new Map<string, Point>([[startKey, { ...from }]]);
  const settled = new Set<string>();
  const unsettled = new Frontier<TrackEntry>(
    (a, b) =>
      a.cost < b.cost - EPSILON ||
      (Math.abs(a.cost - b.cost) <= EPSILON && a.key < b.key),
  );
  unsettled.push({ key: startKey, point: from, cost: 0 });

  while (unsettled.size) {
    const entry = unsettled.pop();
    const current = entry.key;
    if (settled.has(current)) continue;
    settled.add(current);
    if (current === endKey) break;
    // Berths are entered, never crossed: the same rule the plain search follows.
    if (terminalKeys.has(current) && current !== startKey) continue;

    const currentCost = distances.get(current)!;
    for (const neighbor of graph.get(current) ?? []) {
      const key = nodeKey(neighbor.point);
      const used = penalties.get(edgeKey(entry.point, neighbor.point)) ?? 0;
      const candidate =
        currentCost + neighbor.cost * (1 + DETOUR_PENALTY * used);
      if (
        candidate <
        (distances.get(key) ?? Number.POSITIVE_INFINITY) - EPSILON
      ) {
        distances.set(key, candidate);
        parents.set(key, current);
        pointsByKey.set(key, { ...neighbor.point });
        unsettled.push({ key, point: neighbor.point, cost: candidate });
      }
    }
  }
  if (!settled.has(endKey)) return null;
  return reconstructPath(parents, pointsByKey, endKey);
}

function samePath(left: Point[], right: Point[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!samePoint(left[index], right[index])) return false;
  return true;
}

/**
 * Distinct routes between two points, shortest first.
 *
 * Every further route is the shortest one that leans away from the edges its
 * predecessors already used, so the list walks outward through genuinely
 * separate corridors instead of returning near-copies of the first. Kept per
 * topology alongside the shortest-path trees: a pair is searched at most
 * `MAX_ROUTE_ALTERNATIVES` times however often the planner asks for it.
 */
function trackAlternatives(world: World, from: Point, to: Point): Point[][] {
  const shortest = storedPath(world, from, to, false);
  if (!shortest) return [];
  // Nothing to route around: a single hop has no interior to avoid, and a route
  // that is all bridges is the only route there is.
  if (shortest.length < 3 || routeIsForced(world, shortest)) return [shortest];

  const index = resourceIndex(world);
  const key = pathCacheKey(world, from, to, false);
  const cached = index.trackAlternatives.get(key);
  if (cached) return cached;

  const routes = [shortest];
  const limit = pathTotalLength(shortest) * DETOUR_LENGTH_RATIO + EPSILON;
  const penalties = new Map<string, number>();
  while (routes.length < MAX_ROUTE_ALTERNATIVES) {
    const previous = routes[routes.length - 1];
    for (let step = 1; step < previous.length; step += 1) {
      const edge = edgeKey(previous[step - 1], previous[step]);
      penalties.set(edge, (penalties.get(edge) ?? 0) + 1);
    }
    const candidate = penalizedTrackPath(world, from, to, penalties);
    if (!candidate) break;
    if (pathTotalLength(candidate) > limit) break;
    if (routes.some((route) => samePath(route, candidate))) break;
    routes.push(candidate);
  }
  index.trackAlternatives.set(key, routes);
  return routes;
}

/**
 * Every route worth considering between two points, shortest first. Callers get
 * their own copies, as they do from `findTrackPath`.
 */
export function findTrackPathOptions(
  world: World,
  from: Point,
  to: Point,
): Point[][] {
  if (!isGridPoint(from) || !isGridPoint(to)) return [];
  if (samePoint(from, to)) return [[{ ...from }]];
  const graph = trackGraph(world);
  if (!graph.has(nodeKey(from)) || !graph.has(nodeKey(to))) return [];
  return trackAlternatives(world, from, to).map((route) =>
    route.map((point) => ({ x: point.x, y: point.y })),
  );
}

const WALK_DIRECTIONS: Point[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];
const WALK_STEP_COSTS = WALK_DIRECTIONS.map((direction) =>
  Math.hypot(direction.x, direction.y),
);

interface WalkGrid {
  stamp: string;
  occupied: Uint8Array;
}
const walkGrids = new WeakMap<World, WalkGrid>();

/** The pedestrian obstacle mask depends only on the building footprints, so it
 * is shared by every search until a building appears, moves, or is removed. */
function walkOccupancy(world: World): Uint8Array {
  let hash = world.buildings.length | 0;
  for (const building of world.buildings) {
    hash = (Math.imul(hash, 31) + building.x) | 0;
    hash = (Math.imul(hash, 31) + building.y) | 0;
    hash = (Math.imul(hash, 31) + building.w) | 0;
    hash = (Math.imul(hash, 31) + building.h) | 0;
  }
  const stamp = `${world.width}x${world.height}:${world.buildings.length}:${hash}`;
  const existing = walkGrids.get(world);
  if (existing?.stamp === stamp) return existing.occupied;
  const occupied = new Uint8Array(world.width * world.height);
  for (const building of world.buildings)
    for (let y = building.y; y < building.y + building.h; y++)
      for (let x = building.x; x < building.x + building.w; x++)
        if (x >= 0 && y >= 0 && x < world.width && y < world.height)
          occupied[y * world.width + x] = 1;
  walkGrids.set(world, { stamp, occupied });
  return occupied;
}

/**
 * Lexicographic rank of every `node:x,y` key on a grid of this size. The A*
 * frontier used to break ties by comparing those strings; ranking them once
 * keeps that exact order while comparing plain integers.
 */
const walkRanks = new Map<string, Int32Array>();
function gridLexRanks(width: number, height: number): Int32Array {
  const stamp = `${width}x${height}`;
  const existing = walkRanks.get(stamp);
  if (existing) return existing;
  const size = width * height;
  const keys = new Array<string>(size);
  const order = new Array<number>(size);
  for (let index = 0; index < size; index += 1) {
    keys[index] = `${index % width},${Math.floor(index / width)}`;
    order[index] = index;
  }
  order.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
  const ranks = new Int32Array(size);
  for (let rank = 0; rank < size; rank += 1) ranks[order[rank]] = rank;
  walkRanks.set(stamp, ranks);
  return ranks;
}

/** Per-search scratch state, reused so a search allocates nothing per cell.
 * `stamps` marks which cells the current search has already written. */
const walkScratch = {
  size: 0,
  costs: new Float64Array(0),
  parents: new Int32Array(0),
  closed: new Uint8Array(0),
  stamps: new Int32Array(0),
  generation: 0,
};
function walkScratchFor(size: number) {
  if (walkScratch.size !== size) {
    walkScratch.size = size;
    walkScratch.costs = new Float64Array(size);
    walkScratch.parents = new Int32Array(size);
    walkScratch.closed = new Uint8Array(size);
    walkScratch.stamps = new Int32Array(size);
    walkScratch.generation = 0;
  }
  walkScratch.generation += 1;
  if (walkScratch.generation === 0x7fffffff) {
    walkScratch.stamps.fill(0);
    walkScratch.generation = 1;
  }
  return walkScratch;
}

interface WalkEntry {
  index: number;
  score: number;
  heuristic: number;
  rank: number;
}

/** Eight-direction A* for pedestrians. Diagonal steps may not cut blocked corners. */
function computeWalkPath(world: World, from: Point, to: Point): Point[] | null {
  const width = world.width;
  const height = world.height;
  const occupied = walkOccupancy(world);
  const free = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height &&
    occupied[y * width + x] === 0;
  if (!isGridPoint(from) || !isGridPoint(to)) return null;
  if (!free(from.x, from.y) || !free(to.x, to.y)) return null;
  if (samePoint(from, to)) return [{ ...from }];

  const size = width * height;
  const ranks = gridLexRanks(width, height);
  const scratch = walkScratchFor(size);
  const { costs, parents, closed, stamps } = scratch;
  const generation = scratch.generation;
  const start = from.y * width + from.x;
  const end = to.y * width + to.x;

  // Same order the former linear scan produced: lowest f, then lowest
  // heuristic, then the lexicographically smaller node key.
  const open = new Frontier<WalkEntry>(
    (a, b) =>
      a.score < b.score - EPSILON ||
      (Math.abs(a.score - b.score) <= EPSILON &&
        (a.heuristic < b.heuristic - EPSILON ||
          (Math.abs(a.heuristic - b.heuristic) <= EPSILON && a.rank < b.rank))),
  );
  const startHeuristic = distance(from, to);
  costs[start] = 0;
  parents[start] = -1;
  closed[start] = 0;
  stamps[start] = generation;
  open.push({
    index: start,
    score: startHeuristic,
    heuristic: startHeuristic,
    rank: ranks[start],
  });

  while (open.size) {
    const current = open.pop();
    const index = current.index;
    if (closed[index]) continue;
    if (index === end) {
      const reversed: Point[] = [];
      for (let step = end; step !== -1; step = parents[step])
        reversed.push({ x: step % width, y: Math.floor(step / width) });
      return reversed.reverse();
    }
    closed[index] = 1;
    const x = index % width;
    const y = (index - x) / width;
    const cost = costs[index];
    for (let d = 0; d < WALK_DIRECTIONS.length; d += 1) {
      const direction = WALK_DIRECTIONS[d];
      const nextX = x + direction.x;
      const nextY = y + direction.y;
      if (!free(nextX, nextY)) continue;
      if (
        direction.x !== 0 &&
        direction.y !== 0 &&
        (!free(nextX, y) || !free(x, nextY))
      )
        continue;

      const nextIndex = nextY * width + nextX;
      const fresh = stamps[nextIndex] !== generation;
      if (!fresh && closed[nextIndex]) continue;
      const candidate = cost + WALK_STEP_COSTS[d];
      if (!fresh && candidate >= costs[nextIndex] - EPSILON) continue;
      if (fresh) {
        stamps[nextIndex] = generation;
        closed[nextIndex] = 0;
      }
      costs[nextIndex] = candidate;
      parents[nextIndex] = index;
      const heuristic = Math.hypot(nextX - to.x, nextY - to.y);
      open.push({
        index: nextIndex,
        score: candidate + heuristic,
        heuristic,
        rank: ranks[nextIndex],
      });
    }
  }
  return null;
}
