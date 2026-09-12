import { describe, expect, it } from 'vitest';
import {
  advanceGame,
  applyCommand,
  auditGame,
  createGame,
  deserializeGame,
  getSnapshot,
  serializeGame,
} from '../src/simulation';

function firstCorridor(seed = 4) {
  const game = createGame(seed);
  expect(applyCommand(game, { type: 'addPort', nodeId: 'n1', side: 'south' }).ok).toBe(true);
  expect(applyCommand(game, { type: 'addPort', nodeId: 'c1', side: 'north' }).ok).toBe(true);
  expect(applyCommand(game, { type: 'build', from: 'n1', to: 'c1' }).ok).toBe(true);
  expect(applyCommand(game, { type: 'openService' }).ok).toBe(true);
  return game;
}

describe('simulation', () => {
  it('starts paused with six free pods and immutable snapshots', () => {
    const game = createGame(9);
    const one = getSnapshot(game);
    expect(one.running).toBe(false);
    expect(one.cash).toBe(4200);
    expect(one.pods).toHaveLength(6);
    one.pods[0].x = -99;
    expect(getSnapshot(game).pods[0].x).not.toBe(-99);
  });

  it('rejects invalid commands and cannot open without a home-to-work route', () => {
    const game = createGame();
    expect(applyCommand(game, { type: 'openService' }).ok).toBe(false);
    expect(applyCommand(game, { type: 'setFare', value: Number.NaN }).ok).toBe(false);
    expect(applyCommand(game, { type: 'buyPods', nodeId: 'nope', count: 1 }).ok).toBe(false);
    expect(applyCommand(game, { type: 'build', from: 'n1', to: 'n1' }).ok).toBe(false);
  });

  it('exposes player-built access points and atomically applies a drawn track', () => {
    const game = createGame(3);
    expect(applyCommand(game, { type: 'addPort', nodeId: 'n1', side: 'east' }).ok).toBe(true);
    expect(applyCommand(game, { type: 'addPort', nodeId: 'c1', side: 'west' }).ok).toBe(true);
    expect(
      applyCommand(game, {
        type: 'drawTrack',
        points: [
          { x: 254, y: 285, nodeId: 'n1' },
          { x: 416, y: 625, nodeId: 'c1' },
        ],
      }).ok,
    ).toBe(true);
    const snapshot = getSnapshot(game);
    expect(snapshot.nodes.find((n) => n.id === 'n1')).toMatchObject({
      portBuilt: true,
      portX: 254,
      portY: 285,
    });
    expect(snapshot.edges).toHaveLength(1);
    expect(applyCommand(game, { type: 'addJunction', x: 700, y: 540 }).ok).toBe(true);
    expect(getSnapshot(game).nodes.some((n) => n.id === 'j1' && n.kind === 'junction')).toBe(true);
  });

  it('makes legacy two-node builds obey the same building clearance as drawing', () => {
    const game = createGame(3);
    expect(applyCommand(game, { type: 'addPort', nodeId: 'c1', side: 'north' }).ok).toBe(true);
    expect(applyCommand(game, { type: 'addPort', nodeId: 'u3', side: 'south' }).ok).toBe(true);
    const points = [
      { x: game.nodes.c1.portX, y: game.nodes.c1.portY, nodeId: 'c1' },
      { x: game.nodes.u3.portX, y: game.nodes.u3.portY, nodeId: 'u3' },
    ];
    const legacy = applyCommand(game, { type: 'build', from: 'c1', to: 'u3' });
    const drawn = applyCommand(game, { type: 'drawTrack', points });
    expect(legacy).toMatchObject({ ok: false });
    expect(drawn).toMatchObject({ ok: false });
    expect(legacy.message).toEqual(drawn.message);
    expect(getSnapshot(game).edges).toHaveLength(0);
  });

  it('runs passenger service, earns fares, and keeps reservations conflict-free', () => {
    const game = firstCorridor();
    const before = getSnapshot(game).cash;
    advanceGame(game, 180);
    const view = getSnapshot(game);
    expect(view.metrics.served).toBeGreaterThan(0);
    expect(view.metrics.revenue).toBeGreaterThan(0);
    expect(view.metrics.marketShare).toBeGreaterThan(0);
    expect(view.cash).toBeGreaterThan(before);
    expect(view.demandFlows.some((f) => f.from === 'n1' && f.to === 'c1')).toBe(true);
    expect(auditGame(game)).toMatchObject({ ok: true, conflicts: 0 });
  });

  it('persists RNG and active bookings deterministically', () => {
    const original = firstCorridor(12);
    advanceGame(original, 67);
    const restored = deserializeGame(serializeGame(original));
    advanceGame(original, 91);
    advanceGame(restored, 91);
    expect(getSnapshot(restored)).toEqual(getSnapshot(original));
    expect(() => deserializeGame('{"saveVersion":1}')).toThrow();
  });

  it('upgrades add physical lane capacity and preserve scheduled bookings', () => {
    const game = firstCorridor(5);
    advanceGame(game, 3);
    const edge = getSnapshot(game).edges.find((e) => e.from === 'n1' && e.to === 'c1')!;
    const booked = auditGame(game);
    const cash = getSnapshot(game).cash;
    expect(applyCommand(game, { type: 'upgradeEdge', edgeId: edge.id }).ok).toBe(true);
    const changed = getSnapshot(game).edges.find((e) => e.id === edge.id)!;
    expect(changed.level).toBe(2);
    expect(getSnapshot(game).cash).toBe(cash - 480);
    expect(auditGame(game)).toEqual(booked);
  });
});
