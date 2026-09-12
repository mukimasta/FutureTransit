/** Deterministic, discrete-time simulation. All times are integer simulation seconds. */
import type {
  CityNode,
  Command,
  CommandResult,
  EdgeView,
  Localized,
  Metrics,
  Mission,
  Notice,
  PodStatus,
  PortSide,
  Snapshot,
} from '../shared/types';
import { CITY_NODES, ECONOMY, WORLD } from '../scenarios/city';
import { planTrack } from '../network';
import { chooseDemandPair, choosesPod, estimateExpectedWait } from './demand';
import { applyJourneyEconomy } from './economy';

const CLEARANCE = 1;
const MAX_QUEUE = 72;
const MAX_HISTORY = 180;
const MAX_NOTICES = 24;
const MAX_BOOKINGS = 5000;
const MAX_WAITS = 400;
const MAX_WAIT = 170;
const SAVE_VERSION = 1;
type Booking = { start: number; end: number; trip: number };
type Segment = {
  from: string;
  to: string;
  start: number;
  end: number;
  resource: string;
  edgeId?: string;
};
type Journey = {
  id: number;
  kind: 'empty' | 'customer';
  origin: string;
  destination: string;
  departure: number;
  arrival: number;
  path: string[];
  segments: Segment[];
  fare?: number;
  requestId?: number;
  requestedAt?: number;
  event?: boolean;
  completed?: boolean;
  started?: boolean;
};
type Pod = {
  id: number;
  home: string;
  at: string;
  status: PodStatus;
  plan?: { empty: Journey | null; customer: Journey; requestId: number };
};
type Request = {
  id: number;
  origin: string;
  destination: string;
  created: number;
  predicted: number;
  event?: boolean;
};
type Edge = {
  id: string;
  from: string;
  to: string;
  length: number;
  cost: number;
  travelTime: number;
  bridge: boolean;
  level: number;
  trips: number;
};
type NodeState = CityNode & {
  portBuilt: boolean;
  portX: number;
  portY: number;
  portLevel: number;
  served: number;
  growth: number;
};
type InternalMission = Mission & { awarded: boolean };

export interface Game {
  saveVersion: number;
  seed: number;
  rng: number;
  demandRng: number;
  modeRng: number;
  revision: number;
  simTime: number;
  running: boolean;
  speed: 1 | 3 | 8;
  cash: number;
  fare: number;
  serviceOpen: boolean;
  nodes: Record<string, NodeState>;
  edges: Edge[];
  pods: Pod[];
  requests: Request[];
  calendars: Record<string, Booking[]>;
  nextRequest: number;
  nextJourney: number;
  nextNotice: number;
  served: number;
  startedCustomerTrips: number;
  abandoned: number;
  totalDemand: number;
  revenue: number;
  expenses: number;
  emptyTrips: number;
  waits: number[];
  notices: Notice[];
  demandLog: { time: number; from: string; to: string }[];
  serviceTimes: number[];
  outcomes: { time: number; kind: 'served' | 'abandoned' }[];
  history: { time: number; served: number; waiting: number; share: number }[];
  missions: InternalMission[];
  event: { active: boolean; endsAt: number; nextAt: number; fired: number; served: number };
}

const L = (zh: string, en: string): Localized => ({ zh, en });
const ok = (): CommandResult => ({ ok: true });
const fail = (zh: string, en: string): CommandResult => ({ ok: false, message: L(zh, en) });
const edgeId = (a: string, b: string) => `e:${[a, b].sort().join('--')}`;
const activeMission = (g: Game) => g.missions.find((m) => !m.completed);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nodeId = (g: Game, id: unknown): id is string =>
  typeof id === 'string' && Object.prototype.hasOwnProperty.call(g.nodes, id);
const point = (g: Game, id: string) => ({ x: g.nodes[id].portX, y: g.nodes[id].portY });

function randDemand(g: Game) {
  g.demandRng = (Math.imul(g.demandRng, 1664525) + 1013904223) >>> 0;
  return g.demandRng / 0x100000000;
}
function randMode(g: Game) {
  g.modeRng = (Math.imul(g.modeRng, 1664525) + 1013904223) >>> 0;
  return g.modeRng / 0x100000000;
}
function addNotice(
  g: Game,
  tone: Notice['tone'],
  zh: string,
  en: string,
  textZh = '',
  textEn = '',
) {
  g.notices.unshift({
    id: g.nextNotice++,
    time: g.simTime,
    tone,
    title: L(zh, en),
    text: L(textZh || zh, textEn || en),
  });
  g.notices.length = Math.min(g.notices.length, MAX_NOTICES);
}
function missions(): InternalMission[] {
  return [
    {
      id: 'open',
      title: L('启用首条服务', 'Open first service'),
      description: L(
        '连接居住区与工作或大学区，并启用服务。',
        'Connect a home to work or university, then open service.',
      ),
      progress: 0,
      target: 1,
      reward: 450,
      completed: false,
      awarded: false,
    },
    {
      id: 'serve15',
      title: L('初见规模', 'First momentum'),
      description: L('完成 15 次乘客出行。', 'Complete 15 passenger trips.'),
      progress: 0,
      target: 15,
      reward: 650,
      completed: false,
      awarded: false,
    },
    {
      id: 'connected6',
      title: L('拓展网络', 'Expand the network'),
      description: L('连接 6 个地点。', 'Connect 6 locations.'),
      progress: 0,
      target: 6,
      reward: 700,
      completed: false,
      awarded: false,
    },
    {
      id: 'serve75',
      title: L('可靠运营', 'Reliable service'),
      description: L('完成 75 次乘客出行。', 'Complete 75 passenger trips.'),
      progress: 0,
      target: 75,
      reward: 1000,
      completed: false,
      awarded: false,
    },
    {
      id: 'canal',
      title: L('跨越运河', 'Cross the canal'),
      description: L('建造一条跨运河线路。', 'Build a canal-crossing connection.'),
      progress: 0,
      target: 1,
      reward: 850,
      completed: false,
      awarded: false,
    },
    {
      id: 'concert',
      title: L('音乐之夜', 'Concert night'),
      description: L(
        '活动期间完成 8 次前往湾畔体育场的乘客行程。',
        'Complete 8 passenger trips to Bayfront Arena during an event.',
      ),
      progress: 0,
      target: 8,
      reward: 900,
      completed: false,
      awarded: false,
    },
  ];
}

