import { describe, expect, it } from "vitest";
import { edgeResources } from "../src/network";
import {
  commitPlan,
  planRelocation,
  planService,
  terminalOwner,
} from "../src/scheduler";
import type {
  Berth,
  Pod,
  Reservation,
  Resident,
  Track,
  World,
} from "../src/shared/types";

function berth(
  id: string,
  kind: Berth["kind"],
  point: [number, number],
  access: [number, number],
): Berth {
  return {
    id,
    buildingId: `building-${id}`,
    kind,
    point: { x: point[0], y: point[1] },
    access: { x: access[0], y: access[1] },
    side: "south",
    paid: 0,
  };
}

function track(id: string, a: [number, number], b: [number, number]): Track {
  return {
    id,
    a: { x: a[0], y: a[1] },
    b: { x: b[0], y: b[1] },
    paid: 0,
  };
}

function pod(id: string, berthId: string): Pod {
  return { id, berthId, parkedSince: 0, plan: null, trips: 0, paid: 0 };
}

function resident(id = "resident-1"): Resident {
  return {
    id,
    name: id,
    color: "#000",
    homeId: "home",
    workId: "work",
    favorites: [],
    atBuildingId: "home",
    nextDeparture: 0,
    nextDestinationId: "work",
    purpose: "work",
    status: "waiting",
    journey: null,
    fareSensitivity: 1,
    trips: 0,
  };
}

function world(berths: Berth[], tracks: Track[], pods: Pod[]): World {
  return {
    version: 1,
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
  };
}

function straightWorld(secondPod = false) {
  const a = berth("a", "platform", [0, 0], [1, 0]);
  const b = berth("b", "platform", [5, 0], [4, 0]);
  const spare = berth("spare", "parking", [1, 2], [1, 1]);
  const tracks = [
    track("t1", [1, 0], [2, 0]),
    track("t2", [2, 0], [3, 0]),
    track("t3", [3, 0], [4, 0]),
    track("ts1", [1, 0], [1, 1]),
  ];
  return {
    a,
    b,
    spare,
    world: world([a, b, spare], tracks, [
      pod("pod-a", "a"),
      ...(secondPod ? [pod("pod-b", "b")] : []),
    ]),
  };
}

function overlap(left: Reservation, right: Reservation): boolean {
  return left.start < right.end && right.start < left.end;
}

