import { describe, expect, it } from "vitest";
import { edgeKey, movementResources } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import { commitPlan, planRelocation } from "../src/scheduler";
import { requiredTrajectoryWindows } from "../src/shared/trajectory";
import { createEconomy } from "../src/economy";
import type {
  Berth,
  MotionSegment,
  Pod,
  Track,
  World,
} from "../src/shared/types";

const overlaps = (
  left: { start: number; end: number },
  right: { start: number; end: number },
) => left.start < right.end - 1e-8 && right.start < left.end - 1e-8;

function berth(
  id: string,
  point: [number, number],
  access: [number, number],
): Berth {
  return {
    id,
    buildingId: "b-home",
    kind: "parking",
    point: { x: point[0], y: point[1] },
    access: { x: access[0], y: access[1] },
    side: "south",
    paid: 0,
  };
}

function pod(id: string, berthId: string): Pod {
  return { id, berthId, parkedSince: 0, plan: null, trips: 0, paid: 0 };
}

function bareWorld(berths: Berth[], tracks: Track[], pods: Pod[]): World {
  return {
    version: 2,
    seed: 1,
    rng: 1,
    time: 0,
    paused: false,
    speed: 1,
    width: 24,
    height: 24,
    nextId: 1,
    networkVersion: 1,
    buildings: [],
    berths,
    tracks,
    residents: [],
    pods,
    reservations: [],
    economy: {
      cash: 1000,
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

const startPoints: [number, number][] = [
  [1, 2],
  [2, 1],
  [3, 2],
  [2, 3],
];
const endPoints: [number, number][] = [
  [10, 11],
  [11, 10],
  [12, 11],
  [11, 12],
];

function diagonalCorridor(
  lanes: 1 | 2 | 3,
  directions: ("forward" | "reverse")[],
): { world: World; targets: Berth[] } {
  const startAccess: [number, number] = [2, 2];
  const endAccess: [number, number] = [11, 11];
  const origins: Berth[] = [];
  const targets: Berth[] = [];
  directions.forEach((direction, index) => {
    const forward = direction === "forward";
    origins.push(
      berth(
        `origin-${index}`,
        forward ? startPoints[index] : endPoints[index],
        forward ? startAccess : endAccess,
      ),
    );
    targets.push(
      berth(
        `target-${index}`,
        forward ? endPoints[index] : startPoints[index],
        forward ? endAccess : startAccess,
      ),
    );
  });
  const tracks: Track[] = [];
  for (let value = 2; value < 11; value += 1)
    tracks.push({
      id: `track-${value}`,
      a: { x: value, y: value },
      b: { x: value + 1, y: value + 1 },
      paid: 0,
      lanes,
    });
  return {
    world: bareWorld(
      [...origins, ...targets],
      tracks,
      origins.map((origin, index) => pod(`pod-${index}`, origin.id)),
    ),
    targets,
  };
}

function scheduleAll(world: World, targets: Berth[]) {
  return world.pods.map((currentPod, index) => {
    const result = planRelocation(world, currentPod, targets[index]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    commitPlan(world, result.plan);
    return result.plan;
  });
}

function middleMove(plan: NonNullable<Pod["plan"]>): MotionSegment {
  return plan.segments.find(
    (segment) =>
      segment.kind === "move" &&
      edgeKey(segment.from, segment.to) ===
        edgeKey({ x: 6, y: 6 }, { x: 7, y: 7 }),
  )!;
}

describe("bidirectionally shared physical lanes", () => {
  it("reserves the actual previous and next segments without locking a parallel lane", () => {
    const fixture = diagonalCorridor(2, ["forward"]);
    const [plan] = scheduleAll(fixture.world, fixture.targets);
    expect(plan.safetyBuffer).toBe(1);
    const current = middleMove(plan);
    const index = plan.segments.indexOf(current);
    const previous = plan.segments[index - 1];
    const next = plan.segments[index + 1];
    for (const neighbor of [previous, next]) {
      expect(neighbor.kind).toBe("move");
      expect(
        plan.reservations.some(
          (reservation) =>
            reservation.resource === neighbor.resources[0] &&
            reservation.start <= current.start + 1e-8 &&
            reservation.end >= current.end - 1e-8,
        ),
      ).toBe(true);
    }
    const parallelLane = movementResources(
      fixture.world,
      current.from,
      current.to,
      1,
    )[0];
    expect(
      plan.reservations.some(
        (reservation) =>
          reservation.resource === parallelLane &&
          overlaps(reservation, current),
      ),
    ).toBe(false);
  });

  it("does not carry the spatial buffer across a stop", () => {
    const fixture = diagonalCorridor(1, ["forward"]);
    const firstFrom = { x: 4, y: 4 };
    const stop = { x: 5, y: 5 };
    const final = { x: 6, y: 6 };
    const segments: MotionSegment[] = [
      {
        from: firstFrom,
        to: stop,
        start: 0,
        end: 4,
        kind: "move",
        stage: "empty",
        resources: movementResources(fixture.world, firstFrom, stop),
      },
      {
        from: stop,
        to: stop,
        start: 4,
        end: 13,
        kind: "boarding",
        stage: "empty",
        resources: [],
      },
      {
        from: stop,
        to: final,
        start: 13,
        end: 17,
        kind: "move",
        stage: "loaded",
        resources: movementResources(fixture.world, stop, final),
      },
    ];
    const nextResource = segments[2].resources[0];
    const windows = requiredTrajectoryWindows(fixture.world, segments, 1);
    expect(
      windows
        .filter((window) => window.resource === nextResource)
        .every((window) => window.start >= 13 - 1e-8),
    ).toBe(true);
  });

  it("lets two same-direction Pods choose two lanes concurrently", () => {
    const fixture = diagonalCorridor(2, ["forward", "forward"]);
    const plans = scheduleAll(fixture.world, fixture.targets);
    const moves = plans.map(middleMove);
    expect(moves[0].resources[0]).not.toBe(moves[1].resources[0]);
    expect(overlaps(moves[0], moves[1])).toBe(true);
  });

  it("lets opposite directions overlap on different slots but serializes reuse", () => {
    const fixture = diagonalCorridor(2, ["forward", "reverse", "forward"]);
    const plans = scheduleAll(fixture.world, fixture.targets);
    const moves = plans.map(middleMove);
    expect(overlaps(moves[0], moves[1])).toBe(true);
    expect(moves[0].resources[0]).not.toBe(moves[1].resources[0]);
    const prior = moves
      .slice(0, 2)
      .find((move) => move.resources[0] === moves[2].resources[0])!;
    expect(prior).toBeDefined();
    expect(overlaps(prior, moves[2])).toBe(false);
  });

  it("uses all three shared slots concurrently and makes the fourth wait", () => {
    const fixture = diagonalCorridor(3, [
      "forward",
      "forward",
      "forward",
      "forward",
    ]);
    const plans = scheduleAll(fixture.world, fixture.targets);
    const moves = plans.map(middleMove);
    expect(
      new Set(moves.slice(0, 3).map((move) => move.resources[0])).size,
    ).toBe(3);
    expect(
      Math.max(...moves.slice(0, 3).map((move) => move.start)),
    ).toBeLessThan(Math.min(...moves.slice(0, 3).map((move) => move.end)));
    const reused = moves
      .slice(0, 3)
      .find((move) => move.resources[0] === moves[3].resources[0])!;
    expect(plans[3].departure).toBeGreaterThan(0);
    expect(reused).toBeDefined();
    expect(overlaps(reused, moves[3])).toBe(false);
  });

  it("coordinates opposite diagonal crossings across every lane choice", () => {
    const positiveStart = berth("positive-start", [0, 1], [1, 1]);
    const positiveEnd = berth("positive-end", [3, 2], [2, 2]);
    const negativeStart = berth("negative-start", [3, 1], [2, 1]);
    const negativeEnd = berth("negative-end", [0, 2], [1, 2]);
    const world = bareWorld(
      [positiveStart, positiveEnd, negativeStart, negativeEnd],
      [
        {
          id: "positive",
          a: { x: 1, y: 1 },
          b: { x: 2, y: 2 },
          paid: 0,
          lanes: 3,
        },
        {
          id: "negative",
          a: { x: 2, y: 1 },
          b: { x: 1, y: 2 },
          paid: 0,
          lanes: 3,
        },
      ],
      [
        pod("positive-pod", positiveStart.id),
        pod("negative-pod", negativeStart.id),
      ],
    );
    const plans = scheduleAll(world, [positiveEnd, negativeEnd]);
    const positive = plans[0].segments.find(
      (segment) => segment.kind === "move" && segment.from.x === 1,
    )!;
    const negative = plans[1].segments.find(
      (segment) => segment.kind === "move" && segment.from.x === 2,
    )!;
    expect(
      positive.resources.some((resource) =>
        negative.resources.includes(resource),
      ),
    ).toBe(true);
    expect(overlaps(positive, negative)).toBe(false);
  });
});

function addValidBuildings(world: World) {
  world.economy = createEconomy(world.time);
  for (const parking of world.berths) {
    delete parking.buildingId;
  }
  world.berths.push({
    id: "fixture-platform",
    kind: "platform",
    side: "east",
    paid: 0,
    point: { x: 10, y: 15 },
    access: { x: 11, y: 15 },
  });
  world.buildings = [
    {
      id: "b-home",
      name: "Home",
      nameEn: "Home",
      kind: "home",
      x: 10,
      y: 1,
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
      y: 1,
      w: 2,
      h: 2,
      bornAt: 0,
    },
    {
      id: "b-shop",
      name: "Shop",
      nameEn: "Shop",
      kind: "shop",
      x: 18,
      y: 1,
      w: 2,
      h: 2,
      bornAt: 0,
    },
  ];
}

describe("shared-lane save compatibility", () => {
  it("restores new three-lane plans and migrates a real active directional v1 plan", () => {
    const origin = berth("origin", [0, 6], [1, 6]);
    const target = berth("target", [3, 6], [2, 6]);
    const world = bareWorld(
      [origin, target],
      [
        {
          id: "middle",
          a: { x: 1, y: 6 },
          b: { x: 2, y: 6 },
          paid: 10,
          lanes: 2,
        },
      ],
      [pod("pod", origin.id)],
    );
    addValidBuildings(world);
    const candidate = planRelocation(world, world.pods[0], target);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    commitPlan(world, candidate.plan);
    const committed = world.pods[0].plan!;
    delete committed.safetyBuffer;
    const middle = committed.segments.find(
      (segment) =>
        segment.kind === "move" &&
        edgeKey(segment.from, segment.to) ===
          edgeKey({ x: 1, y: 6 }, { x: 2, y: 6 }),
    )!;
    const canonicalLane = middle.resources[0];
    const legacyLane = "lane:1,6>2,6";
    middle.resources = [legacyLane];
    for (const reservation of committed.reservations)
      if (reservation.resource === canonicalLane)
        reservation.resource = legacyLane;
    for (const reservation of world.reservations)
      if (reservation.resource === canonicalLane)
        reservation.resource = legacyLane;

    const migrated = parseWorld(serializeWorld(world));
    expect(migrated.pods[0].plan).not.toBeNull();
    expect(migrated.pods[0].plan!.safetyBuffer).toBeUndefined();
    expect(migrated.pods[0].plan!.segments).toEqual(committed.segments);
    expect(
      migrated.reservations.some(
        (reservation) =>
          reservation.resource === "lane:1,6~2,6:0" &&
          reservation.ownerId === "pod",
      ),
    ).toBe(true);

    const tripleOrigin = berth("triple-origin", [0, 8], [1, 8]);
    const tripleTarget = berth("triple-target", [3, 8], [2, 8]);
    const triple = bareWorld(
      [tripleOrigin, tripleTarget],
      [
        {
          id: "triple-middle",
          a: { x: 1, y: 8 },
          b: { x: 2, y: 8 },
          paid: 20,
          lanes: 3,
        },
      ],
      [pod("triple-pod", tripleOrigin.id)],
    );
    addValidBuildings(triple);
    const tripleCandidate = planRelocation(
      triple,
      triple.pods[0],
      tripleTarget,
    );
    expect(tripleCandidate.ok).toBe(true);
    if (!tripleCandidate.ok) return;
    commitPlan(triple, tripleCandidate.plan);
    const restoredTriple = parseWorld(serializeWorld(triple));
    expect(restoredTriple.tracks[0].lanes).toBe(3);
    expect(restoredTriple.pods[0].plan).not.toBeNull();
  });

  it("rejects forged lane selections and forged reservation slots", () => {
    const origin = berth("origin", [0, 6], [1, 6]);
    const target = berth("target", [3, 6], [2, 6]);
    const world = bareWorld(
      [origin, target],
      [
        {
          id: "middle",
          a: { x: 1, y: 6 },
          b: { x: 2, y: 6 },
          paid: 0,
          lanes: 2,
        },
      ],
      [pod("pod", origin.id)],
    );
    addValidBuildings(world);
    const candidate = planRelocation(world, world.pods[0], target);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    commitPlan(world, candidate.plan);

    const forgedSegment = JSON.parse(serializeWorld(world)) as {
      world: World;
    };
    const move = forgedSegment.world.pods[0].plan!.segments.find((segment) =>
      segment.resources[0].startsWith("lane:"),
    )!;
    move.resources[0] = "lane:1,6~2,6:2";
    expect(() => parseWorld(JSON.stringify(forgedSegment))).toThrow();

    const forgedReservation = JSON.parse(serializeWorld(world)) as {
      world: World;
    };
    forgedReservation.world.reservations.push({
      resource: "lane:1,6~2,6:2",
      start: 0,
      end: 1,
      ownerId: "pod",
    });
    expect(() => parseWorld(JSON.stringify(forgedReservation))).toThrow();
  });
});
