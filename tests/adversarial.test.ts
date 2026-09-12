import { describe, expect, it } from 'vitest';
import {
  advanceGame,
  applyCommand,
  createGame,
  deserializeGame,
  serializeGame,
  type Game,
} from '../src/simulation';

function command(game: Game, value: Parameters<typeof applyCommand>[1]) {
  const result = applyCommand(game, value);
  expect(result.ok, result.message?.en).toBe(true);
}

function corridor(seed = 17) {
  const game = createGame(seed);
  command(game, { type: 'addPort', nodeId: 'n1', side: 'south' });
  command(game, { type: 'addPort', nodeId: 'c1', side: 'north' });
  command(game, { type: 'build', from: 'n1', to: 'c1' });
  command(game, { type: 'openService' });
  return game;
}

function saveObject(game: Game) {
  return JSON.parse(serializeGame(game)) as Record<string, any>;
}

describe('adversarial save and transaction boundaries', () => {
  it('rejects a live journey when its physical calendar reservations are missing', () => {
    const game = corridor();
    for (let second = 0; second < 240 && !game.pods.some((p) => p.plan); second++)
      advanceGame(game, 1);
    expect(game.pods.some((p) => p.plan)).toBe(true);

    const corrupted = saveObject(game);
    corrupted.calendars = {};
    expect(() => deserializeGame(JSON.stringify(corrupted))).toThrow();
  });

  it('rejects a live journey whose calendar contains the wrong trip correspondence', () => {
    const game = corridor(29);
    for (let second = 0; second < 240 && !game.pods.some((p) => p.plan); second++)
      advanceGame(game, 1);
    expect(game.pods.some((p) => p.plan)).toBe(true);

    const corrupted = saveObject(game);
    const journey = game.pods.find((pod) => pod.plan)?.plan!.customer;
    const segment = journey!.segments[0];
    const booking = corrupted.calendars[segment.resource].find(
      (entry: any) => entry.trip === journey!.id && entry.start === segment.start,
    );
    booking.trip += 100_000;
    expect(() => deserializeGame(JSON.stringify(corrupted))).toThrow();
  });

  it('rejects a dynamic junction placed inside a building exclusion radius on load', () => {
    const game = createGame();
    command(game, { type: 'addJunction', x: 700, y: 540 });

    const overlapping = saveObject(game);
    overlapping.nodes.j1.x = 230;
    overlapping.nodes.j1.y = 285;
    overlapping.nodes.j1.portX = 230;
    overlapping.nodes.j1.portY = 285;
    expect(() => deserializeGame(JSON.stringify(overlapping))).toThrow();
  });

  it('rejects impossible customer counters before they can yield market share above one', () => {
    const corrupted = saveObject(createGame());
    corrupted.totalDemand = 1;
    corrupted.startedCustomerTrips = 2;
    corrupted.served = 2;
    expect(() => deserializeGame(JSON.stringify(corrupted))).toThrow();
  });

  it('rejects a next journey ID that can collide with an active booking', () => {
    const game = corridor(41);
    for (let second = 0; second < 240 && !game.pods.some((p) => p.plan); second++)
      advanceGame(game, 1);
    expect(game.pods.some((p) => p.plan)).toBe(true);

    const corrupted = saveObject(game);
    corrupted.nextJourney = 1;
    expect(() => deserializeGame(JSON.stringify(corrupted))).toThrow(/Invalid FutureTransit save/);
  });

  it('rejects an unsafe dynamic junction ID before it can break future allocation', () => {
    const game = createGame();
    command(game, { type: 'addJunction', x: 700, y: 540 });
    const corrupted = saveObject(game);
    const unsafeId = 'j9007199254740993';
    corrupted.nodes[unsafeId] = { ...corrupted.nodes.j1, id: unsafeId };
    delete corrupted.nodes.j1;
    expect(() => deserializeGame(JSON.stringify(corrupted))).toThrow();
  });

  it('keeps all state intact after an invalid or unaffordable drawing', () => {
    const game = createGame();
    const beforeInvalid = serializeGame(game);
    expect(
      applyCommand(game, {
        type: 'drawTrack',
        points: [
          { x: 80, y: 80 },
          { x: 800, y: 90 },
        ],
      }).ok,
    ).toBe(false);
    expect(serializeGame(game)).toBe(beforeInvalid);

    game.cash = 1;
    const beforeUnaffordable = serializeGame(game);
    expect(
      applyCommand(game, {
        type: 'drawTrack',
        points: [
          { x: 80, y: 80 },
          { x: 660, y: 80 },
        ],
      }).ok,
    ).toBe(false);
    expect(serializeGame(game)).toBe(beforeUnaffordable);
  });

  it('keeps active trajectory reservations valid through an edge upgrade and save round trip', () => {
    const game = corridor(5);
    for (let second = 0; second < 240 && !game.pods.some((p) => p.plan); second++)
      advanceGame(game, 1);
    expect(game.pods.some((p) => p.plan)).toBe(true);
    game.cash = 10_000;
    command(game, { type: 'upgradeEdge', edgeId: game.edges[0].id });

    const restored = deserializeGame(serializeGame(game));
    for (const pod of restored.pods)
      for (const journey of [pod.plan?.empty, pod.plan?.customer]) {
        if (!journey) continue;
        for (const segment of journey.segments) {
          expect(
            restored.calendars[segment.resource]?.some(
              (booking) =>
                booking.trip === journey.id &&
                booking.start === segment.start &&
                booking.end === segment.end + 1,
            ),
          ).toBe(true);
        }
      }
  });

  it('can save and reload at every phase boundary while service dispatches', () => {
    const game = corridor(23);
    for (let second = 0; second < 360; second++) {
      advanceGame(game, 1);
      expect(() => deserializeGame(serializeGame(game))).not.toThrow();
    }
  });

  it('generates the same city OD sequence with no topology and with a corridor', () => {
    const disconnected = createGame(53);
    const connected = createGame(53);
    command(disconnected, { type: 'setRunning', value: true });
    command(connected, { type: 'addPort', nodeId: 'n1', side: 'south' });
    command(connected, { type: 'addPort', nodeId: 'c1', side: 'north' });
    command(connected, { type: 'build', from: 'n1', to: 'c1' });
    command(connected, { type: 'setRunning', value: true });

    advanceGame(disconnected, 360);
    advanceGame(connected, 360);
    expect(connected.demandLog).toEqual(disconnected.demandLog);
  });
});