describe("scheduler", () => {
  it("plans the full empty, boarding, loaded, alighting trip without mutating the world", () => {
    const fixture = straightWorld();
    const before = structuredClone(fixture.world);
    const result = planService(
      fixture.world,
      fixture.world.pods[0],
      resident(),
      fixture.a,
      fixture.b,
    );

    expect(result.ok).toBe(true);
    expect(fixture.world).toEqual(before);
    if (!result.ok) return;
    expect(result.plan.finalBerthId).toBe("spare");
    expect(
      result.plan.segments.some((segment) => segment.stage === "empty"),
    ).toBe(true);
    expect(
      result.plan.segments.some((segment) => segment.kind === "boarding"),
    ).toBe(true);
    expect(
      result.plan.segments.some((segment) => segment.stage === "loaded"),
    ).toBe(true);
    expect(
      result.plan.segments.some((segment) => segment.kind === "alighting"),
    ).toBe(true);
    expect(result.plan.pickupEnd! - result.plan.pickupStart!).toBe(9);
    expect(result.plan.dropoffEnd! - result.plan.dropoffStart!).toBe(6);
    expect(
      result.plan.reservations.every((reservation) =>
        Number.isFinite(reservation.end),
      ),
    ).toBe(true);
    for (const [index, reservation] of result.plan.reservations.entries()) {
      expect(
        result.plan.reservations
          .slice(index + 1)
          .some(
            (other) =>
              other.resource === reservation.resource &&
              overlap(reservation, other),
          ),
      ).toBe(false);
    }

    commitPlan(fixture.world, result.plan);
    expect(fixture.world.pods[0].berthId).toBe("a");
    expect(terminalOwner(fixture.world, "spare")).toBe("pod-a");
    expect(terminalOwner(fixture.world, "b")).toBeUndefined();
  });

  it("refuses a full destination platform, then succeeds after its Pod relocates to a spare", () => {
    const fixture = straightWorld(true);
    fixture.world.berths.push(berth("return-parking", "parking", [0,1], [1,1]));
    fixture.world.networkVersion++;
    const serviceBefore = structuredClone(fixture.world);
    const blocked = planService(
      fixture.world,
      fixture.world.pods[0],
      resident(),
      fixture.a,
      fixture.b,
    );
    expect(blocked).toEqual({ ok: false, reason: "platform-busy" });
    expect(fixture.world).toEqual(serviceBefore);

    const relocation = planRelocation(
      fixture.world,
      fixture.world.pods[1],
      fixture.spare,
    );
    expect(relocation.ok).toBe(true);
    if (!relocation.ok) return;
    commitPlan(fixture.world, relocation.plan);
    expect(terminalOwner(fixture.world, "spare")).toBe("pod-b");
    expect(terminalOwner(fixture.world, "b")).toBeUndefined();

    const service = planService(
      fixture.world,
      fixture.world.pods[0],
      resident(),
      fixture.a,
      fixture.b,
    );
    expect(service.ok).toBe(true);
  });

  it("serializes opposing traffic on the same undirected edge", () => {
    const a = berth("a", "parking", [0, 0], [1, 0]);
    const b = berth("b", "parking", [5, 0], [4, 0]);
    const c = berth("c", "parking", [5, 1], [4, 0]);
    const d = berth("d", "parking", [0, 1], [1, 0]);
    const simulation = world(
      [a, b, c, d],
      [
        track("t1", [1, 0], [2, 0]),
        track("t2", [2, 0], [3, 0]),
        track("t3", [3, 0], [4, 0]),
      ],
      [pod("one", "a"), pod("two", "c")],
    );
    const first = planRelocation(simulation, simulation.pods[0], b);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(simulation, first.plan);
    const second = planRelocation(simulation, simulation.pods[1], d);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const shared = edgeResources({ x: 2, y: 0 }, { x: 3, y: 0 })[0];
    const firstSlot = first.plan.reservations.find(
      (entry) => entry.resource === shared,
    )!;
    const secondSlot = second.plan.reservations.find(
      (entry) => entry.resource === shared,
    )!;
    expect(overlap(firstSlot, secondSlot)).toBe(false);
    expect(secondSlot.start).toBeGreaterThanOrEqual(firstSlot.end);
  });

  it("serializes opposite diagonals through their shared crossing resource", () => {
    const a = berth("a", "parking", [0, 0], [1, 1]);
    const b = berth("b", "parking", [3, 3], [2, 2]);
    const c = berth("c", "parking", [3, 0], [2, 1]);
    const d = berth("d", "parking", [0, 3], [1, 2]);
    const simulation = world(
      [a, b, c, d],
      [track("diag-1", [1, 1], [2, 2]), track("diag-2", [2, 1], [1, 2])],
      [pod("one", "a"), pod("two", "c")],
    );
    const first = planRelocation(simulation, simulation.pods[0], b);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(simulation, first.plan);
    const second = planRelocation(simulation, simulation.pods[1], d);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const crossing = first.plan.reservations.find(entry => entry.resource.startsWith("crossing-") && second.plan.reservations.some(other => other.resource === entry.resource))!.resource;
    const firstSlot = first.plan.reservations.find(
      (entry) => entry.resource === crossing,
    )!;
    const secondSlot = second.plan.reservations.find(
      (entry) => entry.resource === crossing,
    )!;
    expect(overlap(firstSlot, secondSlot)).toBe(false);
  });

  it("uses a bounded planning horizon and leaves failures atomic", () => {
    const fixture = straightWorld();
    fixture.world.reservations.push({
      resource: edgeResources({ x: 1, y: 0 }, { x: 2, y: 0 })[0],
      start: 0,
      end: 1_801,
      ownerId: "blocker",
    });
    const before = structuredClone(fixture.world);
    const result = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(result).toEqual({ ok: false, reason: "track-busy" });
    expect(fixture.world).toEqual(before);
  });

  it("places a durable final commitment after every previously booked berth visit", () => {
    const fixture = straightWorld();
    fixture.world.reservations.push({
      resource: "berth:b",
      start: 100,
      end: 110,
      ownerId: "earlier-plan",
    });
    const result = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.end).toBeGreaterThanOrEqual(110);
  });

  it("rejects stale commits without publishing partial reservations", () => {
    const fixture = straightWorld();
    const result = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    fixture.world.pods[0].berthId = "spare";
    const before = structuredClone(fixture.world.reservations);
    expect(() => commitPlan(fixture.world, result.plan)).toThrow(
      /no longer at origin berth/,
    );
    expect(fixture.world.reservations).toEqual(before);
    expect(fixture.world.pods[0].plan).toBeNull();
  });

  it("rechecks concurrent terminal candidates at commit time", () => {
    const a = berth("a", "parking", [0, 0], [1, 0]);
    const c = berth("c", "parking", [0, 1], [1, 0]);
    const b = berth("b", "parking", [4, 0], [3, 0]);
    const simulation = world(
      [a, b, c],
      [track("t1", [1, 0], [2, 0]), track("t2", [2, 0], [3, 0])],
      [pod("one", "a"), pod("two", "c")],
    );
    const first = planRelocation(simulation, simulation.pods[0], b);
    const second = planRelocation(simulation, simulation.pods[1], b);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    commitPlan(simulation, first.plan);
    const reservationCount = simulation.reservations.length;
    expect(() => commitPlan(simulation, second.plan)).toThrow(
      /final berth b is committed/,
    );
    expect(simulation.reservations).toHaveLength(reservationCount);
    expect(simulation.pods[1].plan).toBeNull();
  });
});