export function createGame(seed = 7): Game {
  const normalized = Number.isInteger(seed) ? seed >>> 0 : 7;
  const nodes: Record<string, NodeState> = {};
  for (const n of CITY_NODES)
    nodes[n.id] = {
      ...n,
      portBuilt: false,
      portX: n.x,
      portY: n.y,
      portLevel: 1,
      served: 0,
      growth: 0,
    };
  const g: Game = {
    saveVersion: SAVE_VERSION,
    seed: normalized,
    rng: normalized || 1,
    demandRng: (normalized ^ 0x9e3779b9) >>> 0 || 1,
    modeRng: (normalized ^ 0x85ebca6b) >>> 0 || 1,
    revision: 0,
    simTime: 0,
    running: false,
    speed: 1,
    cash: ECONOMY.initialCash,
    fare: 5,
    serviceOpen: false,
    nodes,
    edges: [],
    pods: [],
    requests: [],
    calendars: {},
    nextRequest: 1,
    nextJourney: 1,
    nextNotice: 1,
    served: 0,
    startedCustomerTrips: 0,
    abandoned: 0,
    totalDemand: 0,
    revenue: 0,
    expenses: 0,
    emptyTrips: 0,
    waits: [],
    notices: [],
    demandLog: [],
    serviceTimes: [],
    outcomes: [],
    history: [],
    missions: missions(),
    event: { active: false, endsAt: 0, nextAt: 360, fired: 0, served: 0 },
  };
  for (let i = 0; i < ECONOMY.startingPods; i++)
    g.pods.push({ id: i + 1, home: 'n1', at: 'n1', status: 'idle' });
  addNotice(
    g,
    'info',
    '欢迎来到青湾市',
    'Welcome to Bayhaven',
    '建造连接后即可开启自动舱服务。',
    'Build a connection to launch pod service.',
  );
  return g;
}

