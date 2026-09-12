import { TRACK_COST } from "../shared/constants";
import { distance, samePoint } from "../shared/math";
import type {
  Building,
  Point,
  Track,
  TrackDraft,
  World,
} from "../shared/types";

const EPSILON = 1e-9;

interface PathCache {
  signature: string;
  paths: Map<string, Point[] | null>;
}
const pathCaches = new WeakMap<World, PathCache>();

interface ResourceConnection {
  point: Point;
  track?: Track;
}
interface ResourceIndex {
  stamp: string;
  tracksByEdge: Map<string, Track>;
  connectionsByNode: Map<string, ResourceConnection[]>;
}
const resourceIndexes = new WeakMap<World, ResourceIndex>();

function resourceIndex(world: World): ResourceIndex {
  const stamp = `${world.networkVersion}:${world.tracks.length}:${world.berths.length}`;
  const existing = resourceIndexes.get(world);
  if (existing?.stamp === stamp) return existing;
  const tracksByEdge = new Map<string, Track>();
  const connectionsByNode = new Map<string, ResourceConnection[]>();
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
  }
  const index = { stamp, tracksByEdge, connectionsByNode };
  resourceIndexes.set(world, index);
  return index;
}
function cachedPath(
  world: World,
  from: Point,
  to: Point,
  walking: boolean,
): Point[] | null {
  // All production topology edits increment networkVersion. Counts additionally
  // protect construction fixtures; direct coordinate edits must bump the version.
  const signature = `${world.networkVersion}:${world.width},${world.height}:${world.buildings.length}:${world.berths.length}:${world.tracks.length}`;
  let cache = pathCaches.get(world);
  if (!cache || cache.signature !== signature) {
    cache = { signature, paths: new Map() };
    pathCaches.set(world, cache);
  }
  const key = `${walking ? "walk" : "track"}:${from.x},${from.y}:${to.x},${to.y}`;
  if (!cache.paths.has(key))
    cache.paths.set(
      key,
      walking
        ? computeWalkPath(world, from, to)
        : computeTrackPath(world, from, to),
    );
  return cache.paths.get(key)?.map((p) => ({ ...p })) ?? null;
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
  const [first, second] = canonicalPair(a, b);
  return `edge:${first.x},${first.y}~${second.x},${second.y}`;
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

function trackAt(world: World, a: Point, b: Point): Track | undefined {
  return resourceIndex(world).tracksByEdge.get(edgeKey(a, b));
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
  return trackAt(world, a, b)?.lanes ?? 1;
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

/** Every legal physical-lane choice for this movement. */
export function movementResourceOptions(
  world: World,
  a: Point,
  b: Point,
): string[][] {
  const lanes = trackLaneCount(world, a, b);
  return Array.from({ length: lanes }, (_, laneIndex) => [
    lanes === 1 ? edgeKey(a, b) : laneKey(a, b, laneIndex),
    ...crossingSlotResources(a, b, laneIndex),
  ]);
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
  return options[laneIndex];
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
  if (
    neighbors.length !== 2 ||
    neighbors[0].lanes < 2 ||
    neighbors[0].lanes !== neighbors[1].lanes
  )
    return null;
  return {
    neighbors: neighbors.map((entry) => entry.point).sort(comparePoints),
    lanes: neighbors[0].lanes as 2 | 3,
  };
}

const corridorLaneKey = (point: Point, laneIndex: number) =>
  `node-lane:${point.x},${point.y}:${laneIndex}`;
const legacyCorridorLaneKey = (point: Point, from: Point, to: Point) =>
  `node-lane:${point.x},${point.y}:${from.x},${from.y}>${to.x},${to.y}`;

/** The shared node plus any legal physical-lane channels at this point. */
export function corridorNodeResources(world: World, point: Point): string[] {
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
  return [nodeKey(point)];
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

/** Finds a shortest route over built track plus every automatic berth spur. */
function computeTrackPath(
  world: World,
  from: Point,
  to: Point,
): Point[] | null {
  if (!isGridPoint(from) || !isGridPoint(to)) return null;
  if (samePoint(from, to)) return [{ ...from }];

  const graph = new Map<string, GraphEdge[]>();
  for (const track of world.tracks) addGraphEdge(graph, track.a, track.b);
  for (const berth of world.berths)
    addGraphEdge(graph, berth.point, berth.access);

  const startKey = nodeKey(from);
  const endKey = nodeKey(to);
  if (!graph.has(startKey) || !graph.has(endKey)) return null;

  const terminalKeys = new Set(
    world.berths.map((berth) => nodeKey(berth.point)),
  );
  const distances = new Map<string, number>([[startKey, 0]]);
  const parents = new Map<string, string>();
  const pointsByKey = new Map<string, Point>([[startKey, { ...from }]]);
  const unsettled = new Set<string>([startKey]);

  while (unsettled.size) {
    let current: string | undefined;
    for (const key of unsettled) {
      if (
        current === undefined ||
        distances.get(key)! < distances.get(current)! - EPSILON ||
        (Math.abs(distances.get(key)! - distances.get(current)!) <= EPSILON &&
          key < current)
      ) {
        current = key;
      }
    }
    if (current === undefined) break;
    unsettled.delete(current);
    if (current === endKey)
      return reconstructPath(parents, pointsByKey, endKey);
    if (terminalKeys.has(current) && current !== startKey) continue;

    const neighbors = [...(graph.get(current) ?? [])].sort((a, b) =>
      nodeKey(a.point).localeCompare(nodeKey(b.point)),
    );
    for (const neighbor of neighbors) {
      const key = nodeKey(neighbor.point);
      if (terminalKeys.has(key) && key !== endKey) continue;
      const candidate = distances.get(current)! + neighbor.cost;
      if (
        candidate <
        (distances.get(key) ?? Number.POSITIVE_INFINITY) - EPSILON
      ) {
        distances.set(key, candidate);
        parents.set(key, current);
        pointsByKey.set(key, { ...neighbor.point });
        unsettled.add(key);
      }
    }
  }
  return null;
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

/** Eight-direction A* for pedestrians. Diagonal steps may not cut blocked corners. */
function computeWalkPath(world: World, from: Point, to: Point): Point[] | null {
  // A larger city must not scan every building for every A* neighbor.
  // This occupancy mask belongs to this search; topology changes cannot stale it.
  const occupied = new Uint8Array(world.width * world.height);
  for (const building of world.buildings)
    for (let y = building.y; y < building.y + building.h; y++)
      for (let x = building.x; x < building.x + building.w; x++)
        if (x >= 0 && y >= 0 && x < world.width && y < world.height)
          occupied[y * world.width + x] = 1;
  const blocked = (point: Point) =>
    !isGridPoint(point) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= world.width ||
    point.y >= world.height ||
    occupied[point.y * world.width + point.x] === 1;
  if (blocked(from) || blocked(to)) return null;
  if (samePoint(from, to)) return [{ ...from }];

  const startKey = nodeKey(from);
  const endKey = nodeKey(to);
  const open = new Set<string>([startKey]);
  const closed = new Set<string>();
  const costs = new Map<string, number>([[startKey, 0]]);
  const parents = new Map<string, string>();
  const pointsByKey = new Map<string, Point>([[startKey, { ...from }]]);

  while (open.size) {
    let currentKey: string | undefined;
    let currentScore = Number.POSITIVE_INFINITY;
    let currentHeuristic = Number.POSITIVE_INFINITY;
    for (const key of open) {
      const point = pointsByKey.get(key)!;
      const heuristic = distance(point, to);
      const score = costs.get(key)! + heuristic;
      if (
        score < currentScore - EPSILON ||
        (Math.abs(score - currentScore) <= EPSILON &&
          heuristic < currentHeuristic - EPSILON) ||
        (Math.abs(score - currentScore) <= EPSILON &&
          Math.abs(heuristic - currentHeuristic) <= EPSILON &&
          (currentKey === undefined || key < currentKey))
      ) {
        currentKey = key;
        currentScore = score;
        currentHeuristic = heuristic;
      }
    }
    if (currentKey === undefined) break;
    if (currentKey === endKey)
      return reconstructPath(parents, pointsByKey, endKey);

    open.delete(currentKey);
    closed.add(currentKey);
    const current = pointsByKey.get(currentKey)!;
    for (const direction of WALK_DIRECTIONS) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      if (blocked(next)) continue;
      if (
        direction.x !== 0 &&
        direction.y !== 0 &&
        (blocked({ x: current.x + direction.x, y: current.y }) ||
          blocked({ x: current.x, y: current.y + direction.y }))
      ) {
        continue;
      }

      const nextKey = nodeKey(next);
      if (closed.has(nextKey)) continue;
      const candidate =
        costs.get(currentKey)! + Math.hypot(direction.x, direction.y);
      if (
        candidate <
        (costs.get(nextKey) ?? Number.POSITIVE_INFINITY) - EPSILON
      ) {
        costs.set(nextKey, candidate);
        parents.set(nextKey, currentKey);
        pointsByKey.set(nextKey, next);
        open.add(nextKey);
      }
    }
  }
  return null;
}
