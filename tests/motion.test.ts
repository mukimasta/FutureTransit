import { describe, expect, it } from "vitest";
import { nodeKey } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import { commitPlan, planRelocation } from "../src/scheduler";
import {
  CELL_METERS,
  CLEARANCE_SECONDS,
  NODE_SECONDS,
  POD_METERS_PER_SECOND,
  TIME_SCALE,
} from "../src/shared/constants";
import { RenderClock } from "../src/shared/render-clock";
import {
  assertTrajectory,
  requiredTrajectoryWindows,
} from "../src/shared/trajectory";
import type {
  Berth,
  MotionSegment,
  Pod,
  Reservation,
  ServicePlan,
  Track,
  World,
} from "../src/shared/types";
import { createWorld } from "../src/simulation";

function berth(
  id: string,
  point: [number, number],
  access: [number, number],
): Berth {
  return {
    id,
    buildingId: `building-${id}`,
    kind: "parking",
    point: { x: point[0], y: point[1] },
    access: { x: access[0], y: access[1] },
    side: "south",
    paid: 0,
  };
}

function track(id: string, a: [number, number], b: [number, number]): Track {
  return { id, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, paid: 0 };
}

function pod(id: string, berthId: string): Pod {
  return { id, berthId, parkedSince: 0, plan: null, trips: 0, paid: 0 };
}

function schedulerWorld(berths: Berth[], tracks: Track[], pods: Pod[]): World {
  return {
    version: 2,
    seed: 1,
    rng: 1,
    time: 0,
    paused: false,
    speed: 1,
    width: 20,
    height: 20,
    nextId: 1,
    networkVersion: 1,
    buildings: [],
    berths,
    tracks,
    residents: [],
    pods,
    reservations: [],
    economy: {
      cash: 0,
      income: 0,
      maintenance: 0,
      subsidy: 0,
      spent: 0,
      nextGrantAt: 1e9,
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
      nextAt: 1e9,
      announced: false,
      enabled: false,
      complete: false,
    },
    notices: [],
    pendingEdits: [],
  };
}

function straightWorld(): { world: World; origin: Berth; target: Berth } {
  const origin = berth("origin", [0, 2], [1, 2]);
  const target = berth("target", [5, 2], [4, 2]);
  return {
    origin,
    target,
    world: schedulerWorld(
      [origin, target],
      [
        track("one", [1, 2], [2, 2]),
        track("two", [2, 2], [3, 2]),
        track("three", [3, 2], [4, 2]),
      ],
      [pod("pod", origin.id)],
    ),
  };
}

const overlaps = (
  left: { start: number; end: number },
  right: { start: number; end: number },
) => left.start < right.end - 1e-9 && right.start < left.end - 1e-9;