function graph(g: Game) {
  const out: Record<string, Edge[]> = {};
  for (const e of g.edges) {
    (out[e.from] ||= []).push(e);
    (out[e.to] ||= []).push(e);
  }
  for (const value of Object.values(out)) value.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
/** Stable Dijkstra: ties are resolved by lexical path, so saves and replays agree. */
function route(g: Game, origin: string, destination: string): string[] | null {
  if (origin === destination) return [origin];
  const adj = graph(g);
  if (!adj[origin] || !adj[destination]) return null;
  const queue: { node: string; time: number; key: string; path: string[] }[] = [
    { node: origin, time: 0, key: origin, path: [origin] },
  ];
  const best: Record<string, { time: number; key: string }> = {};
  while (queue.length) {
    queue.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
    const cur = queue.shift()!;
    const prev = best[cur.node];
    if (prev && (prev.time < cur.time || (prev.time === cur.time && prev.key <= cur.key))) continue;
    best[cur.node] = { time: cur.time, key: cur.key };
    if (cur.node === destination) return cur.path;
    if (cur.node !== origin && g.nodes[cur.node].kind !== 'junction') continue;
    for (const e of adj[cur.node] || []) {
      const next = e.from === cur.node ? e.to : e.from;
      queue.push({
        node: next,
        time: cur.time + e.travelTime,
        key: `${cur.key}/${next}`,
        path: [...cur.path, next],
      });
    }
  }
  return null;
}
function edgeFor(g: Game, a: string, b: string) {
  return g.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}
function template(g: Game, path: string[]) {
  const out: Omit<Segment, 'start' | 'end' | 'resource'>[] = [];
  for (let i = 0; i < path.length; i++) {
    out.push({ from: path[i], to: path[i] });
    if (i + 1 < path.length) {
      const e = edgeFor(g, path[i], path[i + 1])!;
      out.push({ from: path[i], to: path[i + 1], edgeId: e.id });
    }
  }
  return out;
}
function intervalConflict(entries: Booking[], start: number, end: number) {
  for (const booking of entries) {
    if (booking.start >= end) break;
    if (start < booking.end && booking.start < end) return booking;
  }
  return undefined;
}
function choices(g: Game, s: Omit<Segment, 'start' | 'end' | 'resource'>) {
  if (!s.edgeId)
    return Array.from({ length: g.nodes[s.from].portLevel }, (_, n) => `node:${s.from}:port:${n}`);
  const level = g.edges.find((e) => e.id === s.edgeId)!.level;
  return Array.from({ length: level }, (_, n) => `edge:${s.edgeId}:lane:${n}`);
}
/** Finds a departure at which every segment has a resource, then commits once. */
function reserve(
  g: Game,
  kind: Journey['kind'],
  origin: string,
  destination: string,
  ready: number,
  requestId?: number,
  fare?: number,
): Journey | null {
  const path = route(g, origin, destination);
  if (!path) return null;
  const parts = template(g, path);
  let offset = 0;
  const planned = parts.map((p) => {
    const duration = p.edgeId ? g.edges.find((e) => e.id === p.edgeId)!.travelTime : 1;
    const r = { ...p, offset, duration };
    offset += duration;
    return r;
  });
  let departure = Math.ceil(ready);
  for (let attempt = 0; attempt < 1000; attempt++) {
    let jump = departure;
    const chosen: string[] = [];
    for (const p of planned) {
      const start = departure + p.offset,
        end = start + p.duration + CLEARANCE;
      let free: string | undefined;
      let earliest = Infinity;
      for (const resource of choices(g, p)) {
        const conflict = intervalConflict(g.calendars[resource] || [], start, end);
        if (!conflict) {
          free = resource;
          break;
        }
        earliest = Math.min(earliest, conflict.end - p.offset);
      }
      if (!free) {
        jump = Math.max(jump, earliest);
        break;
      }
      chosen.push(free);
    }
    if (jump !== departure) {
      departure = Math.ceil(jump);
      continue;
    }
    const segments: Segment[] = planned.map((p, i) => ({
      from: p.from,
      to: p.to,
      edgeId: p.edgeId,
      resource: chosen[i],
      start: departure + p.offset,
      end: departure + p.offset + p.duration,
    }));
    const id = g.nextJourney++;
    for (const s of segments) {
      const list = (g.calendars[s.resource] ||= []);
      list.push({ start: s.start, end: s.end + CLEARANCE, trip: id });
      list.sort((a, b) => a.start - b.start || a.trip - b.trip);
    }
    return {
      id,
      kind,
      origin,
      destination,
      departure,
      arrival: departure + offset,
      path,
      segments,
      requestId,
      fare,
    };
  }
  return null;
}
function connectedNodes(g: Game) {
  const set = new Set<string>();
  for (const e of g.edges) {
    set.add(e.from);
    set.add(e.to);
  }
  return set;
}
function connectedBuildings(g: Game) {
  return [...connectedNodes(g)].filter((id) => g.nodes[id].kind !== 'junction');
}
function pendingCustomers(g: Game) {
  return g.pods.flatMap((p) =>
    p.plan?.customer && !p.plan.customer.started ? [p.plan.customer] : [],
  );
}
function hasViableService(g: Game) {
  const homes = Object.values(g.nodes).filter((n) => n.kind === 'residential' && n.portBuilt);
  const work = Object.values(g.nodes).filter(
    (n) => (n.kind === 'office' || n.kind === 'university') && n.portBuilt,
  );
  return homes.some((a) => work.some((b) => !!route(g, a.id, b.id)));
}
function expectedTime(g: Game, a: string, b: string) {
  const p = route(g, a, b);
  if (!p) return Infinity;
  let time = 0;
  for (let i = 0; i + 1 < p.length; i++) time += edgeFor(g, p[i], p[i + 1])!.travelTime;
  return time;
}
function expectedWait(g: Game, routeSeconds: number) {
  const assigned = g.pods.filter((p) => !!p.plan).length;
  const activeRemaining = g.pods.reduce((total, pod) => {
    const journey =
      pod.plan &&
      (pod.plan.empty && g.simTime < pod.plan.empty.arrival ? pod.plan.empty : pod.plan.customer);
    return total + (journey ? Math.max(0, journey.arrival - g.simTime) : 0);
  }, 0);
  return estimateExpectedWait({
    queued: g.requests.length,
    assigned,
    podCount: g.pods.length,
    activeRemainingSeconds: activeRemaining,
    routeSeconds,
    recentServiceSeconds: g.serviceTimes,
    recentWaitSeconds: g.waits,
  });
}
function createDemand(g: Game, burst = false) {
  const pair = burst
    ? { origin: randDemand(g) < 0.5 ? 'u3' : 'n2', destination: 'u4' }
    : chooseDemandPair(Object.values(g.nodes), () => randDemand(g));
  g.totalDemand++;
  g.demandLog.push({ time: g.simTime, from: pair.origin, to: pair.destination });
  if (g.demandLog.length > 160) g.demandLog.shift();
  const travel = expectedTime(g, pair.origin, pair.destination);
  const origin = g.nodes[pair.origin],
    destination = g.nodes[pair.destination];
  const podChoice =
    g.serviceOpen &&
    Number.isFinite(travel) &&
    choosesPod(
      {
        podTravelSeconds: travel,
        expectedWaitSeconds: expectedWait(g, travel),
        fare: g.fare,
        directDistance: Math.hypot(origin.x - destination.x, origin.y - destination.y),
      },
      randMode(g),
      randMode(g),
    );
  if (podChoice && g.requests.length < MAX_QUEUE)
    g.requests.push({
      id: g.nextRequest++,
      ...pair,
      created: g.simTime,
      predicted: travel,
      event: burst,
    });
}
function requestProgress(g: Game) {
  const m = activeMission(g);
  if (!m) return;
  if (m.id === 'open') m.progress = g.serviceOpen ? 1 : 0;
  if (m.id === 'serve15' || m.id === 'serve75') m.progress = Math.min(m.target, g.served);
  if (m.id === 'connected6') m.progress = Math.min(m.target, connectedBuildings(g).length);
  if (m.id === 'canal') m.progress = g.edges.some((e) => e.bridge) ? 1 : 0;
  if (m.id === 'concert') m.progress = Math.min(m.target, g.event.served);
  if (m.progress >= m.target) {
    m.completed = true;
    m.awarded = true;
    g.cash += m.reward;
    addNotice(
      g,
      'success',
      `任务完成 +${m.reward}`,
      `Mission complete +${m.reward}`,
      m.title.zh,
      m.title.en,
    );
  }
}
function updatePods(g: Game) {
  for (const pod of g.pods) {
    const plan = pod.plan;
    if (!plan) {
      pod.status = 'idle';
      continue;
    }
    const empty = plan.empty,
      customer = plan.customer;
    if (empty && g.simTime < empty.arrival) {
      pod.status = g.simTime < empty.departure ? 'waiting' : 'empty';
      continue;
    }
    if (empty && !empty.completed) {
      empty.completed = true;
      pod.at = empty.destination;
      g.emptyTrips++;
      recordJourneyEdges(g, empty);
      const economy = applyJourneyEconomy(
        g.cash,
        g.expenses,
        'empty',
        empty.arrival - empty.departure,
      );
      g.cash = economy.cash;
      g.expenses = economy.expenses;
    }
    if (g.simTime < customer.departure) {
      pod.status = 'waiting';
      continue;
    }
    if (!customer.started) {
      customer.started = true;
      g.startedCustomerTrips++;
      g.waits.push(customer.departure - (customer.requestedAt ?? customer.departure));
      if (g.waits.length > MAX_WAITS) g.waits.shift();
      g.nodes[customer.origin].served++;
      g.nodes[customer.origin].growth = Math.min(5, g.nodes[customer.origin].growth + 0.1);
    }
    if (g.simTime < customer.arrival) {
      pod.status = 'occupied';
      continue;
    }
    if (!customer.completed) {
      customer.completed = true;
      pod.at = customer.destination;
      pod.status = 'idle';
      g.served++;
      recordJourneyEdges(g, customer);
      const economy = applyJourneyEconomy(
        g.cash,
        g.expenses,
        'customer',
        customer.arrival - customer.departure,
        customer.fare || 0,
      );
      g.cash = economy.cash;
      g.expenses = economy.expenses;
      g.revenue += economy.revenue;
      g.serviceTimes.push(customer.arrival - customer.departure);
      if (g.serviceTimes.length > MAX_WAITS) g.serviceTimes.shift();
      recordOutcome(g, 'served');
      if (customer.event && customer.destination === 'u4') g.event.served++;
      g.nodes[customer.destination].served++;
      g.nodes[customer.destination].growth = Math.min(
        5,
        g.nodes[customer.destination].growth + 0.1,
      );
    }
    pod.plan = undefined;
  }
}
function dispatch(g: Game) {
  if (!g.serviceOpen) return;
  for (const pod of g.pods.filter((p) => p.status === 'idle' && !p.plan)) {
    const index = g.requests.findIndex(
      (r) => route(g, pod.at, r.origin) && route(g, r.origin, r.destination),
    );
    if (index < 0) continue;
    const request = g.requests[index];
    const empty =
      pod.at === request.origin ? null : reserve(g, 'empty', pod.at, request.origin, g.simTime);
    if (pod.at !== request.origin && !empty) continue;
    const customer = reserve(
      g,
      'customer',
      request.origin,
      request.destination,
      empty ? empty.arrival : g.simTime,
      request.id,
      g.fare,
    );
    if (!customer) {
      // Passenger and repositioning are one dispatch transaction.
      if (empty)
        for (const s of empty.segments)
          g.calendars[s.resource] = (g.calendars[s.resource] || []).filter(
            (b) => b.trip !== empty.id,
          );
      continue;
    }
    customer.requestedAt = request.created;
    customer.event = request.event;
    if (customer.departure - request.created > MAX_WAIT) {
      for (const journey of [empty, customer])
        if (journey)
          for (const s of journey.segments)
            g.calendars[s.resource] = (g.calendars[s.resource] || []).filter(
              (b) => b.trip !== journey.id,
            );
      continue;
    }
    g.requests.splice(index, 1);
    pod.plan = { empty, customer, requestId: request.id };
    pod.status = empty ? 'empty' : 'waiting';
  }
}
function position(g: Game, pod: Pod) {
  const journey =
    pod.plan &&
    (pod.plan.empty && g.simTime < pod.plan.empty.arrival ? pod.plan.empty : pod.plan.customer);
  if (!journey || g.simTime < journey.departure) {
    const n = g.nodes[pod.at];
    return { x: n.portX, y: n.portY, at: pod.at, destination: journey?.destination };
  }
  const moving = journey.segments.find(
    (s) => s.start <= g.simTime && g.simTime < s.end && s.from !== s.to,
  );
  if (moving) {
    const a = g.nodes[moving.from],
      b = g.nodes[moving.to],
      ratio = (g.simTime - moving.start) / (moving.end - moving.start);
    return {
      x: a.portX + (b.portX - a.portX) * ratio,
      y: a.portY + (b.portY - a.portY) * ratio,
      at: moving.from,
      destination: journey.destination,
    };
  }
  const at =
    journey.path
      .slice()
      .reverse()
      .find(
        (id) =>
          journey.segments.find(
            (s) => s.from === id && s.start <= g.simTime && g.simTime < s.end,
          ) || g.simTime >= journey.arrival,
      ) || pod.at;
  const n = g.nodes[at];
  return { x: n.portX, y: n.portY, at, destination: journey.destination };
}
function edgeHasCommittedTraffic(g: Game, id: string) {
  return (
    Object.entries(g.calendars).some(
      ([key, bookings]) => key.startsWith(`edge:${id}:`) && bookings.some((b) => b.end > g.simTime),
    ) ||
    g.pods.some((p) =>
      [p.plan?.empty, p.plan?.customer].some((j) =>
        j?.segments.some((s) => s.edgeId === id && s.end + CLEARANCE > g.simTime),
      ),
    )
  );
}
function recordOutcome(g: Game, kind: 'served' | 'abandoned') {
  g.outcomes.push({ time: g.simTime, kind });
  while (g.outcomes.length > MAX_WAITS || g.outcomes[0].time < g.simTime - 600) g.outcomes.shift();
}
function recordJourneyEdges(g: Game, journey: Journey) {
  for (const segment of journey.segments)
    if (segment.edgeId) {
      const edge = g.edges.find((candidate) => candidate.id === segment.edgeId);
      if (edge) edge.trips++;
    }
}
function abandonRequest(g: Game, index: number) {
  g.requests.splice(index, 1);
  g.abandoned++;
  recordOutcome(g, 'abandoned');
}
function abandonUnreachable(g: Game) {
  for (let i = g.requests.length - 1; i >= 0; i--)
    if (!route(g, g.requests[i].origin, g.requests[i].destination)) abandonRequest(g, i);
}
/** Applies the pure track plan once, so legacy two-node builds follow drawing rules too. */
function applyTrackPlan(g: Game, points: import('../shared/types').TrackPoint[]): CommandResult {
  const snapshot = getSnapshot(g);
  const plan = planTrack(snapshot.nodes, snapshot.edges, points);
  if (plan.ok === false) return { ok: false, message: plan.message };
  if (plan.removeEdgeIds.some((id) => edgeHasCommittedTraffic(g, id)))
    return fail(
      '请暂停派单并等待已预约车辆通过后再编辑轨道。',
      'Wait for booked vehicles to clear before editing this track.',
    );
  if (g.cash < plan.cost)
    return fail('资金不足，无法铺设轨道。', 'Insufficient cash to lay this track.');
  if (
    plan.addNodes.some((n) => nodeId(g, n.id)) ||
    plan.addEdges.some((e) =>
      g.edges.some((old) => old.id === e.id && !plan.removeEdgeIds.includes(old.id)),
    )
  )
    return fail('轨道计划与现有网络冲突。', 'The track plan conflicts with the current network.');
  g.edges = g.edges.filter((e) => !plan.removeEdgeIds.includes(e.id));
  for (const n of plan.addNodes)
    g.nodes[n.id] = {
      ...n,
      portBuilt: true,
      portX: n.x,
      portY: n.y,
      portLevel: 1,
      served: 0,
      growth: 0,
    };
  g.edges.push(...plan.addEdges);
  g.cash -= plan.cost;
  g.expenses += plan.cost;
  abandonUnreachable(g);
  addNotice(g, 'success', '轨道已铺设', 'Track laid');
  return ok();
}
function tick(g: Game) {
  g.simTime++;
  updatePods(g);
  if (g.event.active && g.simTime >= g.event.endsAt) {
    g.event.active = false;
    g.event.nextAt = g.simTime + 420;
    addNotice(g, 'info', '活动结束', 'Event ended');
  }
  if (g.simTime % 5 === 0) createDemand(g);
  if (g.event.active && g.simTime % 3 === 0) createDemand(g, true);
  for (let i = g.requests.length - 1; i >= 0; i--)
    if (g.simTime - g.requests[i].created > MAX_WAIT) abandonRequest(g, i);
  dispatch(g);
  requestProgress(g);
  if (g.simTime % 60 === 0)
    for (const key of Object.keys(g.calendars)) {
      const retained = g.calendars[key].filter((b) => b.end >= g.simTime - 2);
      if (retained.length) g.calendars[key] = retained;
      else delete g.calendars[key];
    }
  if (g.simTime % 20 === 0) {
    g.history.push({
      time: g.simTime,
      served: g.served,
      waiting: g.requests.length,
      share: g.totalDemand ? g.startedCustomerTrips / g.totalDemand : 0,
    });
    if (g.history.length > MAX_HISTORY) g.history.shift();
  }
}

export function advanceGame(game: Game, seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 36000)
    throw new Error('seconds must be an integer between 0 and 36000');
  if (!game.running) return;
  for (let i = 0; i < seconds; i++) tick(game);
  game.revision++;
}

