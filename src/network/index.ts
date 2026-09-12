/**
 * Pure geometry planner for free-form track drawing.
 * It intentionally has no knowledge of a live Game: callers validate cash and
 * reservations, then atomically apply this plan to their own state.
 */
import type { CityNode, EdgeView, Localized, NodeView, TrackPoint } from '../shared/types';
import { ECONOMY, WORLD, connectionInfo } from '../scenarios/city';

export interface PlannedEdge {
  id: string;
  from: string;
  to: string;
  length: number;
  cost: number;
  travelTime: number;
  bridge: boolean;
  level: number;
  trips: number;
}

export type PlanningResult =
  | {
      ok: true;
      cost: number;
      addNodes: CityNode[];
      addEdges: PlannedEdge[];
      removeEdgeIds: string[];
    }
  | { ok: false; message: Localized };

const MIN_SEGMENT = 12;
const JUNCTION_MARGIN = 40;
const CANAL_LEFT = 770;
const CANAL_RIGHT = 900;
const BUILDING_RADIUS = 40;
const EPS = 1e-6;
const fail = (zh: string, en: string): PlanningResult => ({ ok: false, message: { zh, en } });
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pairKey = (a: string, b: string) => [a, b].sort().join('\u0000');
const plannedId = (a: string, b: string) => `e:${[a, b].sort().join('--')}`;
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);

type Position = { x: number; y: number };
type ResolvedPoint = { id: string; x: number; y: number; sourceEdge?: EdgeView; t?: number };
type Candidate = { from: string; to: string; source?: EdgeView; sourceIndex?: number };

function pointToSegment(point: Position, a: Position, b: Position) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPS) return null;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return { t, x: a.x + dx * t, y: a.y + dy * t };
}

function pointSegmentDistance(point: Position, a: Position, b: Position) {
  const projection = pointToSegment(point, a, b);
  return projection
    ? Math.hypot(point.x - projection.x, point.y - projection.y)
    : distance(point, a);
}

function districtAt(x: number, y: number): CityNode['district'] {
  return x > 900 ? 'campus' : y < 540 ? 'north' : 'central';
}

