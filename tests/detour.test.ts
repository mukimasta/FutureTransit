import { describe, expect, it } from "vitest";
import { findTrackPathOptions, trackResources } from "../src/network";
import { commitPlan, planService, planningNetwork } from "../src/scheduler";
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

function boundedWorld(): World {
  const w = ladder();
  // A return-to-origin-only fixture must cross the blocked corridor again on
  // its shortest parking leg. Provide parking at the far end for a legal tail.
  w.berths.push(berth("P2", "parking", [11, 0], [11, 1]));
  w.tracks.push(track([11, 1], [11, 2]));
  return w;
}

describe("dispatch around a busy route", () => {
  it("finds a detour even when the shortest route cannot fit the window", () => {
    const w = boundedWorld();
    const { pickup, dropoff } = platforms(w);
    const blocked = w.tracks.find((t) => t.a.x === 6 && t.a.y === 2)!;
    w.reservations = trackResources(w, blocked).map((resource) => ({
      resource,
      ownerId: "busy",
      start: 0,
      end: 10_000,
    }));
    const result = planService(w, w.pods[0], resident("r"), pickup, dropoff);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.plan.segments.some(
          (s) => s.stage === "loaded" && s.from.y === 3,
        ),
      ).toBe(true);
      expect(() => commitPlan(w, result.plan)).not.toThrow();
    }
  });

  it("excludes pending tracks before planning, leaves existing plans intact, and restores cancelled routes", () => {
    const w = ladder();
    firstPlanCommitted(w);
    const existing = structuredClone(w.pods[0].plan);
    const { pickup, dropoff } = platforms(w);
    const blocked = w.tracks.find((t) => t.a.x === 6 && t.a.y === 2)!;
    const open = planningNetwork(w);
    w.pendingEdits.push({ type: "remove-track", id: blocked.id });
    expect(planningNetwork(w)).not.toBe(open);
    const result = planService(w, w.pods[1], resident("r"), pickup, dropoff);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const forbidden = new Set(trackResources(w, blocked));
      expect(
        result.plan.reservations.some((r) => forbidden.has(r.resource)),
      ).toBe(false);
      expect(
        result.plan.segments.some((s) =>
          [s.from, s.to].some((p) => p.y === 2 && (p.x === 6 || p.x === 7)),
        ),
      ).toBe(false);
    }
    expect(w.pods[0].plan).toEqual(existing);
    w.pendingEdits.length = 0;
    expect(planningNetwork(w)).toBe(w);
    expect(
      findTrackPathOptions(
        planningNetwork(w),
        pickup.point,
        dropoff.point,
      )[0].some((p) => p.x === 6 && p.y === 2),
    ).toBe(true);
  });

  it("bounded searches preserve the unbounded winner and do not cache cutoff failure as impossibility", () => {
    for (const end of [0, 40, 120, 400, 1_700, 10_000]) {
      const w = boundedWorld();
      const { pickup, dropoff } = platforms(w);
      const busy = w.tracks.find((t) => t.a.x === 6 && t.a.y === 2)!;
      w.reservations = trackResources(w, busy).map((resource) => ({
        resource,
        ownerId: "busy",
        start: 0,
        end,
      }));
      const rider = resident("r");
      expect(planService(w, w.pods[0], rider, pickup, dropoff, 1).ok).toBe(
        false,
      );
      const full = planService(w, w.pods[0], rider, pickup, dropoff);
      expect(full.ok).toBe(true);
      if (!full.ok) continue;
      for (const margin of [-1, 0, 0.01, 20, 200]) {
        const bounded = planService(
          w,
          w.pods[0],
          rider,
          pickup,
          dropoff,
          full.plan.dropoffEnd! + margin,
        );
        expect(bounded.ok).toBe(margin > 0);
        if (bounded.ok) expect(bounded.plan).toEqual(full.plan);
      }
    }
  });

  it("shares calendars without retaining own blocks or discarding another owner's blocks", () => {
    const w = boundedWorld();
    const { pickup, dropoff } = platforms(w);
    const busy = w.tracks.find((t) => t.a.x === 6 && t.a.y === 2)!;
    const resource = trackResources(w, busy)[0];
    w.reservations = [
      { resource, ownerId: w.pods[0].id, start: 0, end: 10_000 },
      { resource, ownerId: "other", start: 0, end: 120 },
    ];
    // Independent reference: remove own reservations before any cache exists.
    const reference = structuredClone(w);
    reference.reservations = reference.reservations.filter(
      (r) => r.ownerId !== w.pods[0].id,
    );
    const expected = planService(
      reference,
      reference.pods[0],
      resident("r"),
      pickup,
      dropoff,
    );
    const actual = planService(w, w.pods[0], resident("r"), pickup, dropoff);
    expect(actual).toEqual(expected);
    const second = planService(w, w.pods[1], resident("r2"), pickup, dropoff);
    expect(second.ok).toBe(true);
    if (second.ok)
      expect(
        second.plan.segments.some(
          (s) => s.stage === "loaded" && s.from.y === 3,
        ),
      ).toBe(true);
    // Same-array additions must invalidate a previously successful service.
    w.reservations.push({
      resource: `berth:${pickup.id}`,
      ownerId: "other",
      start: 0,
      end: 10_000,
    });
    expect(planService(w, w.pods[0], resident("r"), pickup, dropoff).ok).toBe(
      false,
    );
  });

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