export function applyCommand(g: Game, command: Command): CommandResult {
  let result: CommandResult;
  switch (command?.type) {
    case 'addPort': {
      const n = nodeId(g, command.nodeId) ? g.nodes[command.nodeId] : undefined;
      const offset: Record<PortSide, [number, number]> = {
        north: [0, -24],
        east: [24, 0],
        south: [0, 24],
        west: [-24, 0],
      };
      if (!n || n.kind === 'junction' || n.portBuilt || !Object.hasOwn(offset, command.side))
        result = fail('该建筑不能建设接入口。', 'This building cannot receive a port.');
      else if (g.cash < ECONOMY.portCost)
        result = fail('资金不足，无法建设接入口。', 'Insufficient cash to build a port.');
      else {
        const [dx, dy] = offset[command.side];
        n.portBuilt = true;
        n.portX = n.x + dx;
        n.portY = n.y + dy;
        g.cash -= ECONOMY.portCost;
        g.expenses += ECONOMY.portCost;
        addNotice(g, 'success', '楼宇已接入', 'Port built', n.name.zh, n.name.en);
        result = ok();
      }
      break;
    }
    case 'addJunction': {
      const x = command.x,
        y = command.y;
      const valid =
        finite(x) &&
        finite(y) &&
        x >= 40 &&
        x <= WORLD.width - 40 &&
        y >= 40 &&
        y <= WORLD.height - 40 &&
        !(x >= 770 && x <= 900) &&
        Object.values(g.nodes).every((n) => Math.hypot(n.x - x, n.y - y) >= 45);
      if (!valid)
        result = fail(
          '枢纽位置无效或过于靠近建筑/运河。',
          'Junction position is invalid or too close to a building/canal.',
        );
      else if (g.cash < ECONOMY.junctionCost)
        result = fail('资金不足，无法建设枢纽。', 'Insufficient cash to build a junction.');
      else {
        const id = `j${
          Math.max(
            0,
            ...Object.values(g.nodes)
              .filter((n) => n.kind === 'junction')
              .map((n) => Number(n.id.slice(1)) || 0),
          ) + 1
        }`;
        const district = x > 900 ? 'campus' : y < 540 ? 'north' : 'central';
        g.nodes[id] = {
          id,
          name: L(`自建枢纽 ${id.slice(1)}`, `Junction ${id.slice(1)}`),
          x: Math.round(x),
          y: Math.round(y),
          portX: Math.round(x),
          portY: Math.round(y),
          kind: 'junction',
          district,
          population: 0,
          portBuilt: true,
          portLevel: 1,
          served: 0,
          growth: 0,
        };
        g.cash -= ECONOMY.junctionCost;
        g.expenses += ECONOMY.junctionCost;
        addNotice(g, 'success', '枢纽已建成', 'Junction built');
        result = ok();
      }
      break;
    }
    case 'drawTrack':
      result = applyTrackPlan(g, command.points);
      break;
    case 'build': {
      const a = nodeId(g, command.from) ? g.nodes[command.from] : undefined,
        b = nodeId(g, command.to) ? g.nodes[command.to] : undefined;
      if (!a || !b || !a.portBuilt || !b.portBuilt)
        result = fail('请先在两端建好接入口。', 'Build ports at both endpoints first.');
      else
        result = applyTrackPlan(g, [
          { ...point(g, a.id), nodeId: a.id },
          { ...point(g, b.id), nodeId: b.id },
        ]);
      break;
    }
    case 'removeEdge': {
      const edge = g.edges.find((e) => e.id === command.edgeId);
      if (!edge) result = fail('线路不存在。', 'Connection does not exist.');
      else if (edgeHasCommittedTraffic(g, edge.id))
        result = fail(
          '请暂停派单并等待已预约车辆通过后再拆除。',
          'Wait for booked vehicles to clear before removing this track.',
        );
      else {
        g.edges = g.edges.filter((e) => e.id !== edge.id);
        g.cash += Math.round(edge.cost * 0.4);
        g.expenses -= Math.round(edge.cost * 0.4);
        abandonUnreachable(g);
        addNotice(g, 'info', '线路已拆除', 'Track removed');
        result = ok();
      }
      break;
    }
    case 'upgradePort':
      if (!nodeId(g, command.nodeId) || !g.nodes[command.nodeId].portBuilt)
        result = fail('请先建设接入口。', 'Build a port first.');
      else if (g.nodes[command.nodeId].portLevel >= 3)
        result = fail('接入口已达到最高等级。', 'Port is already at maximum level.');
      else if (g.cash < ECONOMY.portUpgradeCost)
        result = fail('资金不足，无法升级。', 'Insufficient cash to upgrade.');
      else {
        g.cash -= ECONOMY.portUpgradeCost;
        g.expenses += ECONOMY.portUpgradeCost;
        g.nodes[command.nodeId].portLevel++;
        addNotice(g, 'success', '接入口容量提升', 'Port capacity improved');
        result = ok();
      }
      break;
    case 'upgradeEdge': {
      const edge = g.edges.find((e) => e.id === command.edgeId);
      if (!edge) result = fail('线路不存在。', 'Connection does not exist.');
      else if (edge.level >= 3)
        result = fail('线路已达到最高等级。', 'Connection is already at maximum level.');
      else if (g.cash < ECONOMY.edgeUpgradeCost)
        result = fail('资金不足，无法升级。', 'Insufficient cash to upgrade.');
      else {
        g.cash -= ECONOMY.edgeUpgradeCost;
        g.expenses += ECONOMY.edgeUpgradeCost;
        edge.level++;
        addNotice(g, 'success', '线路新增一条物理车道', 'Connection gained a physical lane');
        result = ok();
      }
      break;
    }
    case 'buyPods':
      if (
        !nodeId(g, command.nodeId) ||
        !g.nodes[command.nodeId].portBuilt ||
        g.nodes[command.nodeId].kind === 'junction' ||
        !Number.isInteger(command.count) ||
        command.count < 1 ||
        command.count > 12 ||
        g.pods.length + command.count > 48
      )
        result = fail('购买数量或地点无效。', 'Invalid pod quantity or location.');
      else if (g.cash < ECONOMY.podCost * command.count)
        result = fail('资金不足，无法购车。', 'Insufficient cash to buy pods.');
      else {
        g.cash -= ECONOMY.podCost * command.count;
        g.expenses += ECONOMY.podCost * command.count;
        let id = Math.max(0, ...g.pods.map((p) => p.id));
        for (let i = 0; i < command.count; i++)
          g.pods.push({ id: ++id, home: command.nodeId, at: command.nodeId, status: 'idle' });
        result = ok();
      }
      break;
    case 'setFare':
      if (!finite(command.value) || command.value < 1 || command.value > 30)
        result = fail('票价必须在 1 到 30 之间。', 'Fare must be between 1 and 30.');
      else {
        g.fare = Math.round(command.value * 100) / 100;
        result = ok();
      }
      break;
    case 'setRunning':
      g.running = !!command.value;
      result = ok();
      break;
    case 'setSpeed':
      if (command.value !== 1 && command.value !== 3 && command.value !== 8)
        result = fail('无效速度。', 'Invalid speed.');
      else {
        g.speed = command.value;
        result = ok();
      }
      break;
    case 'openService':
      if (g.serviceOpen) result = fail('服务已经启用。', 'Service is already open.');
      else if (!hasViableService(g))
        result = fail(
          '先连接一个住区与办公区或大学区。',
          'First connect a home to an office or university.',
        );
      else {
        g.serviceOpen = true;
        g.running = true;
        addNotice(
          g,
          'success',
          '服务已启用',
          'Service opened',
          '乘客需求与旧交通方式将开始竞争。',
          'Passenger demand will now compete with other modes.',
        );
        requestProgress(g);
        result = ok();
      }
      break;
    case 'closeService': {
      if (!g.serviceOpen) result = fail('服务已经暂停接单。', 'Service is already paused.');
      else {
        g.serviceOpen = false;
        while (g.requests.length) abandonRequest(g, g.requests.length - 1);
        const message = L(
          '暂停接单，已预约行程继续完成',
          'New orders paused; booked journeys continue',
        );
        addNotice(g, 'info', message.zh, message.en);
        result = { ok: true, message };
      }
      break;
    }
    case 'startEvent':
      if (!g.serviceOpen) result = fail('请先启用服务。', 'Open service first.');
      else if (g.event.active) result = fail('活动正在进行。', 'An event is already active.');
      else if (g.simTime < g.event.nextAt)
        result = fail('活动还在筹备中。', 'The event is still being prepared.');
      else {
        g.event.active = true;
        g.event.endsAt = g.simTime + 90;
        g.event.fired++;
        addNotice(
          g,
          'success',
          '音乐会开始',
          'Concert started',
          '体育场周边将出现客流高峰。',
          'Arena demand is surging.',
        );
        requestProgress(g);
        result = ok();
      }
      break;
    default:
      result = fail('未知指令。', 'Unknown command.');
  }
  if (result.ok) {
    requestProgress(g);
    g.revision++;
  }
  return result;
}

