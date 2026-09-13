import { describe, expect, it } from "vitest";
import { findTrackPathOptions } from "../src/network";
import { commitPlan, planService } from "../src/scheduler";
import type { Berth, Pod, Resident, Track, World } from "../src/shared/types";

const berth = (
  id: string,
  kind: Berth["kind"],
  point: [number, number],
  access: [number, number],
): Berth => ({
  id,
  buildingId: `building-${id}`,
  kind,
  point: { x: point[0], y: point[1] },
  access: { x: access[0], y: access[1] },
  side: "south",
  paid: 0,
});

const track = (a: [number, number], b: [number, number]): Track => ({
  id: `t:${a.join(",")}~${b.join(",")}`,
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
  paid: 0,
  lanes: 1,
});

const pod = (id: string, berthId: string): Pod => ({
  id,
  berthId,
  parkedSince: 0,
  plan: null,
  trips: 0,
  paid: 0,
});

const resident = (id: string): Resident => ({
  id,
  name: id,
  color: "#112233",
  homeId: "home",
  workId: "work",
  favorites: [],
  atBuildingId: null,
  nextDeparture: 0,
  nextDestinationId: "work",
  purpose: "work",
  status: "waiting",
  journey: null,
  fareSensitivity: 0,
  trips: 0,
});

function world(berths: Berth[], tracks: Track[], pods: Pod[]): World {
  return {
    version: 2,
    resourceModel: 2,
    seed: 1,
    rng: 1,
    time: 0,
    paused: false,
    speed: 1,
    width: 16,
    height: 8,
    nextId: 1,
    networkVersion: 1,
    buildings: [],
    berths,
    tracks,
    residents: [],
    pods,
    reservations: [],
    economy: {
      cash: 1_000_000,
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
  } as unknown as World;
}

/** Two parallel lanes of track joined at both ends: a genuine second way. */
function ladder(): World {
  const tracks: Track[] = [];
  for (let x = 1; x < 12; x += 1) {
    tracks.push(track([x, 2], [x + 1, 2]));
    tracks.push(track([x, 3], [x + 1, 3]));
  }
  tracks.push(track([1, 2], [1, 3]));
  tracks.push(track([12, 2], [12, 3]));
  tracks.push(track([2, 2], [2, 1]));
  tracks.push(track([3, 2], [3, 1]));
  return world(
    [
      berth("A", "platform", [0, 2], [1, 2]),
      berth("B", "platform", [13, 2], [12, 2]),
      berth("P0", "parking", [2, 0], [2, 1]),
      berth("P1", "parking", [3, 0], [3, 1]),
    ],
    tracks,
    [pod("first", "P0"), pod("second", "P1")],
  );
}

/** The same trip with the second lane taken away. */
function corridor(): World {
  const built = ladder();
  return {
    ...built,
    tracks: built.tracks.filter(
      (candidate) => candidate.a.y !== 3 && candidate.b.y !== 3,
    ),
  };
}

const platforms = (w: World) => ({
  pickup: w.berths.find((b) => b.id === "A")!,
  dropoff: w.berths.find((b) => b.id === "B")!,
});

function firstPlanCommitted(w: World) {
  const { pickup, dropoff } = platforms(w);
  const plan = planService(w, w.pods[0], resident("rider-1"), pickup, dropoff);
  expect(plan.ok).toBe(true);
  if (plan.ok) commitPlan(w, plan.plan);
}

describe("dispatch around a busy route", () => {
  it("offers the longer way round only where the rails provide one", () => {
    const { pickup, dropoff } = platforms(ladder());
    expect(
      findTrackPathOptions(ladder(), pickup.point, dropoff.point).length,
    ).toBeGreaterThan(1);
    expect(
      findTrackPathOptions(corridor(), pickup.point, dropoff.point),
    ).toHaveLength(1);
  });

  it("sends the second Pod down the other lane instead of making it wait", () => {
    const w = ladder();
    firstPlanCommitted(w);
    const { pickup, dropoff } = platforms(w);
    const second = planService(
      w,
      w.pods[1],
      resident("rider-2"),
      pickup,
      dropoff,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const loaded = second.plan.segments.filter(
      (segment) => segment.stage === "loaded" && segment.kind === "move",
    );
    expect(loaded.some((segment) => segment.from.y === 3)).toBe(true);

    // Queueing behind the direct lane is what it replaces, so it must beat it.
    const single = corridor();
    firstPlanCommitted(single);
    const queued = planService(
      single,
      single.pods[1],
      resident("rider-2"),
      pickup,
      dropoff,
    );
    expect(queued.ok).toBe(true);
    if (queued.ok)
      expect(second.plan.dropoffEnd!).toBeLessThan(queued.plan.dropoffEnd!);
  });

  it("still takes the direct lane when nothing is in the way", () => {
    const w = ladder();
    const { pickup, dropoff } = platforms(w);
    const only = planService(
      w,
      w.pods[0],
      resident("rider-1"),
      pickup,
      dropoff,
    );
    expect(only.ok).toBe(true);
    if (!only.ok) return;
    expect(only.plan.departure).toBe(0);
    const loaded = only.plan.segments.filter(
      (segment) => segment.stage === "loaded" && segment.kind === "move",
    );
    expect(loaded.every((segment) => segment.from.y === 2)).toBe(true);
  });

  it("leaves a single-lane corridor scheduling exactly as it was", () => {
    const w = corridor();
    firstPlanCommitted(w);
    const { pickup, dropoff } = platforms(w);
    const second = planService(
      w,
      w.pods[1],
      resident("rider-2"),
      pickup,
      dropoff,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plan.departure).toBeGreaterThan(0);
    const loaded = second.plan.segments.filter(
      (segment) => segment.stage === "loaded" && segment.kind === "move",
    );
    expect(loaded.every((segment) => segment.from.y === 2)).toBe(true);
  });
});
