import { describe, expect, it } from "vitest";
import { buildingDoor, edgeResources, findWalkPath } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import { commitPlan, planRelocation, planService } from "../src/scheduler";
import { CLEARANCE_SECONDS } from "../src/shared/constants";
import { podPosition, residentPosition } from "../src/shared/selectors";
import type {
  Berth,
  Journey,
  MotionSegment,
  Pod,
  Reservation,
  Resident,
  ServicePlan,
  Track,
  World,
} from "../src/shared/types";
import {
  applyCommand,
  capacityValid,
  createWorld,
  stepWorld,
} from "../src/simulation";

interface PhysicalBlock {
  resource: string;
  start: number;
  end: number;
  ownerId: string;
}

const overlaps = (left: PhysicalBlock, right: PhysicalBlock) =>
  left.start < right.end - 1e-9 && right.start < left.end - 1e-9;

/** Reconstruct occupancy from motion and terminal state, never from World.reservations. */
function physicalBlocks(world: World): PhysicalBlock[] {
  return world.pods.flatMap((pod): PhysicalBlock[] => {
    if (!pod.plan) {
      return pod.berthId
        ? [
            {
              resource: `berth:${pod.berthId}`,
              start: world.time,
              end: Infinity,
              ownerId: pod.id,
            },
          ]
        : [];
    }
    const plan = pod.plan;
    const blocks = plan.segments
      .flatMap((segment) =>
        segment.resources.map((resource) => ({
          resource,
          start: Math.max(world.time, segment.start),
          end: segment.end + CLEARANCE_SECONDS,
          ownerId: pod.id,
        })),
      )
      .filter((block) => block.end > world.time);
    if (plan.departure > world.time) {
      blocks.push({
        resource: `berth:${plan.originBerthId}`,
        start: world.time,
        end: plan.departure,
        ownerId: pod.id,
      });
    }
    blocks.push({
      resource: `berth:${plan.finalBerthId}`,
      start: plan.end,
      end: Infinity,
      ownerId: pod.id,
    });
    return blocks;
  });
}

function expectPhysicalExclusion(world: World): void {
  const byResource = new Map<string, PhysicalBlock[]>();
  for (const block of physicalBlocks(world)) {
    const entries = byResource.get(block.resource) ?? [];
    entries.push(block);
    byResource.set(block.resource, entries);
  }
  const collisions: string[] = [];
  for (const [resource, entries] of byResource) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        if (
          entries[left].ownerId !== entries[right].ownerId &&
          overlaps(entries[left], entries[right])
        ) {
          collisions.push(
            `${resource}:${entries[left].ownerId}/${entries[right].ownerId}`,
          );
        }
      }
    }
  }
  expect(collisions).toEqual([]);
}

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

function opposingTrafficWorld() {
  const a = berth("a", "parking", [0, 0], [1, 0]);
  const b = berth("b", "parking", [5, 0], [4, 0]);
  const c = berth("c", "parking", [5, 1], [4, 0]);
  const d = berth("d", "parking", [0, 1], [1, 0]);
  const world = schedulerWorld(
    [a, b, c, d],
    [
      track("one", [1, 0], [2, 0]),
      track("two", [2, 0], [3, 0]),
      track("three", [3, 0], [4, 0]),
    ],
    [pod("eastbound", "a"), pod("westbound", "c")],
  );
  return { a, b, c, d, world };
}

function connectOffice(world: World): { home: Berth; office: Berth } {
  const added = applyCommand(world, {
    type: "add-berth",
    buildingId: "b-office",
    kind: "platform",
    side: "west",
  });
  if (!added.ok) throw new Error(added.messageEn);
  const home = world.berths.find(
    (candidate) =>
      candidate.buildingId === "b-home" && candidate.kind === "platform",
  )!;
  const office = world.berths.find(
    (candidate) =>
      candidate.buildingId === "b-office" && candidate.kind === "platform",
  )!;
  const built = applyCommand(world, {
    type: "build-track",
    points: [{ x: 10, y: 16 }, { x: office.access.x, y: 16 }, office.access],
  });
  if (!built.ok) throw new Error(built.messageEn);
  return { home, office };
}

function waitingJourney(
  resident: Resident,
  originId: string,
  destinationId: string,
  pickupId: string,
  dropoffId: string,
  time: number,
): Journey {
  return {
    originId,
    destinationId,
    startedAt: time,
    walkBaseline: 2_000,
    purpose: resident.purpose,
    mode: "pod",
    stage: "queue",
    pickupId,
    dropoffId,
    waitReason: "no-pod",
    waited: 0,
  };
}