function snapshotMissions(g: Game) {
  return g.missions.map((m) => ({
    id: m.id,
    title: { ...m.title },
    description: { ...m.description },
    progress: m.progress,
    target: m.target,
    reward: m.reward,
    completed: m.completed,
  }));
}
export function getSnapshot(g: Game): Snapshot {
  const connected = connectedNodes(g);
  const pending = pendingCustomers(g);
  const waits = [...g.waits].sort((a, b) => a - b);
  const mean = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  const recentOutcomes = g.outcomes.filter((outcome) => outcome.time >= g.simTime - 300);
  const recentAbandoned = recentOutcomes.filter((outcome) => outcome.kind === 'abandoned').length;
  const recentFailureRate = recentOutcomes.length ? recentAbandoned / recentOutcomes.length : 0;
  const flowMap = new Map<string, { from: string; to: string; demand: number; waiting: number }>();
  for (const entry of g.demandLog)
    if (entry.time > g.simTime - 300) {
      const key = `${entry.from}/${entry.to}`;
      const flow = flowMap.get(key) || { from: entry.from, to: entry.to, demand: 0, waiting: 0 };
      flow.demand++;
      flowMap.set(key, flow);
    }
  for (const request of g.requests) {
    const flow = flowMap.get(`${request.origin}/${request.destination}`) || {
      from: request.origin,
      to: request.destination,
      demand: 0,
      waiting: 0,
    };
    flow.waiting++;
    flowMap.set(`${request.origin}/${request.destination}`, flow);
  }
  for (const pod of g.pods) {
    const customer = pod.plan?.customer;
    if (customer && !customer.started) {
      const key = `${customer.origin}/${customer.destination}`;
      const flow = flowMap.get(key) || {
        from: customer.origin,
        to: customer.destination,
        demand: 0,
        waiting: 0,
      };
      flow.waiting++;
      flowMap.set(key, flow);
    }
  }
  const demandFlows = [...flowMap.values()]
    .sort((a, b) => b.demand - a.demand || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, 16);
  const metrics: Metrics = {
    served: g.served,
    waiting: g.requests.length + pending.length,
    abandoned: g.abandoned,
    totalDemand: g.totalDemand,
    marketShare: g.totalDemand ? g.startedCustomerTrips / g.totalDemand : 0,
    averageWait: Math.round(mean * 10) / 10,
    p95Wait: waits.length ? waits[Math.ceil(waits.length * 0.95) - 1] : 0,
    revenue: Math.round(g.revenue * 100) / 100,
    expenses: Math.round(g.expenses * 100) / 100,
    emptyTrips: g.emptyTrips,
    satisfaction: Math.max(0, Math.min(100, Math.round(94 - mean * 0.28 - recentFailureRate * 45))),
    connectedBuildings: connectedBuildings(g).length,
  };
  const edges: EdgeView[] = g.edges.map((e) => {
    const resources = Array.from(
      { length: e.level },
      (_, i) => g.calendars[`edge:${e.id}:lane:${i}`] || [],
    );
    const active = resources.reduce(
      (n, list) =>
        n + list.filter((x) => x.start <= g.simTime && g.simTime < x.end - CLEARANCE).length,
      0,
    );
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      length: e.length,
      cost: e.cost,
      travelTime: e.travelTime,
      level: e.level,
      utilization: Math.min(1, active / e.level),
      trips: e.trips,
    };
  });
  return {
    version: 1,
    revision: g.revision,
    simTime: g.simTime,
    running: g.running,
    speed: g.speed,
    cash: Math.round(g.cash * 100) / 100,
    fare: g.fare,
    serviceOpen: g.serviceOpen,
    nodes: Object.values(g.nodes)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => ({
        id: n.id,
        name: { ...n.name },
        x: n.x,
        y: n.y,
        kind: n.kind,
        district: n.district,
        population: n.population,
        portBuilt: n.portBuilt,
        portX: n.portX,
        portY: n.portY,
        queue:
          g.requests.filter((r) => r.origin === n.id).length +
          pending.filter((r) => r.origin === n.id).length,
        served: n.served,
        portLevel: n.portLevel,
        connected: connected.has(n.id),
        growth: Math.round(n.growth * 10) / 10,
      })),
    edges,
    pods: g.pods.map((p) => {
      const q = position(g, p);
      const target = q.destination && g.nodes[q.destination];
      const angle = target ? Math.atan2(target.portY - q.y, target.portX - q.x) : 0;
      return {
        id: p.id,
        x: q.x,
        y: q.y,
        angle,
        status: p.status,
        at: q.at,
        destination: q.destination,
      };
    }),
    metrics,
    missions: snapshotMissions(g),
    notices: g.notices.map((n) => ({ ...n, title: { ...n.title }, text: { ...n.text } })),
    history: g.history.map((h) => ({ ...h })),
    cityEvent: {
      active: g.event.active,
      remaining: g.event.active ? Math.max(0, g.event.endsAt - g.simTime) : 0,
      nextIn: g.event.active ? 0 : Math.max(0, g.event.nextAt - g.simTime),
      title: L('湾畔音乐会', 'Bayfront Concert'),
      description: L('活动期间体育场客流明显上升。', 'Arena demand rises during the event.'),
    },
    demandFlows,
  };
}

