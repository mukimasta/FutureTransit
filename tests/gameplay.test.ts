import { describe, expect, it } from 'vitest';
import {
  createGame,
  applyCommand,
  advanceGame,
  getSnapshot,
  serializeGame,
  deserializeGame,
  type Game,
} from '../src/simulation';
import { CITY_NODES, NODE_BY_ID } from '../src/scenarios/city';
import type { Command } from '../src/shared/types';

function command(game: Game, value: Command) {
  const result = applyCommand(game, value);
  expect(result.ok, `${JSON.stringify(value)}: ${result.message?.en}`).toBe(true);
}
function track(game: Game, from: string, to: string, waypoints: { x: number; y: number }[] = []) {
  command(game, {
    type: 'drawTrack',
    points: [
      { x: game.nodes[from].portX, y: game.nodes[from].portY, nodeId: from },
      ...waypoints,
      { x: game.nodes[to].portX, y: game.nodes[to].portY, nodeId: to },
    ],
  });
}
function starter(game: Game) {
  command(game, { type: 'addPort', nodeId: 'n1', side: 'south' });
  command(game, { type: 'addPort', nodeId: 'c1', side: 'north' });
  command(game, { type: 'build', from: 'n1', to: 'c1' });
  command(game, { type: 'openService' });
}

describe('Demo integration and independently observed trajectories', () => {
  it('the suggested first route starts itself and earns meaningful first progress', () => {
    const game = createGame();
    starter(game);
    expect(getSnapshot(game).running).toBe(true);
    advanceGame(game, 600);
    const s = getSnapshot(game);
    expect(s.metrics.served).toBeGreaterThanOrEqual(10);
    expect(s.metrics.revenue).toBeGreaterThan(0);
    expect(s.metrics.emptyTrips).toBeGreaterThan(0);
    expect(s.metrics.marketShare).toBeGreaterThan(0);
    expect(s.metrics.marketShare).toBeLessThanOrEqual(1);
    expect(s.missions[0].completed).toBe(true);
  });

  it('city OD is identical with or without a network for the same seed and elapsed time', () => {
    const a = createGame(19),
      b = createGame(19);
    command(a, { type: 'setRunning', value: true });
    command(b, { type: 'addPort', nodeId: 'n1', side: 'south' });
    command(b, { type: 'addPort', nodeId: 'c1', side: 'north' });
    command(b, { type: 'build', from: 'n1', to: 'c1' });
    command(b, { type: 'setRunning', value: true });
    advanceGame(a, 240);
    advanceGame(b, 240);
    expect(getSnapshot(a).metrics.totalDemand).toBeGreaterThan(0);
    expect(getSnapshot(a).demandFlows).toEqual(getSnapshot(b).demandFlows);
  });

  it('save/load continues identically during occupied and empty journeys', () => {
    const original = createGame();
    starter(original);
    advanceGame(original, 95);
    const loaded = deserializeGame(serializeGame(original));
    advanceGame(original, 500);
    advanceGame(loaded, 500);
    expect(getSnapshot(loaded)).toEqual(getSnapshot(original));
  });

  it('every observed occupied/empty trajectory is continuous and never shares an occupied resource', () => {
    const game = createGame(42);
    game.cash = 100000;
    for (const node of CITY_NODES)
      command(game, { type: 'addPort', nodeId: node.id, side: 'east' });
    for (const [x, y] of [
      [445, 440],
      [740, 610],
      [1080, 740],
    ])
      command(game, { type: 'addJunction', x, y });
    const links = [
      ['n1', 'j1'],
      ['n2', 'j1'],
      ['n3', 'j2'],
      ['n4', 'j1'],
      ['j1', 'c1'],
      ['j1', 'j2'],
      ['j2', 'c2'],
      ['j2', 'c4'],
      ['j1', 'c3'],
      ['j2', 'j3'],
      ['j3', 'u1'],
      ['u3', 'j3'],
      ['u2', 'j3'],
      ['j3', 'u4'],
    ];
    for (const [from, to] of links)
      track(
        game,
        from,
        to,
        from === 'n1' && to === 'j1'
          ? [
              { x: 380, y: 285 },
              { x: 470, y: 440 },
            ]
          : from === 'j2' && to === 'j3'
            ? [{ x: 740, y: 850 }]
            : [],
      );
    command(game, { type: 'buyPods', nodeId: 'n2', count: 12 });
    command(game, { type: 'buyPods', nodeId: 'u3', count: 12 });
    command(game, { type: 'openService' });
    type Trip = NonNullable<Game['pods'][number]['plan']>['customer'];
    const observed = new Map<number, { pod: number; trip: Trip }>();
    for (let second = 0; second < 1800; second++) {
      if (second === 500) {
        command(game, { type: 'upgradePort', nodeId: 'j1' });
        command(game, { type: 'upgradeEdge', edgeId: game.edges[0].id });
      }
      if (second === 700) command(game, { type: 'startEvent' });
      advanceGame(game, 1);
      for (const pod of game.pods) {
        for (const trip of [pod.plan?.empty, pod.plan?.customer])
          if (trip) observed.set(trip.id, { pod: pod.id, trip: structuredClone(trip) });
      }
    }
    expect(observed.size).toBeGreaterThan(30);
    const byResource = new Map<string, { start: number; end: number; trip: number }[]>();
    const byPod = new Map<number, Trip[]>();
    for (const { pod, trip } of observed.values()) {
      expect(trip.path[0]).toBe(trip.origin);
      expect(trip.path.at(-1)).toBe(trip.destination);
      expect(new Set(trip.path).size).toBe(trip.path.length);
      expect(trip.segments[0].start).toBe(trip.departure);
      expect(trip.segments.at(-1)?.end).toBe(trip.arrival);
      for (let i = 0; i < trip.segments.length; i++) {
        const segment = trip.segments[i];
        expect(game.nodes[segment.from]).toBeDefined();
        expect(game.nodes[segment.to]).toBeDefined();
        expect(segment.end).toBeGreaterThan(segment.start);
        if (i) {
          expect(segment.start).toBe(trip.segments[i - 1].end);
          expect(segment.from).toBe(trip.segments[i - 1].to);
        }
        if (segment.from !== segment.to)
          expect(
            game.edges.some(
              (e) =>
                (e.from === segment.from && e.to === segment.to) ||
                (e.from === segment.to && e.to === segment.from),
            ),
          ).toBe(true);
        const intervals = byResource.get(segment.resource) ?? [];
        intervals.push({ start: segment.start, end: segment.end + 1, trip: trip.id });
        byResource.set(segment.resource, intervals);
      }
      const trips = byPod.get(pod) ?? [];
      trips.push(trip);
      byPod.set(pod, trips);
    }
    for (const intervals of byResource.values()) {
      intervals.sort((a, b) => a.start - b.start);
      for (let i = 1; i < intervals.length; i++)
        expect(
          intervals[i].start,
          `conflict between ${intervals[i - 1].trip} and ${intervals[i].trip}`,
        ).toBeGreaterThanOrEqual(intervals[i - 1].end);
    }
    for (const trips of byPod.values()) {
      trips.sort((a, b) => a.departure - b.departure);
      for (let i = 1; i < trips.length; i++) {
        expect(trips[i].origin).toBe(trips[i - 1].destination);
        expect(trips[i].departure).toBeGreaterThanOrEqual(trips[i - 1].arrival);
      }
    }
    expect(getSnapshot(game).metrics.connectedBuildings).toBe(12);
  });
});
