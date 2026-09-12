import { describe, it, expect } from 'vitest';
import {
  createGame,
  applyCommand,
  getSnapshot,
  serializeGame,
  deserializeGame,
  advanceGame,
} from '../src/simulation';

describe('free network editor integration', () => {
  it('starts with buildings only, and can build a trunk before connecting any destination', () => {
    const game = createGame();
    expect(getSnapshot(game).nodes.every((n) => n.kind !== 'junction' && !n.portBuilt)).toBe(true);
    const result = applyCommand(game, {
      type: 'drawTrack',
      points: [
        { x: 80, y: 80 },
        { x: 660, y: 80 },
      ],
    });
    expect(result.ok, result.message?.en).toBe(true);
    const state = getSnapshot(game);
    expect(state.edges).toHaveLength(1);
    expect(state.nodes.filter((n) => n.kind === 'junction')).toHaveLength(2);
    expect(state.metrics.connectedBuildings).toBe(0);
    expect(state.cash).toBeLessThan(4200);
    expect(() => deserializeGame(serializeGame(game))).not.toThrow();
  });
  it('adds a real branch into an existing trunk atomically and preserves saveability', () => {
    const game = createGame();
    expect(
      applyCommand(game, {
        type: 'drawTrack',
        points: [
          { x: 80, y: 80 },
          { x: 660, y: 80 },
        ],
      }).ok,
    ).toBe(true);
    const edge = getSnapshot(game).edges[0];
    const result = applyCommand(game, {
      type: 'drawTrack',
      points: [
        { x: 370, y: 80, edgeId: edge.id },
        { x: 370, y: 200 },
      ],
    });
    expect(result.ok, result.message?.en).toBe(true);
    const state = getSnapshot(game);
    expect(state.edges).toHaveLength(3);
    expect(state.edges.find((e) => e.id === edge.id)).toBeUndefined();
    const center = state.nodes.find((n) => n.kind === 'junction' && n.x === 370 && n.y === 80)!;
    expect(state.edges.filter((e) => e.from === center.id || e.to === center.id)).toHaveLength(3);
    expect(getSnapshot(deserializeGame(serializeGame(game)))).toEqual(state);
  });
  it('rejects unaffordable whole drawings without spending money or leaving ghost junctions', () => {
    const game = createGame();
    game.cash = 1;
    const before = serializeGame(game);
    expect(
      applyCommand(game, {
        type: 'drawTrack',
        points: [
          { x: 80, y: 80 },
          { x: 660, y: 80 },
        ],
      }).ok,
    ).toBe(false);
    expect(serializeGame(game)).toBe(before);
  });
  it('protects booked tracks, then permits rebuilding after the operator pauses new orders and drains vehicles', () => {
    const game = createGame();
    applyCommand(game, { type: 'addPort', nodeId: 'n1', side: 'south' });
    applyCommand(game, { type: 'addPort', nodeId: 'c1', side: 'north' });
    applyCommand(game, { type: 'build', from: 'n1', to: 'c1' });
    applyCommand(game, { type: 'openService' });
    for (let i = 0; i < 120 && !game.pods.some((p) => p.plan); i++) advanceGame(game, 1);
    expect(game.pods.some((p) => p.plan)).toBe(true);
    const id = game.edges[0].id;
    expect(applyCommand(game, { type: 'removeEdge', edgeId: id }).ok).toBe(false);
    expect(applyCommand(game, { type: 'closeService' }).ok).toBe(true);
    advanceGame(game, 400);
    expect(game.pods.every((p) => !p.plan)).toBe(true);
    expect(applyCommand(game, { type: 'removeEdge', edgeId: id }).ok).toBe(true);
    expect(getSnapshot(game).edges).toHaveLength(0);
  });
});