/** Lightweight independent calendar check for integration tests and developer tools. */
export function auditGame(g: Game): { ok: boolean; conflicts: number; invalidBookings: number } {
  let conflicts = 0,
    invalidBookings = 0;
  for (const entries of Object.values(g.calendars)) {
    const ordered = [...entries].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < ordered.length; i++) {
      const current = ordered[i];
      if (
        !Number.isInteger(current.start) ||
        !Number.isInteger(current.end) ||
        current.end <= current.start
      )
        invalidBookings++;
      if (i && current.start < ordered[i - 1].end) conflicts++;
    }
  }
  return { ok: conflicts === 0 && invalidBookings === 0, conflicts, invalidBookings };
}

function validResource(g: Game, resource: string) {
  const node = /^node:([^:]+):port:([0-2])$/.exec(resource);
  if (node) return nodeId(g, node[1]) && Number(node[2]) < g.nodes[node[1]].portLevel;
  const edge = /^edge:(e:[^:]+):lane:([0-2])$/.exec(resource);
  if (edge) {
    const found = g.edges.find((e) => e.id === edge[1]);
    return !!found && Number(edge[2]) < found.level;
  }
  return false;
}
function validJourney(g: Game, v: unknown): v is Journey {
  if (!v || typeof v !== 'object') return false;
  const x = v as Journey;
  if (
    !Number.isInteger(x.id) ||
    x.id < 1 ||
    (x.kind !== 'empty' && x.kind !== 'customer') ||
    !nodeId(g, x.origin) ||
    !nodeId(g, x.destination) ||
    !Number.isInteger(x.departure) ||
    !Number.isInteger(x.arrival) ||
    x.arrival <= x.departure ||
    !Array.isArray(x.path) ||
    !Array.isArray(x.segments) ||
    x.path.length < 2 ||
    x.segments.length !== x.path.length * 2 - 1 ||
    x.path[0] !== x.origin ||
    x.path.at(-1) !== x.destination
  )
    return false;
  let time = x.departure;
  for (let i = 0; i < x.path.length; i++) {
    if (!nodeId(g, x.path[i])) return false;
    const nodeSegment = x.segments[i * 2];
    if (
      !nodeSegment ||
      nodeSegment.from !== x.path[i] ||
      nodeSegment.to !== x.path[i] ||
      nodeSegment.start !== time ||
      nodeSegment.end !== time + 1 ||
      !validResource(g, nodeSegment.resource)
    )
      return false;
    time++;
    if (i + 1 < x.path.length) {
      const segment = x.segments[i * 2 + 1];
      const edge = edgeFor(g, x.path[i], x.path[i + 1]);
      if (
        !segment ||
        !edge ||
        segment.from !== x.path[i] ||
        segment.to !== x.path[i + 1] ||
        segment.edgeId !== edge.id ||
        segment.start !== time ||
        segment.end !== time + edge.travelTime ||
        !validResource(g, segment.resource)
      )
        return false;
      time += edge.travelTime;
    }
  }
  return (
    time === x.arrival &&
    (x.fare === undefined || finite(x.fare)) &&
    (x.event === undefined || typeof x.event === 'boolean')
  );
}
function validate(g: Game) {
  if (
    !g ||
    g.saveVersion !== SAVE_VERSION ||
    !Number.isInteger(g.simTime) ||
    g.simTime < 0 ||
    !Number.isInteger(g.rng) ||
    !Number.isInteger(g.demandRng) ||
    !Number.isInteger(g.modeRng) ||
    typeof g.running !== 'boolean' ||
    typeof g.serviceOpen !== 'boolean' ||
    (g.speed !== 1 && g.speed !== 3 && g.speed !== 8) ||
    !finite(g.cash) ||
    !finite(g.fare) ||
    g.fare < 1 ||
    g.fare > 30 ||
    !Array.isArray(g.edges) ||
    !Array.isArray(g.pods) ||
    !Array.isArray(g.requests) ||
    !Array.isArray(g.demandLog) ||
    !g.nodes ||
    !g.calendars
  )
    throw new Error('Invalid FutureTransit save');
  if (
    g.edges.length > 120 ||
    g.pods.length > 48 ||
    g.requests.length > MAX_QUEUE ||
    g.demandLog.length > 160 ||
    Object.values(g.calendars).some((v) => !Array.isArray(v)) ||
    Object.values(g.calendars).reduce((n, v) => n + v.length, 0) > MAX_BOOKINGS
  )
    throw new Error('Save exceeds simulation limits');
  for (const value of [
    g.revision,
    g.nextRequest,
    g.nextJourney,
    g.nextNotice,
    g.served,
    g.startedCustomerTrips,
    g.abandoned,
    g.totalDemand,
    g.emptyTrips,
  ])
    if (!Number.isInteger(value) || value < 0) throw new Error('Invalid simulation counter');
  if (
    g.served > g.startedCustomerTrips ||
    g.startedCustomerTrips > g.totalDemand ||
    g.abandoned > g.totalDemand
  )
    throw new Error('Invalid simulation counter');
  if (Object.keys(g.nodes).length < CITY_NODES.length || CITY_NODES.some((n) => !nodeId(g, n.id)))
    throw new Error('Invalid node state');
  for (const n of CITY_NODES)
    if (
      !g.nodes[n.id] ||
      !Number.isInteger(g.nodes[n.id].portLevel) ||
      g.nodes[n.id].portLevel < 1 ||
      g.nodes[n.id].portLevel > 3 ||
      !Number.isInteger(g.nodes[n.id].served) ||
      g.nodes[n.id].served < 0 ||
      !finite(g.nodes[n.id].growth)
    )
      throw new Error('Invalid node state');
  for (const [id, n] of Object.entries(g.nodes)) {
    const base = CITY_NODES.find((city) => city.id === id);
    if (
      !n ||
      !n.name ||
      typeof n.name.zh !== 'string' ||
      typeof n.name.en !== 'string' ||
      typeof n.portBuilt !== 'boolean' ||
      !finite(n.x) ||
      !finite(n.y) ||
      !finite(n.portX) ||
      !finite(n.portY) ||
      !Number.isInteger(n.portLevel) ||
      n.portLevel < 1 ||
      n.portLevel > 3 ||
      !Number.isInteger(n.served) ||
      n.served < 0 ||
      !finite(n.growth)
    )
      throw new Error('Invalid node state');
    if (base) {
      const side = [
        [0, 0],
        [0, -24],
        [24, 0],
        [0, 24],
        [-24, 0],
      ].some(([dx, dy]) => n.portX === base.x + dx && n.portY === base.y + dy);
      if (
        n.kind !== base.kind ||
        n.x !== base.x ||
        n.y !== base.y ||
        n.district !== base.district ||
        n.population !== base.population ||
        !side ||
        (!n.portBuilt && (n.portX !== base.x || n.portY !== base.y))
      )
        throw new Error('Invalid building state');
    }
    const suffix = Number(id.slice(1));
    if (
      !base &&
      (!/^j[1-9]\d*$/.test(id) ||
        !Number.isSafeInteger(suffix) ||
        n.id !== id ||
        n.kind !== 'junction' ||
        !n.portBuilt ||
        n.portX !== n.x ||
        n.portY !== n.y ||
        n.x < 40 ||
        n.x > WORLD.width - 40 ||
        n.y < 40 ||
        n.y > WORLD.height - 40 ||
        (n.x >= 770 && n.x <= 900) ||
        CITY_NODES.some((city) => Math.hypot(city.x - n.x, city.y - n.y) < 40))
    )
      throw new Error('Invalid junction state');
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (
      !nodeId(g, e.from) ||
      !nodeId(g, e.to) ||
      !g.nodes[e.from].portBuilt ||
      !g.nodes[e.to].portBuilt ||
      e.from === e.to ||
      e.id !== edgeId(e.from, e.to) ||
      edgeIds.has(e.id) ||
      !Number.isInteger(e.level) ||
      e.level < 1 ||
      e.level > 3 ||
      !finite(e.length) ||
      !finite(e.cost) ||
      !Number.isInteger(e.travelTime) ||
      e.travelTime < 1 ||
      !Number.isInteger(e.trips) ||
      e.trips < 0
    )
      throw new Error('Invalid edge state');
    edgeIds.add(e.id);
  }
  const podIds = new Set<number>(),
    journeyIds = new Set<number>();
  for (const p of g.pods) {
    if (
      !Number.isInteger(p.id) ||
      p.id < 1 ||
      podIds.has(p.id) ||
      !nodeId(g, p.home) ||
      !nodeId(g, p.at) ||
      !['idle', 'waiting', 'empty', 'occupied'].includes(p.status)
    )
      throw new Error('Invalid pod state');
    podIds.add(p.id);
    if (p.plan) {
      if (
        !validJourney(g, p.plan.customer) ||
        (p.plan.empty && !validJourney(g, p.plan.empty)) ||
        journeyIds.has(p.plan.customer.id)
      )
        throw new Error('Invalid pod journey');
      journeyIds.add(p.plan.customer.id);
      if (p.plan.empty) {
        if (
          journeyIds.has(p.plan.empty.id) ||
          p.plan.empty.destination !== p.plan.customer.origin ||
          p.plan.empty.arrival > p.plan.customer.departure
        )
          throw new Error('Invalid pod journey');
        journeyIds.add(p.plan.empty.id);
      }
    }
  }
  if (journeyIds.size && g.nextJourney <= Math.max(...journeyIds))
    throw new Error('Invalid simulation counter');
  const requestIds = new Set<number>();
  for (const r of g.requests)
    if (
      !Number.isInteger(r.id) ||
      r.id < 1 ||
      requestIds.has(r.id) ||
      !nodeId(g, r.origin) ||
      !nodeId(g, r.destination) ||
      r.origin === r.destination ||
      !Number.isInteger(r.created) ||
      r.created < 0 ||
      !finite(r.predicted) ||
      (r.event !== undefined && typeof r.event !== 'boolean')
    )
      throw new Error('Invalid request state');
    else requestIds.add(r.id);
  for (const [resource, bookings] of Object.entries(g.calendars)) {
    if (!validResource(g, resource)) throw new Error('Invalid calendar resource');
    for (const b of bookings)
      if (
        !Number.isInteger(b.start) ||
        !Number.isInteger(b.end) ||
        b.end <= b.start ||
        !Number.isInteger(b.trip) ||
        b.trip < 1
      )
        throw new Error('Invalid booking');
  }
  const expectedBookings = new Map<string, number>();
  for (const pod of g.pods)
    for (const journey of [pod.plan?.empty, pod.plan?.customer])
      if (journey)
        for (const segment of journey.segments) {
          const end = segment.end + CLEARANCE;
          if (segment.end > g.simTime) {
            const key = `${segment.resource}|${segment.start}|${end}|${journey.id}`;
            expectedBookings.set(key, (expectedBookings.get(key) || 0) + 1);
          }
        }
  const actualBookings = new Map<string, number>();
  for (const [resource, bookings] of Object.entries(g.calendars))
    for (const booking of bookings)
      if (booking.end - CLEARANCE > g.simTime) {
        const key = `${resource}|${booking.start}|${booking.end}|${booking.trip}`;
        actualBookings.set(key, (actualBookings.get(key) || 0) + 1);
      }
  if (
    expectedBookings.size !== actualBookings.size ||
    [...expectedBookings].some(([key, count]) => actualBookings.get(key) !== count)
  )
    throw new Error('Invalid active booking state');
  const localized = (v: unknown): v is Localized =>
    !!v &&
    typeof v === 'object' &&
    typeof (v as Localized).zh === 'string' &&
    typeof (v as Localized).en === 'string';
  if (
    !auditGame(g).ok ||
    !Array.isArray(g.waits) ||
    g.waits.length > MAX_WAITS ||
    g.waits.some((v) => !finite(v) || v < 0) ||
    !Array.isArray(g.serviceTimes) ||
    g.serviceTimes.length > MAX_WAITS ||
    g.serviceTimes.some((v) => !finite(v) || v < 0) ||
    !Array.isArray(g.outcomes) ||
    g.outcomes.length > MAX_WAITS ||
    g.outcomes.some(
      (v) =>
        !Number.isInteger(v.time) || v.time < 0 || (v.kind !== 'served' && v.kind !== 'abandoned'),
    ) ||
    !Array.isArray(g.history) ||
    g.history.length > MAX_HISTORY ||
    g.history.some(
      (h) =>
        !Number.isInteger(h.time) ||
        !Number.isInteger(h.served) ||
        !Number.isInteger(h.waiting) ||
        !finite(h.share),
    ) ||
    !Array.isArray(g.notices) ||
    g.notices.length > MAX_NOTICES ||
    g.notices.some(
      (n) =>
        !Number.isInteger(n.id) ||
        !Number.isInteger(n.time) ||
        !['info', 'success', 'warning'].includes(n.tone) ||
        !localized(n.title) ||
        !localized(n.text),
    ) ||
    !Array.isArray(g.missions) ||
    g.missions.length !== 6 ||
    g.missions.some(
      (m, i) =>
        m.id !== missions()[i].id ||
        !localized(m.title) ||
        !localized(m.description) ||
        !Number.isInteger(m.progress) ||
        !Number.isInteger(m.target) ||
        !finite(m.reward) ||
        typeof m.completed !== 'boolean' ||
        typeof m.awarded !== 'boolean',
    ) ||
    !g.event ||
    typeof g.event.active !== 'boolean' ||
    !Number.isInteger(g.event.endsAt) ||
    g.event.endsAt < 0 ||
    !Number.isInteger(g.event.nextAt) ||
    g.event.nextAt < 0 ||
    !Number.isInteger(g.event.fired) ||
    g.event.fired < 0 ||
    !Number.isInteger(g.event.served) ||
    g.event.served < 0
  )
    throw new Error('Invalid simulation state');
  for (const flow of g.demandLog)
    if (!Number.isInteger(flow.time) || !nodeId(g, flow.from) || !nodeId(g, flow.to))
      throw new Error('Invalid demand state');
}
export function serializeGame(g: Game): string {
  validate(g);
  return JSON.stringify(g);
}
export function deserializeGame(data: string): Game {
  if (typeof data !== 'string' || data.length > 1_500_000)
    throw new Error('Invalid FutureTransit save');
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error('Invalid FutureTransit save');
  }
  try {
    validate(parsed as Game);
  } catch {
    throw new Error('Invalid FutureTransit save');
  }
  return parsed as Game;
}