/** Exactly two platforms, one parking berth, one Pod, and one waiting person. */
function limitedRecoveryWorld(): {
  world: World;
  home: Berth;
  office: Berth;
  parking: Berth;
} {
  const world = createWorld(41);
  const originalPod = world.pods[0];
  const originalParking = world.berths.find(
    (candidate) => candidate.id === originalPod.berthId,
  )!;
  const originalHome = world.berths.find(
    (candidate) =>
      candidate.buildingId === "b-home" && candidate.kind === "platform",
  )!;
  world.pods = [originalPod];
  world.berths = [originalParking, originalHome];
  const { home, office } = connectOffice(world);
  const resident = world.residents[0];
  world.residents = [resident];
  resident.atBuildingId = null;
  resident.status = "waiting";
  resident.nextDestinationId = "b-office";
  resident.purpose = "work";
  resident.journey = waitingJourney(
    resident,
    "b-home",
    "b-office",
    home.id,
    office.id,
    world.time,
  );
  originalPod.berthId = office.id;
  originalPod.parkedSince = world.time;
  world.growth.enabled = false;
  world.growth.nextAt = 1e9;
  world.economy.nextGrantAt = 1e9;
  world.paused = false;
  return { world, home, office, parking: originalParking };
}

function activeServiceWorld(): World {
  const world = createWorld(73);
  const { home, office } = connectOffice(world);
  const resident = world.residents[0];
  const candidate = planService(world, world.pods[0], resident, home, office);
  if (!candidate.ok) throw new Error(candidate.reason);
  resident.atBuildingId = null;
  resident.status = "waiting";
  resident.journey = waitingJourney(
    resident,
    "b-home",
    "b-office",
    home.id,
    office.id,
    world.time,
  );
  resident.journey.podId = candidate.plan.podId;
  resident.journey.waitReason = "awaiting-pickup";
  commitPlan(world, candidate.plan);
  return world;
}

function segmentReservations(plan: ServicePlan): Reservation[] {
  return plan.segments.flatMap((segment) =>
    segment.resources.map((resource) => ({
      resource,
      start: segment.start,
      end: segment.end + CLEARANCE_SECONDS,
      ownerId: plan.podId,
    })),
  );
}

function shortenSegment(
  plan: ServicePlan,
  index: number,
  duration: number,
): void {
  const segment = plan.segments[index];
  const oldEnd = segment.end;
  const delta = oldEnd - segment.start - duration;
  segment.end = segment.start + duration;
  for (const later of plan.segments.slice(index + 1)) {
    later.start -= delta;
    later.end -= delta;
  }
  for (const key of [
    "pickupStart",
    "pickupEnd",
    "dropoffStart",
    "dropoffEnd",
  ] as const) {
    const value = plan[key];
    if (value !== undefined && value >= oldEnd - 1e-9)
      plan[key] = value - delta;
  }
  plan.end -= delta;
  plan.reservations = segmentReservations(plan);
}

function passengerize(
  plan: ServicePlan,
  residentId: string,
  berthId: string,
): void {
  const duration = plan.end - plan.departure;
  plan.residentId = residentId;
  plan.pickupId = berthId;
  plan.dropoffId = berthId;
  plan.pickupStart = plan.departure;
  plan.pickupEnd = plan.departure + duration * 0.2;
  plan.dropoffStart = plan.departure + duration * 0.6;
  plan.dropoffEnd = plan.departure + duration * 0.8;
}

