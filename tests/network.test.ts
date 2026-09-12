import { describe, expect, it } from "vitest";
import { TRACK_COST } from "../src/shared/constants";
import type { Berth, Building, Point, Track, World } from "../src/shared/types";
import {
  buildingDoor,
  edgeKey,
  edgeResources,
  findTrackPath,
  findWalkPath,
  isBlocked,
  nodeKey,
  tracePolyline,
  validateTrackDraft,
} from "../src/network";

const building = (
  id: string,
  x: number,
  y: number,
  w = 2,
  h = 2,
): Building => ({
  id,
  name: id,
  nameEn: id,
  kind: "home",
  x,
  y,
  w,
  h,
  bornAt: 0,
});

const track = (id: string, a: Point, b: Point): Track => ({
  id,
  a,
  b,
  paid: TRACK_COST,
});

const berth = (id: string, point: Point, access: Point): Berth => ({
  id,
  buildingId: "building",
  kind: "platform",
  point,
  access,
  side: "south",
  paid: 0,
});

function world(overrides: Partial<World> = {}): World {
  return {
    version: 2,
    seed: 1,
    rng: 1,
    time: 0,
    paused: true,
    speed: 1,
    width: 10,
    height: 10,
    nextId: 1,
    networkVersion: 0,
    buildings: [],
    berths: [],
    tracks: [],
    residents: [],
    pods: [],
    reservations: [],
    economy: {
      cash: 0,
      income: 0,
      maintenance: 0,
      subsidy: 0,
      spent: 0,
      nextGrantAt: 0,
      lastMaintenanceAt: 0,
    },
    metrics: {
      served: 0,
      walked: 0,
      savedSeconds: 0,
      totalWait: 0,
      recentTrips: [],
    },
    growth: {
      wave: 0,
      nextAt: 0,
      announced: false,
      enabled: false,
      complete: false,
    },
    notices: [],
    pendingEdits: [],
    ...overrides,
  };
}

describe("network resource keys", () => {
  it("keeps edge and node resources stable in either travel direction", () => {
    const a = { x: 2, y: 10 };
    const b = { x: 10, y: 2 };
    expect(edgeKey(a, b)).toBe(edgeKey(b, a));
    expect(edgeResources(a, b)[0]).toBe(edgeResources(b, a)[0]);
    expect(nodeKey(a)).toBe("node:2,10");
  });

  it("makes opposite diagonals share one midpoint crossing resource", () => {
    const rising = edgeResources({ x: 2, y: 2 }, { x: 3, y: 3 });
    const falling = edgeResources({ x: 2, y: 3 }, { x: 3, y: 2 });
    expect(rising[0]).not.toBe(falling[0]);
    expect(rising[1]).toBe("crossing:5,5");
    expect(falling[1]).toBe(rising[1]);
    expect(edgeResources({ x: 2, y: 2 }, { x: 3, y: 2 })).toHaveLength(1);
  });
});

