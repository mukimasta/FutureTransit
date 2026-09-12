import { describe, expect, it } from 'vitest';
import type { EdgeView, NodeView, TrackPoint } from '../src/shared/types';
import { ECONOMY } from '../src/scenarios/city';
import { planTrack } from '../src/network';

const node = (id: string, x: number, y: number, kind: NodeView['kind'] = 'junction'): NodeView => ({
  id,
  name: { zh: id, en: id },
  x,
  y,
  kind,
  district: x > 900 ? 'campus' : y < 540 ? 'north' : 'central',
  population: 1,
  portBuilt: true,
  portX: x,
  portY: y,
  queue: 0,
  served: 0,
  portLevel: 1,
  connected: false,
  growth: 0,
});
const edge = (
  id: string,
  from: string,
  to: string,
  length: number,
  travelTime = 10,
  level = 1,
): EdgeView => ({
  id,
  from,
  to,
  length,
  cost: length,
  travelTime,
  level,
  utilization: 0,
  trips: 7,
});

describe('network planner', () => {
  it('plans a free polyline with new junctions and each charged link', () => {
    const nodes = [node('a', 100, 100, 'residential'), node('b', 500, 100, 'office')];
    const result = planTrack(
      nodes,
      [],
      [
        { x: 100, y: 100, nodeId: 'a' },
        { x: 300, y: 200 },
        { x: 500, y: 100, nodeId: 'b' },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.addNodes).toMatchObject([{ id: 'j1', x: 300, y: 200, kind: 'junction' }]);
    expect(result.addEdges).toHaveLength(2);
    expect(
      result.addEdges.every((link) => link.cost > 0 && link.length > 0 && link.travelTime > 0),
    ).toBe(true);
    expect(result.cost).toBe(
      ECONOMY.junctionCost + result.addEdges.reduce((sum, link) => sum + link.cost, 0),
    );
  });

  it('splits an upgraded edge in geometric order with asymmetric proportional times', () => {
    const nodes = [
      node('a', 100, 100),
      node('b', 500, 100),
      node('c', 100, 300),
      node('d', 500, 300),
    ];
    const old = edge('old', 'a', 'b', 400, 100, 3);
    const result = planTrack(
      nodes,
      [old],
      [
        { x: 100, y: 300, nodeId: 'c' },
        { x: 400, y: 101, edgeId: 'old' },
        { x: 140, y: 99, edgeId: 'old' },
        { x: 500, y: 300, nodeId: 'd' },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removeEdgeIds).toEqual(['old']);
    const replacements = result.addEdges.filter((link) => link.cost === 0);
    expect(replacements).toHaveLength(3);
    expect(replacements.every((link) => link.level === 3 && link.trips === 7)).toBe(true);
    expect(replacements.find((link) => link.from === 'a')?.travelTime).toBe(10);
    expect(replacements.find((link) => link.from === 'j2' && link.to === 'j1')?.travelTime).toBe(
      65,
    );
    expect(replacements.find((link) => link.to === 'b')?.travelTime).toBe(25);
    expect(result.cost).toBe(
      ECONOMY.junctionCost * 2 +
        result.addEdges.filter((link) => link.cost > 0).reduce((sum, link) => sum + link.cost, 0),
    );
  });

  it('leaves the inputs untouched when a plan is cancelled', () => {
    const nodes = [node('a', 100, 100, 'residential'), node('b', 500, 100, 'office')];
    const edges = [edge('old', 'a', 'b', 400)];
    const before = structuredClone({ nodes, edges });
    const result = planTrack(nodes, edges, [
      { x: 100, y: 100, nodeId: 'a' },
      { x: 200, y: 100, edgeId: 'missing' },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect({ nodes, edges }).toEqual(before);
  });

  it('rejects duplicate connections, water waypoints, and through-building routes', () => {
    const direct = [node('a', 100, 100, 'residential'), node('b', 500, 100, 'office')];
    expect(
      planTrack(
        direct,
        [edge('exists', 'a', 'b', 400)],
        [
          { x: 100, y: 100, nodeId: 'a' },
          { x: 500, y: 100, nodeId: 'b' },
        ],
      ).ok,
    ).toBe(false);
    expect(
      planTrack(
        direct,
        [],
        [
          { x: 100, y: 100, nodeId: 'a' },
          { x: 100, y: 100, nodeId: 'a' },
        ],
      ).ok,
    ).toBe(false);
    expect(
      planTrack(
        direct,
        [],
        [
          { x: 100, y: 100, nodeId: 'a' },
          { x: -1, y: 100 },
        ],
      ).ok,
    ).toBe(false);
    expect(
      planTrack(
        direct,
        [],
        [
          { x: 100, y: 100, nodeId: 'a' },
          { x: 39, y: 200 },
        ],
      ).ok,
    ).toBe(false);
    expect(
      planTrack(
        [node('a', 100, 100)],
        [],
        [
          { x: 100, y: 100, nodeId: 'a' },
          { x: 800, y: 200 },
        ],
      ).ok,
    ).toBe(false);
    expect(
      planTrack(
        [node('a', 100, 100)],
        [],
        [
          { x: 100, y: 100, nodeId: 'a' },
          { x: 900, y: 200 },
        ],
      ).ok,
    ).toBe(false);
    const blocked = [
      node('a', 100, 100, 'residential'),
      node('b', 500, 100, 'office'),
      node('blocked', 300, 100, 'office'),
    ];
    const result = planTrack(
      blocked,
      [],
      [
        { x: 100, y: 100, nodeId: 'a' },
        { x: 500, y: 100, nodeId: 'b' },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.en).toMatch(/building/);
  });
});