describe("adversarial physical scheduling", () => {
  it("serializes real opposing motion when occupancy is rebuilt only from trajectories", () => {
    const fixture = opposingTrafficWorld();
    const first = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(fixture.world, first.plan);
    const second = planRelocation(
      fixture.world,
      fixture.world.pods[1],
      fixture.d,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    commitPlan(fixture.world, second.plan);

    expectPhysicalExclusion(fixture.world);
    const sharedEdge = edgeResources({ x: 2, y: 0 }, { x: 3, y: 0 })[0];
    const physical = physicalBlocks(fixture.world).filter(
      (block) => block.resource === sharedEdge,
    );
    expect(physical.map((block) => block.ownerId).sort()).toEqual([
      "eastbound",
      "westbound",
    ]);
    expect(overlaps(physical[0], physical[1])).toBe(false);
  });

  it("treats the finite calendar plus final berth as an infinite physical tail promise", () => {
    const fixture = opposingTrafficWorld();
    const first = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(fixture.world, first.plan);

    expect(
      fixture.world.reservations.every((reservation) =>
        Number.isFinite(reservation.end),
      ),
    ).toBe(true);
    expect(
      physicalBlocks(fixture.world).some(
        (block) =>
          block.resource === `berth:${fixture.b.id}` &&
          block.ownerId === fixture.world.pods[0].id &&
          block.end === Infinity,
      ),
    ).toBe(true);
    expect(
      planRelocation(fixture.world, fixture.world.pods[1], fixture.b),
    ).toEqual({
      ok: false,
      reason: "parking-full",
    });
  });

  it("recovers service with exactly two platforms and one parking berth", () => {
    const { world, parking } = limitedRecoveryWorld();
    expect(capacityValid(world)).toBe(true);
    let sawEmptyPickupFromDestination = false;
    let sawPassengerService = false;

    for (
      let seconds = 0;
      seconds < 600 && world.metrics.served === 0;
      seconds += 1
    ) {
      stepWorld(world, 1);
      sawEmptyPickupFromDestination ||= world.pods.some(
        (candidate) =>
          candidate.plan !== null &&
          candidate.plan.residentId !== null &&
          candidate.plan.originBerthId !== candidate.plan.pickupId &&
          candidate.plan.segments.some(
            (segment) => segment.stage === "empty" && segment.kind === "move",
          ),
      );
      sawPassengerService ||= world.pods.some(
        (candidate) => candidate.plan?.residentId !== null,
      );
      expectPhysicalExclusion(world);
    }

    expect(sawEmptyPickupFromDestination).toBe(true);
    expect(sawPassengerService).toBe(true);
    expect(world.metrics.served).toBe(1);
    expect(world.residents[0].atBuildingId).toBe("b-office");
    // Delivery finishes before the empty return to its reserved parking berth.
    expect(world.pods[0].plan?.finalBerthId ?? world.pods[0].berthId).toBe(
      parking.id,
    );
    const returnEnd = world.pods[0].plan?.end ?? world.time;
    stepWorld(world, Math.max(0, Math.ceil(returnEnd - world.time)));
    expect(world.pods[0].berthId).toBe(parking.id);
    expect(world.berths.some((candidate) => candidate.id === parking.id)).toBe(
      true,
    );
  });
});

describe("adversarial edit transactions", () => {
  it("drains an in-transit track before removing it", () => {
    const fixture = opposingTrafficWorld();
    fixture.world.pods = [fixture.world.pods[0]];
    const relocation = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(relocation.ok).toBe(true);
    if (!relocation.ok) return;
    commitPlan(fixture.world, relocation.plan);
    const middleTrack = fixture.world.tracks.find(
      (candidate) => candidate.id === "two",
    )!;
    const trackCount = fixture.world.tracks.length;

    expect(
      applyCommand(fixture.world, { type: "remove-track", id: middleTrack.id })
        .ok,
    ).toBe(true);
    expect(fixture.world.pendingEdits).toEqual([
      { type: "remove-track", id: middleTrack.id },
    ]);
    stepWorld(
      fixture.world,
      Math.max(1, Math.floor(relocation.plan.end - fixture.world.time) - 1),
    );
    expect(fixture.world.tracks).toHaveLength(trackCount);
    expectPhysicalExclusion(fixture.world);

    stepWorld(fixture.world, 3);
    expect(fixture.world.pendingEdits).toEqual([]);
    expect(
      fixture.world.tracks.some((candidate) => candidate.id === middleTrack.id),
    ).toBe(false);
    expect(fixture.world.pods[0].berthId).toBe(fixture.b.id);
  });

  it("drains a berth used by an active plan before moving it", () => {
    const { world, office, parking } = limitedRecoveryWorld();
    world.residents[0].status = "inside";
    world.residents[0].atBuildingId = "b-home";
    world.residents[0].journey = null;
    const relocation = planRelocation(world, world.pods[0], parking);
    expect(relocation.ok).toBe(true);
    if (!relocation.ok) return;
    commitPlan(world, relocation.plan);
    const oldPoint = { ...office.point };

    expect(
      applyCommand(world, { type: "move-berth", id: office.id, side: "east" })
        .ok,
    ).toBe(true);
    stepWorld(
      world,
      Math.max(1, Math.floor(relocation.plan.end - world.time) - 1),
    );
    expect(
      world.berths.find((candidate) => candidate.id === office.id)?.point,
    ).toEqual(oldPoint);
    expectPhysicalExclusion(world);

    stepWorld(world, 3);
    expect(world.pendingEdits).toEqual([]);
    expect(
      world.berths.find((candidate) => candidate.id === office.id)?.point,
    ).not.toEqual(oldPoint);
    expect(world.pods[0].berthId).toBe(parking.id);
  });

  it("does not touch track or berth geometry while an edit is queued, and cancellation is durable", () => {
    const { world, office, parking } = limitedRecoveryWorld();
    world.residents[0].status = "inside";
    world.residents[0].atBuildingId = "b-home";
    world.residents[0].journey = null;
    const relocation = planRelocation(world, world.pods[0], parking);
    expect(relocation.ok).toBe(true);
    if (!relocation.ok) return;
    commitPlan(world, relocation.plan);
    const usedTrack = world.tracks.find((candidate) =>
      relocation.plan.reservations.some((reservation) =>
        edgeResources(candidate.a, candidate.b).includes(reservation.resource),
      ),
    )!;
    const officePoint = { ...office.point };
    const trackCount = world.tracks.length;

    expect(
      applyCommand(world, { type: "remove-track", id: usedTrack.id }).ok,
    ).toBe(true);
    expect(
      applyCommand(world, { type: "move-berth", id: office.id, side: "east" })
        .ok,
    ).toBe(true);
    expect(world.tracks).toHaveLength(trackCount);
    expect(office.point).toEqual(officePoint);
    expect(world.pendingEdits).toHaveLength(2);

    expect(applyCommand(world, { type: "cancel-edits" }).ok).toBe(true);
    expect(world.pendingEdits).toEqual([]);
    stepWorld(world, Math.ceil(relocation.plan.end - world.time) + 5);
    expect(
      world.tracks.some((candidate) => candidate.id === usedTrack.id),
    ).toBe(true);
    expect(
      world.berths.find((candidate) => candidate.id === office.id)?.point,
    ).toEqual(officePoint);
  });

  it("leaves the complete world unchanged when a capacity-breaking edit fails", () => {
    const world = createWorld(19);
    const keptPod = world.pods[0];
    const occupied = world.berths.find(
      (candidate) => candidate.id === keptPod.berthId,
    )!;
    const spare = world.berths.find(
      (candidate) => candidate.kind === "platform",
    )!;
    world.pods = [keptPod];
    world.berths = [occupied, spare];
    const before = structuredClone(world);

    const outcome = applyCommand(world, { type: "remove-berth", id: spare.id });

    expect(outcome.ok).toBe(false);
    expect(world).toEqual(before);
  });

  it("rejects a plan whose trajectory has no reservations without partial publication", () => {
    const fixture = opposingTrafficWorld();
    const candidate = planRelocation(
      fixture.world,
      fixture.world.pods[0],
      fixture.b,
    );
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const forged = { ...candidate.plan, reservations: [] };
    const before = structuredClone(fixture.world);

    expect(() => commitPlan(fixture.world, forged)).toThrow(
      /trajectory|reservation/i,
    );
    expect(fixture.world).toEqual(before);
  });
});

describe("adversarial save validation and replay", () => {
  it("accepts and restores a legal plan whose departure is delayed by traffic", () => {
    let scenario: { world: World; delayed: ServicePlan } | undefined;
    for (let firstPod = 0; firstPod < 4 && !scenario; firstPod += 1) {
      for (
        let firstTarget = 0;
        firstTarget < 6 && !scenario;
        firstTarget += 1
      ) {
        const world = createWorld(151);
        const first = planRelocation(
          world,
          world.pods[firstPod],
          world.berths[firstTarget],
        );
        if (!first.ok) continue;
        commitPlan(world, first.plan);
        for (const secondPod of world.pods.filter(
          (candidate) => candidate.plan === null,
        )) {
          for (const target of world.berths) {
            const delayed = planRelocation(world, secondPod, target);
            if (!delayed.ok || delayed.plan.departure <= world.time) continue;
            commitPlan(world, delayed.plan);
            scenario = { world, delayed: delayed.plan };
            break;
          }
          if (scenario) break;
        }
      }
    }
    expect(scenario).toBeDefined();
    if (!scenario) return;

    const restored = parseWorld(serializeWorld(scenario.world));
    expect(
      restored.pods.find((candidate) => candidate.id === scenario.delayed.podId)
        ?.plan,
    ).toEqual(scenario.delayed);
    expectPhysicalExclusion(restored);
  });

  it("restores exact in-motion identities, positions, and deterministic future", () => {
    const world = limitedRecoveryWorld().world;
    let activeSegment: MotionSegment | undefined;
    for (let seconds = 0; seconds < 300 && !activeSegment; seconds += 1) {
      stepWorld(world, 1);
      activeSegment = world.pods[0].plan?.segments.find(
        (segment) =>
          segment.stage === "loaded" &&
          segment.kind === "move" &&
          segment.start <= world.time &&
          world.time < segment.end,
      );
    }
    expect(activeSegment).toBeDefined();
    const podBefore = podPosition(world, world.pods[0]);
    const residentBefore = residentPosition(world, world.residents[0]);

    const restored = parseWorld(serializeWorld(world));
    expect(restored.paused).toBe(true);
    expect(podPosition(restored, restored.pods[0])).toEqual(podBefore);
    expect(residentPosition(restored, restored.residents[0])).toEqual(
      residentBefore,
    );
    restored.paused = false;

    for (let seconds = 0; seconds < 120; seconds += 1) {
      stepWorld(world, 1);
      stepWorld(restored, 1);
      expect(podPosition(restored, restored.pods[0])).toEqual(
        podPosition(world, world.pods[0]),
      );
      expect(residentPosition(restored, restored.residents[0])).toEqual(
        residentPosition(world, world.residents[0]),
      );
      expectPhysicalExclusion(restored);
    }
    expect(restored).toEqual(world);
  });

  it("rejects a save missing the required Journey purpose", () => {
    const world = createWorld(5);
    const resident = world.residents[0];
    const home = world.buildings.find(
      (building) => building.id === resident.homeId,
    )!;
    const destination = world.buildings.find(
      (building) => building.id === resident.nextDestinationId,
    )!;
    const path = findWalkPath(
      world,
      buildingDoor(home),
      buildingDoor(destination),
    )!;
    resident.atBuildingId = null;
    resident.status = "walking";
    resident.journey = {
      originId: home.id,
      destinationId: destination.id,
      startedAt: 0,
      walkBaseline: 10,
      purpose: resident.purpose,
      mode: "walk",
      stage: "direct",
      walk: { path, start: 0, end: 10 },
    };
    const forged = JSON.parse(serializeWorld(world)) as {
      world: { residents: Array<{ journey: Record<string, unknown> }> };
    };
    delete forged.world.residents[0].journey.purpose;

    expect(() => parseWorld(JSON.stringify(forged))).toThrow(
      /purpose|required|invalid/i,
    );
  });

  it("rejects a nextId that will collide with an existing generated identity", () => {
    const world = createWorld(11);
    const existingSuffix = Number(world.berths[0].id.split("-").at(-1));
    world.nextId = existingSuffix;

    expect(() => parseWorld(serializeWorld(world))).toThrow(
      /identity|nextId|duplicate/i,
    );
  });

  it("rejects an adjacent but physically impossible over-speed Pod trajectory", () => {
    const world = activeServiceWorld();
    const plan = world.pods.find((candidate) => candidate.plan)?.plan!;
    const moveIndex = plan.segments.findIndex(
      (segment) => segment.kind === "move" && segment.stage === "loaded",
    );
    expect(moveIndex).toBeGreaterThanOrEqual(0);
    shortenSegment(plan, moveIndex, 0.001);
    world.reservations = segmentReservations(plan);

    expect(() => parseWorld(serializeWorld(world))).toThrow(
      /speed|duration|trajectory/i,
    );
  });

  it("rejects two Pod plans claiming the same resident while that resident is still inside", () => {
    const world = createWorld(101);
    const free = world.berths.filter(
      (candidate) => !world.pods.some((pod) => pod.berthId === candidate.id),
    );
    const first = planRelocation(world, world.pods[0], free[0]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitPlan(world, first.plan);
    const second = planRelocation(world, world.pods[1], free[1]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    commitPlan(world, second.plan);
    const resident = world.residents[0];
    const platform = world.berths.find(
      (candidate) => candidate.kind === "platform",
    )!;
    passengerize(world.pods[0].plan!, resident.id, platform.id);
    passengerize(world.pods[1].plan!, resident.id, platform.id);

    expect(() => parseWorld(serializeWorld(world))).toThrow(
      /passenger|resident|mismatch/i,
    );
  });
});