describe("continuous Pod motion", () => {
  it("travels through grid nodes without inserting visible dwell segments", () => {
    const { world, origin, target } = straightWorld();
    const candidate = planRelocation(world, world.pods[0], target);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;

    expect(
      candidate.plan.segments.every((segment) => segment.kind === "move"),
    ).toBe(true);
    for (let index = 1; index < candidate.plan.segments.length; index += 1) {
      expect(candidate.plan.segments[index].start).toBe(
        candidate.plan.segments[index - 1].end,
      );
    }
    const distanceCells = Math.abs(target.point.x - origin.point.x);
    expect(candidate.plan.end - candidate.plan.departure).toBe(
      (distanceCells * CELL_METERS) / POD_METERS_PER_SECOND,
    );
  });

  it("requires an independently rebuilt reservation at every passed node", () => {
    const { world, target } = straightWorld();
    const candidate = planRelocation(world, world.pods[0], target);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;

    const junction = nodeKey({ x: 2, y: 2 });
    const required = requiredTrajectoryWindows(
      world,
      candidate.plan.segments,
    ).find((window) => window.resource === junction);
    expect(required).toBeDefined();
    expect(required!.end - required!.start).toBe(
      NODE_SECONDS + CLEARANCE_SECONDS,
    );
    expect(
      candidate.plan.reservations.some(
        (reservation) =>
          reservation.resource === junction &&
          reservation.start <= required!.start &&
          reservation.end >= required!.end,
      ),
    ).toBe(true);

    const forged = structuredClone(candidate.plan);
    forged.reservations = forged.reservations.filter(
      (reservation) => reservation.resource !== junction,
    );
    expect(() => assertTrajectory(world, forged)).toThrow(
      /missing trajectory reservation/i,
    );
  });

  it("serializes different edges that pass through the same junction", () => {
    const left = berth("left", [0, 2], [1, 2]);
    const right = berth("right", [4, 2], [3, 2]);
    const top = berth("top", [2, 0], [2, 1]);
    const bottom = berth("bottom", [2, 4], [2, 3]);
    const world = schedulerWorld(
      [left, right, top, bottom],
      [
        track("west", [1, 2], [2, 2]),
        track("east", [2, 2], [3, 2]),
        track("north", [2, 1], [2, 2]),
        track("south", [2, 2], [2, 3]),
      ],
      [pod("horizontal", left.id), pod("vertical", top.id)],
    );
    const first = planRelocation(world, world.pods[0], right);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(world, first.plan);
    const second = planRelocation(world, world.pods[1], bottom);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const junction = nodeKey({ x: 2, y: 2 });
    const firstWindow = first.plan.reservations.find(
      (reservation) => reservation.resource === junction,
    )!;
    const secondWindow = second.plan.reservations.find(
      (reservation) => reservation.resource === junction,
    )!;
    expect(overlaps(firstWindow, secondWindow)).toBe(false);
    expect(secondWindow.start).toBeGreaterThanOrEqual(firstWindow.end);
  });

  it("continues to parse an already-running legacy plan with node dwells", () => {
    const world = createWorld(317);
    let candidate:
      | Extract<ReturnType<typeof planRelocation>, { ok: true }>
      | undefined;
    for (const currentPod of world.pods) {
      for (const target of world.berths) {
        if (target.id === currentPod.berthId) continue;
        const result = planRelocation(world, currentPod, target);
        if (result.ok) {
          candidate = result;
          break;
        }
      }
      if (candidate) break;
    }
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const original = candidate.plan;
    const legacySegments: MotionSegment[] = [];
    let cursor = original.departure;
    const addNode = (point: MotionSegment["from"]) => {
      const atBerth = world.berths.find(
        (current) => current.point.x === point.x && current.point.y === point.y,
      );
      legacySegments.push({
        from: { ...point },
        to: { ...point },
        start: cursor,
        end: cursor + NODE_SECONDS,
        kind: "node",
        stage: "relocate",
        resources: [
          nodeKey(point),
          ...(atBerth ? [`berth:${atBerth.id}`] : []),
        ],
      });
      cursor += NODE_SECONDS;
    };
    addNode(original.segments[0].from);
    for (const movement of original.segments) {
      const duration = movement.end - movement.start;
      legacySegments.push({
        ...movement,
        start: cursor,
        end: cursor + duration,
      });
      cursor += duration;
      addNode(movement.to);
    }
    const legacyReservations: Reservation[] = legacySegments.flatMap(
      (segment) =>
        segment.resources.map((resource) => ({
          resource,
          start: segment.start,
          end: segment.end + CLEARANCE_SECONDS,
          ownerId: original.podId,
        })),
    );
    const legacyPlan: ServicePlan = {
      ...original,
      end: cursor,
      segments: legacySegments,
      reservations: legacyReservations,
    };
    const activePod = world.pods.find(
      (current) => current.id === legacyPlan.podId,
    )!;
    activePod.plan = legacyPlan;
    world.reservations = legacyReservations;

    const restored = parseWorld(serializeWorld(world));
    expect(
      restored.pods.find((current) => current.id === activePod.id)?.plan
        ?.segments,
    ).toEqual(legacySegments);
  });
});

describe("render clock", () => {
  for (const speed of [1, 2, 4] as const) {
    it(`stays smooth and monotonic across integer snapshots at ${speed}x`, () => {
      const clock = new RenderClock(0, false, speed, 0);
      let previous = 0;
      for (let tick = 1; tick <= 12; tick += 1) {
        const halfway = clock.sample(tick * 100 - 50);
        expect(halfway).toBeGreaterThanOrEqual(previous);
        previous = halfway;
        const authoritative = Math.floor((tick * TIME_SCALE * speed) / 10);
        const synced = clock.sync(authoritative, false, speed, tick * 100);
        expect(synced).toBeGreaterThanOrEqual(previous);
        previous = synced;
      }
    });
  }

  it("does not reverse for a lagging 4x snapshot, but freezes exactly when paused", () => {
    const clock = new RenderClock(0, false, 4, 0);
    const beforeSnapshot = clock.sample(100);
    expect(beforeSnapshot).toBeGreaterThan(4);
    expect(clock.sync(4, false, 4, 100)).toBe(beforeSnapshot);

    expect(clock.sync(4, true, 4, 110)).toBe(4);
    expect(clock.sample(10_000)).toBe(4);
  });

  it("recognizes a lower loaded/reset timeline and restarts from zero", () => {
    const clock = new RenderClock(100, false, 4, 0);
    clock.sample(100);
    expect(clock.sync(0, true, 1, 110)).toBe(0);
    expect(clock.authoritativeTime).toBe(0);
    expect(clock.sync(0, false, 1, 120)).toBe(0);
    expect(clock.sample(170)).toBeCloseTo(TIME_SCALE * 0.05);
  });
});