describe("track construction", () => {
  it("rasterizes arbitrary integer polylines into adjacent eight-direction units", () => {
    const result = tracePolyline([
      { x: 0, y: 0 },
      { x: 4, y: 2 },
      { x: 4, y: 4 },
    ]);
    expect(result[0]).toEqual({ x: 0, y: 0 });
    expect(result.at(-1)).toEqual({ x: 4, y: 4 });
    expect(
      result.slice(1).every((point, index) => {
        const previous = result[index];
        const dx = Math.abs(point.x - previous.x);
        const dy = Math.abs(point.y - previous.y);
        return Math.max(dx, dy) === 1;
      }),
    ).toBe(true);
  });

  it("rejects fractional and non-finite control points", () => {
    const base = world();
    expect(
      validateTrackDraft(base, [
        { x: 0, y: 0 },
        { x: 1.5, y: 1 },
      ]).errorEn,
    ).toMatch(/integer/);
    expect(
      validateTrackDraft(base, [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 1 },
      ]).errorEn,
    ).toMatch(/integer/);
  });

  it("rejects out-of-bounds geometry independently of building checks", () => {
    const result = validateTrackDraft(world(), [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(result).toMatchObject({ edges: [], cost: 0 });
    expect(result.errorEn).toMatch(/bounds/);
  });

  it("rejects every occupied building boundary point", () => {
    const base = world({ buildings: [building("block", 2, 2, 3, 2)] });
    expect(isBlocked(base, { x: 4, y: 3 })).toBe(true);
    expect(isBlocked(base, { x: 5, y: 3 })).toBe(false);
    const result = validateTrackDraft(base, [
      { x: 0, y: 3 },
      { x: 6, y: 3 },
    ]);
    expect(result.errorEn).toMatch(/building/);
  });

  it("rejects track touching a berth even at a draft endpoint", () => {
    const base = world({
      berths: [berth("platform", { x: 4, y: 4 }, { x: 4, y: 5 })],
    });
    const through = validateTrackDraft(base, [
      { x: 2, y: 4 },
      { x: 6, y: 4 },
    ]);
    const endpoint = validateTrackDraft(base, [
      { x: 2, y: 4 },
      { x: 4, y: 4 },
    ]);
    expect(through.errorEn).toMatch(/berth/);
    expect(endpoint.errorEn).toMatch(/berth/);
  });

  it("deduplicates repeated and already-built physical units and charges only new length", () => {
    const base = world({
      tracks: [track("existing", { x: 0, y: 0 }, { x: 1, y: 0 })],
    });
    const before = structuredClone(base);
    const result = validateTrackDraft(base, [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.edges.map((edge) => edgeKey(edge.a, edge.b))).toEqual([
      edgeKey({ x: 1, y: 0 }, { x: 2, y: 0 }),
      edgeKey({ x: 2, y: 0 }, { x: 3, y: 0 }),
      edgeKey({ x: 1, y: 0 }, { x: 1, y: 1 }),
    ]);
    expect(result.cost).toBe(TRACK_COST * 3);
    expect(base).toEqual(before);
  });

  it("charges diagonal units by their actual geometric length", () => {
    const result = validateTrackDraft(world(), [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(result.cost).toBeCloseTo(TRACK_COST * Math.SQRT2);
    expect(result.edges[0].paid).toBe(result.cost);
  });
});

describe("track routing", () => {
  it("automatically connects both berth spurs to the traffic network", () => {
    const start = berth("start", { x: 0, y: 0 }, { x: 1, y: 0 });
    const end = berth("end", { x: 4, y: 0 }, { x: 3, y: 0 });
    const base = world({
      berths: [start, end],
      tracks: [
        track("one", { x: 1, y: 0 }, { x: 2, y: 0 }),
        track("two", { x: 2, y: 0 }, { x: 3, y: 0 }),
      ],
    });
    expect(findTrackPath(base, start.point, end.point)).toEqual([
      start.point,
      start.access,
      { x: 2, y: 0 },
      end.access,
      end.point,
    ]);
  });

  it("never uses a different berth point as an intermediate shortcut", () => {
    const middle = berth("middle", { x: 2, y: 0 }, { x: 2, y: 1 });
    const base = world({
      berths: [middle],
      tracks: [
        track("left", { x: 1, y: 0 }, middle.point),
        track("right", middle.point, { x: 3, y: 0 }),
      ],
    });
    expect(findTrackPath(base, { x: 1, y: 0 }, { x: 3, y: 0 })).toBeNull();
    expect(findTrackPath(base, { x: 1, y: 0 }, middle.point)).toEqual([
      { x: 1, y: 0 },
      middle.point,
    ]);
  });
});

describe("walking and doors", () => {
  it("places the door immediately outside the inclusive building footprint", () => {
    const block = building("home", 3, 4, 4, 3);
    const door = buildingDoor(block);
    const base = world({ buildings: [block] });
    expect(door).toEqual({ x: 4, y: 7 });
    expect(isBlocked(base, door)).toBe(false);
    expect(isBlocked(base, { x: door.x, y: 6 })).toBe(true);
  });

  it("finds an eight-direction walking detour around a building", () => {
    const base = world({
      width: 7,
      height: 7,
      buildings: [building("block", 2, 1, 2, 3)],
    });
    const path = findWalkPath(base, { x: 1, y: 2 }, { x: 5, y: 2 });
    expect(path).not.toBeNull();
    expect(path!.every((point) => !isBlocked(base, point))).toBe(true);
    expect(path!.some((point) => point.y >= 4 || point.y === 0)).toBe(true);
  });

  it("does not squeeze diagonally between two blocked orthogonal neighbors", () => {
    const base = world({
      width: 2,
      height: 2,
      buildings: [building("east", 1, 0, 1, 1), building("south", 0, 1, 1, 1)],
    });
    expect(findWalkPath(base, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });
});
