import { describe, expect, it } from 'vitest';
import { chooseDemandPair, choosesPod, estimateExpectedWait } from '../src/simulation/demand';
import { applyJourneyEconomy, journeyOperatingCost } from '../src/simulation/economy';
import { advanceGame, applyCommand, createGame, getSnapshot, type Game } from '../src/simulation';
import { CITY_NODES } from '../src/scenarios/city';

function command(game: Game, value: Parameters<typeof applyCommand>[1]) {
  const result = applyCommand(game, value);
  expect(result.ok, result.message?.en).toBe(true);
}

function starter(seed = 7) {
  const game = createGame(seed);
  command(game, { type: 'addPort', nodeId: 'n1', side: 'south' });
  command(game, { type: 'addPort', nodeId: 'c1', side: 'north' });
  command(game, { type: 'build', from: 'n1', to: 'c1' });
  command(game, { type: 'openService' });
  return game;
}

describe('demand and operating economy', () => {
  it('lets every building originate and attract a topology-independent background trip', () => {
    for (let index = 0; index < CITY_NODES.length; index++) {
      const values = [0.9, (index + 0.1) / CITY_NODES.length, (index + 0.6) / CITY_NODES.length];
      const pair = chooseDemandPair(CITY_NODES, () => values.shift()!);
      expect(pair.origin).toBe(CITY_NODES[index].id);
      expect(pair.destination).toBe(CITY_NODES[(index + 1) % CITY_NODES.length].id);
    }
  });

  it('makes the same reachable OD choose pods less often at a high fare', () => {
    const common = { podTravelSeconds: 18, expectedWaitSeconds: 8, directDistance: 400 };
    let low = 0,
      high = 0;
    for (let i = 0; i < 100; i++) {
      const roll = (i + 0.5) / 100;
      low += Number(choosesPod({ ...common, fare: 1 }, 0.5, roll));
      high += Number(choosesPod({ ...common, fare: 12 }, 0.5, roll));
    }
    expect(low).toBeGreaterThan(high);
    expect(low - high).toBeGreaterThan(25);
  });

  it('raises expected waiting time from live backlog and observed service', () => {
    const empty = estimateExpectedWait({
      queued: 0,
      assigned: 0,
      podCount: 6,
      activeRemainingSeconds: 0,
      routeSeconds: 20,
      recentServiceSeconds: [],
      recentWaitSeconds: [],
    });
    const loaded = estimateExpectedWait({
      queued: 6,
      assigned: 3,
      podCount: 3,
      activeRemainingSeconds: 60,
      routeSeconds: 20,
      recentServiceSeconds: [30, 36],
      recentWaitSeconds: [8, 12],
    });
    expect(loaded).toBeGreaterThan(empty);
  });

  it('charges every journey while retaining positive fare revenue', () => {
    const emptyCost = journeyOperatingCost('empty', 24);
    const customerCost = journeyOperatingCost('customer', 24);
    const result = applyJourneyEconomy(100, 40, 'customer', 24, 9);
    expect(emptyCost).toBeGreaterThan(0);
    expect(customerCost).toBeGreaterThanOrEqual(emptyCost);
    expect(result).toMatchObject({
      cash: 100 + 9 - customerCost,
      expenses: 40 + customerCost,
      revenue: 9,
    });
  });

  it('pauses orders but drains booked journeys without deleting reservations', () => {
    const game = starter();
    for (let second = 0; second < 180 && !game.pods.some((pod) => pod.plan); second++)
      advanceGame(game, 1);
    expect(game.pods.some((pod) => pod.plan)).toBe(true);
    const result = applyCommand(game, { type: 'closeService' });
    expect(result).toMatchObject({
      ok: true,
      message: { en: 'New orders paused; booked journeys continue' },
    });
    expect(game.requests).toHaveLength(0);
    advanceGame(game, 240);
    expect(game.pods.some((pod) => pod.plan)).toBe(false);
    expect(getSnapshot(game).serviceOpen).toBe(false);
    expect(getSnapshot(game).edges[0].trips).toBeGreaterThan(0);
  });

  it('counts a concert only after riders actually reach the arena', () => {
    const game = starter(31);
    game.cash = 100_000;
    command(game, { type: 'addPort', nodeId: 'u3', side: 'south' });
    command(game, { type: 'addPort', nodeId: 'u4', side: 'north' });
    command(game, {
      type: 'drawTrack',
      points: [
        { x: game.nodes.u3.portX, y: game.nodes.u3.portY, nodeId: 'u3' },
        { x: 1500, y: 300 },
        { x: 1500, y: 880 },
        { x: game.nodes.u4.portX, y: game.nodes.u4.portY, nodeId: 'u4' },
      ],
    });
    command(game, { type: 'buyPods', nodeId: 'u3', count: 4 });
    for (let i = 0; i < 5; i++) game.missions[i].completed = true;
    advanceGame(game, 360);
    command(game, { type: 'startEvent' });
    expect(game.event.served).toBe(0);
    advanceGame(game, 180);
    expect(game.event.served).toBeGreaterThan(0);
    expect(game.missions.find((mission) => mission.id === 'concert')!.progress).toBeGreaterThan(0);
  });
});