function nextJunctionNumber(nodes: NodeView[]) {
  return (
    nodes.reduce((max, node) => {
      const match = /^j(\d+)$/.exec(node.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1
  );
}

function validWorldPoint(point: Position) {
  return (
    point.x >= JUNCTION_MARGIN &&
    point.x <= WORLD.width - JUNCTION_MARGIN &&
    point.y >= JUNCTION_MARGIN &&
    point.y <= WORLD.height - JUNCTION_MARGIN
  );
}

function isWater(point: Position) {
  return point.x >= CANAL_LEFT && point.x <= CANAL_RIGHT;
}

function isBuilding(node: NodeView) {
  return node.kind !== 'junction';
}

/**
 * Plans a single free-hand polyline. Edge crossings without an `edgeId` are
 * intentionally ignored: they are grade-separated and never form a junction.
 */
export function planTrack(
  nodes: NodeView[],
  edges: EdgeView[],
  points: TrackPoint[],
): PlanningResult {
  if (
    !Array.isArray(nodes) ||
    !Array.isArray(edges) ||
    !Array.isArray(points) ||
    points.length < 2 ||
    points.length > 32
  ) {
    return fail('轨道需要 2 到 32 个有效点。', 'Track needs between 2 and 32 valid points.');
  }
  const nodeById = new Map<string, NodeView>();
  const positions = new Map<string, Position>();
  for (const node of nodes) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      nodeById.has(node.id) ||
      !finite(node.x) ||
      !finite(node.y) ||
      !finite(node.portX) ||
      !finite(node.portY)
    ) {
      return fail('网络快照包含无效节点。', 'Network snapshot contains an invalid node.');
    }
    nodeById.set(node.id, node);
    positions.set(node.id, { x: node.portX, y: node.portY });
  }
  const edgeById = new Map<string, EdgeView>();
  const existingPairs = new Set<string>();
  for (const edge of edges) {
    if (
      !edge ||
      typeof edge.id !== 'string' ||
      edgeById.has(edge.id) ||
      !nodeById.has(edge.from) ||
      !nodeById.has(edge.to) ||
      edge.from === edge.to ||
      !finite(edge.length) ||
      !finite(edge.travelTime) ||
      !Number.isInteger(edge.level) ||
      edge.level < 1
    ) {
      return fail('网络快照包含无效轨道。', 'Network snapshot contains an invalid edge.');
    }
    const key = pairKey(edge.from, edge.to);
    if (existingPairs.has(key))
      return fail('网络快照包含重复轨道。', 'Network snapshot contains duplicate edges.');
    edgeById.set(edge.id, edge);
    existingPairs.add(key);
  }

  const addNodes: CityNode[] = [];
  const resolved: ResolvedPoint[] = [];
  let junctionNumber = nextJunctionNumber(nodes);
  const uniquePositions: Position[] = [];
  const addJunction = (x: number, y: number): ResolvedPoint => {
    const id = `j${junctionNumber++}`;
    const node: CityNode = {
      id,
      name: { zh: `自建枢纽 ${id.slice(1)}`, en: `Junction ${id.slice(1)}` },
      x,
      y,
      kind: 'junction',
      district: districtAt(x, y),
      population: 0,
    };
    addNodes.push(node);
    positions.set(id, { x, y });
    return { id, x, y };
  };

  for (let index = 0; index < points.length; index++) {
    const input = points[index];
    if (!input || !finite(input.x) || !finite(input.y) || !validWorldPoint(input))
      return fail('轨道点必须位于城市范围内。', 'Track points must be inside the city bounds.');
    if (input.nodeId && input.edgeId)
      return fail(
        '一个轨道点只能吸附到节点或轨道。',
        'A track point may snap to either a node or an edge.',
      );
    let item: ResolvedPoint;
    if (input.nodeId !== undefined) {
      const node = nodeById.get(input.nodeId);
      if (!node || !node.portBuilt)
        return fail(
          '只能吸附到已建楼宇接入口或节点。',
          'Only built ports or junctions can be snapped.',
        );
      const position = positions.get(node.id)!;
      item = { id: node.id, ...position };
    } else if (input.edgeId !== undefined) {
      const edge = edgeById.get(input.edgeId);
      if (!edge) return fail('吸附的轨道不存在。', 'The snapped edge does not exist.');
      const a = positions.get(edge.from)!,
        b = positions.get(edge.to)!;
      const projection = pointToSegment(input, a, b);
      if (!projection || isWater(projection))
        return fail('不能在运河水面设置枢纽。', 'A junction cannot be placed in the canal.');
      item = addJunction(projection.x, projection.y);
      item.sourceEdge = edge;
      item.t = projection.t;
    } else {
      if (isWater(input))
        return fail('轨道拐点不能位于运河水面。', 'A free track waypoint cannot be in the canal.');
      item = addJunction(input.x, input.y);
    }
    if (uniquePositions.some((position) => distance(position, item) < EPS))
      return fail('轨道包含重复点。', 'Track contains duplicate points.');
    uniquePositions.push(item);
    resolved.push(item);
  }

  // Buildings may be endpoints only. This also keeps a drawn polyline from
  // treating a building as an invisible pass-through junction.
  for (let index = 1; index + 1 < resolved.length; index++) {
    const node = nodeById.get(resolved[index].id);
    if (node && isBuilding(node))
      return fail(
        '建筑只能作为线路起点或终点。',
        'Buildings can only be the first or last track point.',
      );
  }
  for (const node of addNodes) {
    if (
      nodes.some((building) => isBuilding(building) && distance(node, building) < BUILDING_RADIUS)
    ) {
      return fail('枢纽不能与建筑重叠。', 'A junction cannot overlap a building.');
    }
  }

  const candidates: Candidate[] = [];
  for (let index = 0; index + 1 < resolved.length; index++)
    candidates.push({ from: resolved[index].id, to: resolved[index + 1].id });

  const removeEdgeIds = new Set<string>();
  const snapsByEdge = new Map<string, ResolvedPoint[]>();
  for (const item of resolved)
    if (item.sourceEdge) {
      const list = snapsByEdge.get(item.sourceEdge.id) || [];
      list.push(item);
      snapsByEdge.set(item.sourceEdge.id, list);
    }
  for (const [sourceId, snaps] of snapsByEdge) {
    const source = edgeById.get(sourceId)!;
    snaps.sort((a, b) => a.t! - b.t! || a.id.localeCompare(b.id));
    for (let i = 1; i < snaps.length; i++)
      if (Math.abs(snaps[i].t! - snaps[i - 1].t!) < EPS)
        return fail('轨道包含重复吸附点。', 'Track contains duplicate snapped points.');
    removeEdgeIds.add(source.id);
    const chain = [source.from, ...snaps.map((item) => item.id), source.to];
    for (let i = 0; i + 1 < chain.length; i++)
      candidates.push({ from: chain[i], to: chain[i + 1], source, sourceIndex: i });
  }

  const finalCandidates = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (candidate.from === candidate.to)
      return fail('轨道不能形成零长度连接。', 'A track cannot form a zero-length connection.');
    const from = positions.get(candidate.from),
      to = positions.get(candidate.to);
    if (!from || !to || distance(from, to) < MIN_SEGMENT)
      return fail('轨道每一段至少需要 12 米。', 'Each track segment must be at least 12 metres.');
    const key = pairKey(candidate.from, candidate.to);
    const existing = finalCandidates.get(key);
    if (existing) {
      if (existing.source || candidate.source) {
        // Reusing a portion just exposed by a split is one physical track,
        // not a second parallel connection. Retain the zero-cost replacement.
        if (!existing.source && candidate.source) finalCandidates.set(key, candidate);
        continue;
      }
      return fail('轨道包含重复连接。', 'Track contains a duplicate connection.');
    }
    if (
      existingPairs.has(key) &&
      ![...removeEdgeIds].some((id) => {
        const edge = edgeById.get(id)!;
        return pairKey(edge.from, edge.to) === key;
      })
    )
      return fail('这条连接已经存在。', 'That connection already exists.');
    finalCandidates.set(key, candidate);
  }

  for (const candidate of finalCandidates.values()) {
    const from = positions.get(candidate.from)!,
      to = positions.get(candidate.to)!;
    for (const building of nodes.filter(isBuilding)) {
      if (building.id === candidate.from || building.id === candidate.to) continue;
      const center = { x: building.x, y: building.y };
      if (pointSegmentDistance(center, from, to) < BUILDING_RADIUS - EPS)
        return fail('轨道不能穿过建筑。', 'Track cannot pass through a building.');
    }
  }

  const splitTimes = new Map<string, number[]>();
  for (const [sourceId, snaps] of snapsByEdge) {
    const source = edgeById.get(sourceId)!;
    const raw = [
      snaps[0].t!,
      ...snaps.slice(1).map((item, i) => item.t! - snaps[i].t!),
      1 - snaps.at(-1)!.t!,
    ];
    // Proportional whole-second allocation preserves the original total when
    // possible; every usable replacement still receives at least one second.
    const times = raw.map((portion) => Math.max(1, Math.round(source.travelTime * portion)));
    splitTimes.set(sourceId, times);
  }
  const addEdges: PlannedEdge[] = [];
  let cost = 0;
  for (const candidate of finalCandidates.values()) {
    const coords: Record<string, Position> = {
      [candidate.from]: positions.get(candidate.from)!,
      [candidate.to]: positions.get(candidate.to)!,
    };
    const info = connectionInfo(candidate.from, candidate.to, coords);
    if (
      !info ||
      !finite(info.cost) ||
      !finite(info.length) ||
      !finite(info.travelTime) ||
      info.cost < 0 ||
      info.length <= 0 ||
      info.travelTime <= 0
    ) {
      return fail('无法计算这段轨道。', 'This track segment could not be calculated.');
    }
    const source = candidate.source;
    const sequence = candidate.sourceIndex ?? 0;
    const edge: PlannedEdge = {
      id: plannedId(candidate.from, candidate.to),
      from: candidate.from,
      to: candidate.to,
      length: info.length,
      cost: source ? 0 : info.cost,
      travelTime: source ? splitTimes.get(source.id)![sequence] : info.travelTime,
      bridge: info.bridge,
      level: source ? source.level : 1,
      trips: source ? source.trips : 0,
    };
    addEdges.push(edge);
    cost += edge.cost;
  }
  cost += addNodes.length * ECONOMY.junctionCost;
  if (!Number.isFinite(cost) || cost < 0) return fail('轨道费用无效。', 'Track cost is invalid.');
  return { ok: true, cost, addNodes, addEdges, removeEdgeIds: [...removeEdgeIds].sort() };
}
