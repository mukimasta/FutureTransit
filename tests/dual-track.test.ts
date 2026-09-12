import { describe, expect, it } from "vitest";
import { edgeKey, edgeResources, movementResources } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import {
  commitPlan,
  planRelocation,
  planService,
  terminalOwner,
} from "../src/scheduler";
import { TRACK_UPGRADE_COST } from "../src/shared/constants";
import { podPosition } from "../src/shared/selectors";
import { requiredTrajectoryWindows } from "../src/shared/trajectory";
import type { Berth, Pod, Resident, Track, World } from "../src/shared/types";
import { applyCommand, createWorld, stepWorld } from "../src/simulation";

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

const track = (
  id: string,
  a: [number, number],
  b: [number, number],
  lanes?: 1 | 2,
): Track => ({
  id,
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
  paid: 0,
  lanes,
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
  fareSensitivity: 1,
  trips: 0,
});

function world(berths: Berth[], tracks: Track[], pods: Pod[]): World {
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
      cash: 100,
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

function corridor(lanes?: 1 | 2): World {
  const left = berth("left", "parking", [0, 0], [1, 0]);
  const leftTarget = berth("left-target", "parking", [1, 1], [1, 0]);
  const right = berth("right", "parking", [4, 1], [4, 0]);
  const rightTarget = berth("right-target", "parking", [5, 0], [4, 0]);
  return world(
    [left, leftTarget, right, rightTarget],
    [
      track("t1", [1, 0], [2, 0], lanes),
      track("t2", [2, 0], [3, 0], lanes),
      track("t3", [3, 0], [4, 0], lanes),
    ],
    [pod("eastbound", left.id), pod("westbound", right.id)],
  );
}

const overlaps = (
  left: { start: number; end: number },
  right: { start: number; end: number },
) => left.start < right.end - 1e-9 && right.start < left.end - 1e-9;

describe("real dual-track capacity", () => {
  it("allows one Pod in each direction while preserving single-track serialization", () => {
    const single = corridor();
    const singleEast = planRelocation(single, single.pods[0], single.berths[3]);
    expect(singleEast.ok).toBe(true);
    if (!singleEast.ok) return;
    commitPlan(single, singleEast.plan);
    const singleWest = planRelocation(single, single.pods[1], single.berths[1]);
    expect(singleWest.ok).toBe(true);
    if (!singleWest.ok) return;
    const shared = movementResources(single, { x: 2, y: 0 }, { x: 3, y: 0 })[0];
    expect(
      overlaps(
        singleEast.plan.reservations.find(
          (entry) => entry.resource === shared,
        )!,
        singleWest.plan.reservations.find(
          (entry) => entry.resource === shared,
        )!,
      ),
    ).toBe(false);

    const dual = corridor(2);
    const east = planRelocation(dual, dual.pods[0], dual.berths[3]);
    expect(east.ok).toBe(true);
    if (!east.ok) return;
    commitPlan(dual, east.plan);
    const west = planRelocation(dual, dual.pods[1], dual.berths[1]);
    expect(west.ok).toBe(true);
    if (!west.ok) return;
    const eastLane = east.plan.segments.find(s => s.from.x === 2 && s.to.x === 3)!.resources[0];
    const westLane = west.plan.segments.find(s => s.from.x === 3 && s.to.x === 2)!.resources[0];
    expect(eastLane).not.toBe(westLane);
    expect(
      overlaps(
        east.plan.reservations.find((entry) => entry.resource === eastLane)!,
        west.plan.reservations.find((entry) => entry.resource === westLane)!,
      ),
    ).toBe(true);

    const eastMove = east.plan.segments.find(
      (segment) => segment.from.x === 2 && segment.to.x === 3,
    )!;
    const westMove = west.plan.segments.find(
      (segment) => segment.from.x === 3 && segment.to.x === 2,
    )!;
    commitPlan(dual, west.plan);
    expect(podPosition(dual, dual.pods[0], (eastMove.start + eastMove.end) / 2).y)
      .not.toBe(podPosition(dual, dual.pods[1], (westMove.start + westMove.end) / 2).y);
  });

  it("still serializes real diagonal crossings without blocking the opposite lane of one diagonal", () => {
    const firstStart = berth("first-start", "parking", [0, 1], [1, 1]);
    const firstEnd = berth("first-end", "parking", [3, 2], [2, 2]);
    const secondStart = berth("second-start", "parking", [3, 1], [2, 1]);
    const secondEnd = berth("second-end", "parking", [0, 2], [1, 2]);
    const simulation = world(
      [firstStart, firstEnd, secondStart, secondEnd],
      [
        track("positive", [1, 1], [2, 2], 2),
        track("negative", [2, 1], [1, 2], 2),
      ],
      [pod("positive-pod", firstStart.id), pod("negative-pod", secondStart.id)],
    );
    const first = planRelocation(simulation, simulation.pods[0], firstEnd);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(simulation, first.plan);
    const second = planRelocation(simulation, simulation.pods[1], secondEnd);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const common = first.plan.reservations.filter(
      (entry) =>
        entry.resource.startsWith("crossing-") &&
        second.plan.reservations.some(
          (other) => other.resource === entry.resource,
        ),
    );
    expect(common).toHaveLength(1);
    expect(
      overlaps(
        common[0],
        second.plan.reservations.find(
          (entry) => entry.resource === common[0].resource,
        )!,
      ),
    ).toBe(false);
  });
});

describe("dual-track construction transactions", () => {
  it("escrows a running upgrade, drains the old plan, then upgrades without invalidating it", () => {
    const simulation = corridor();
    const candidate = planRelocation(
      simulation,
      simulation.pods[0],
      simulation.berths[3],
    );
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    commitPlan(simulation, candidate.plan);
    const response = applyCommand(simulation, {
      type: "upgrade-tracks",
      ids: ["t2"],
    });
    expect(response.ok).toBe(true);
    expect(simulation.economy.cash).toBe(100 - TRACK_UPGRADE_COST);
    expect(simulation.economy.spent).toBe(0);
    expect(
      simulation.tracks.find((entry) => entry.id === "t2")!.lanes,
    ).not.toBe(2);
    expect(simulation.pendingEdits).toEqual([
      { type: "upgrade-track", id: "t2", paid: TRACK_UPGRADE_COST, targetLanes: 2 },
    ]);

    stepWorld(simulation, candidate.plan.end + 3);
    expect(simulation.pendingEdits).toEqual([]);
    expect(simulation.tracks.find((entry) => entry.id === "t2")!.lanes).toBe(2);
    expect(simulation.tracks.find((entry) => entry.id === "t2")!.paid).toBe(
      TRACK_UPGRADE_COST,
    );
    expect(simulation.economy.spent).toBe(TRACK_UPGRADE_COST);
  });

  it("refunds queued upgrade escrow and keeps batch validation atomic", () => {
    const simulation = corridor();
    const candidate = planRelocation(
      simulation,
      simulation.pods[0],
      simulation.berths[3],
    );
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    commitPlan(simulation, candidate.plan);
    applyCommand(simulation, { type: "upgrade-tracks", ids: ["t2"] });
    expect(applyCommand(simulation, { type: "cancel-edits" }).ok).toBe(true);
    expect(simulation.economy.cash).toBe(100);
    expect(simulation.economy.spent).toBe(0);
    expect(simulation.pendingEdits).toEqual([]);

    const before = structuredClone(simulation);
    expect(
      applyCommand(simulation, {
        type: "upgrade-tracks",
        ids: ["t1", "missing"],
      }).ok,
    ).toBe(false);
    expect(simulation).toEqual(before);
  });

  it("round-trips dual plans and pending legacy-resource upgrades in v1 saves", () => {
    const dual = createWorld(617);
    expect(
      applyCommand(dual, {
        type: "upgrade-tracks",
        ids: dual.tracks.map((entry) => entry.id),
      }).ok,
    ).toBe(true);
    let dualPlan: ReturnType<typeof planRelocation> | undefined;
    for (const currentPod of dual.pods) {
      for (const target of dual.berths) {
        if (target.id === currentPod.berthId) continue;
        const candidate = planRelocation(dual, currentPod, target);
        if (candidate.ok) {
          dualPlan = candidate;
          break;
        }
      }
      if (dualPlan?.ok) break;
    }
    expect(dualPlan?.ok).toBe(true);
    if (!dualPlan?.ok) return;
    commitPlan(dual, dualPlan.plan);
    const restoredDual = parseWorld(serializeWorld(dual));
    expect(restoredDual.tracks.every((entry) => entry.lanes === 2)).toBe(true);
    expect(restoredDual.pods.some((entry) => entry.plan)).toBe(true);

    const legacy = createWorld(619);
    let queued = false;
    for (const currentPod of legacy.pods) {
      for (const target of legacy.berths) {
        if (target.id === currentPod.berthId) continue;
        const candidate = planRelocation(legacy, currentPod, target);
        if (!candidate.ok) continue;
        const used = legacy.tracks.find((entry) =>
          candidate.plan.segments.some(
            (segment) =>
              segment.kind === "move" &&
              edgeKey(segment.from, segment.to) === edgeKey(entry.a, entry.b),
          ),
        );
        if (!used) continue;
        commitPlan(legacy, candidate.plan);
        queued = applyCommand(legacy, {
          type: "upgrade-tracks",
          ids: [used.id],
        }).ok;
        break;
      }
      if (queued) break;
    }
    expect(queued).toBe(true);
    const restoredLegacy = parseWorld(serializeWorld(legacy));
    expect(restoredLegacy.pendingEdits[0]?.type).toBe("upgrade-track");

    const oldStart = berth("old-start", "parking", [0, 1], [1, 1]);
    const oldEnd = berth("old-end", "parking", [3, 2], [2, 2]);
    oldStart.buildingId = "b-home";
    oldEnd.buildingId = "b-home";
    const old = world(
      [oldStart, oldEnd],
      [track("old-diagonal", [1, 1], [2, 2])],
      [pod("old-pod", oldStart.id)],
    );
    old.buildings = [
      {
        id: "b-home",
        name: "Home",
        nameEn: "Home",
        kind: "home",
        x: 10,
        y: 10,
        w: 2,
        h: 2,
        bornAt: 0,
      },
      {
        id: "b-office",
        name: "Office",
        nameEn: "Office",
        kind: "office",
        x: 14,
        y: 10,
        w: 2,
        h: 2,
        bornAt: 0,
      },
      {
        id: "b-shop",
        name: "Shop",
        nameEn: "Shop",
        kind: "shop",
        x: 10,
        y: 14,
        w: 2,
        h: 2,
        bornAt: 0,
      },
    ];
    const oldCandidate = planRelocation(old, old.pods[0], oldEnd);
    expect(oldCandidate.ok).toBe(true);
    if (!oldCandidate.ok) return;
    for (const segment of oldCandidate.plan.segments) {
      if (segment.kind === "move")
        segment.resources = edgeResources(segment.from, segment.to);
    }
    oldCandidate.plan.reservations = requiredTrajectoryWindows(
      old,
      oldCandidate.plan.segments,
    ).map((window) => ({ ...window, ownerId: oldCandidate.plan.podId }));
    commitPlan(old, oldCandidate.plan);
    const restoredOld = parseWorld(serializeWorld(old));
    expect(
      restoredOld.pods[0].plan?.segments.some(
        (segment) =>
          segment.kind === "move" &&
          segment.resources.some((resource) =>
            resource.startsWith("crossing:"),
          ),
      ),
    ).toBe(true);
  });
});

describe("service terminal release", () => {
  it("uses nearby parking so repeated service shares one finite destination platform", () => {
    const pickup = berth("pickup", "platform", [0, 0], [1, 0]);
    const secondOrigin = berth("second-origin", "parking", [1, 1], [1, 0]);
    const dropoff = berth("dropoff", "platform", [6, 0], [5, 0]);
    const parkingOne = berth("parking-one", "parking", [6, 1], [5, 1]);
    const parkingTwo = berth("parking-two", "parking", [6, 2], [5, 2]);
    const simulation = world(
      [pickup, secondOrigin, dropoff, parkingOne, parkingTwo],
      [
        track("m1", [1, 0], [2, 0]),
        track("m2", [2, 0], [3, 0]),
        track("m3", [3, 0], [4, 0]),
        track("m4", [4, 0], [5, 0]),
        track("p1", [5, 0], [5, 1]),
        track("p2", [5, 1], [5, 2]),
      ],
      [pod("first", pickup.id), pod("second", secondOrigin.id)],
    );
    const first = planService(
      simulation,
      simulation.pods[0],
      resident("r1"),
      pickup,
      dropoff,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.plan.finalBerthId).toBe(parkingOne.id);
    commitPlan(simulation, first.plan);
    const second = planService(
      simulation,
      simulation.pods[1],
      resident("r2"),
      pickup,
      dropoff,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plan.finalBerthId).toBe(parkingTwo.id);
    expect(terminalOwner(simulation, dropoff.id)).toBeUndefined();
    const firstVisit = first.plan.reservations.find(
      (entry) => entry.resource === `berth:${dropoff.id}`,
    )!;
    const secondVisit = second.plan.reservations.find(
      (entry) => entry.resource === `berth:${dropoff.id}`,
    )!;
    expect(Number.isFinite(firstVisit.end)).toBe(true);
    expect(overlaps(firstVisit, secondVisit)).toBe(false);
  });
});
