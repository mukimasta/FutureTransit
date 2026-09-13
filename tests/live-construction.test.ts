import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createWorld,
  processPending,
  stepWorld,
} from "../src/simulation";
import { book } from "../src/economy";
import { commitPlan, planRelocation, planService } from "../src/scheduler";
import { exclusiveNodeResources, movementResources } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import type { Command, World } from "../src/shared/types";

function corridor(lanes: 1 | 2 = 2) {
  const world = createWorld();
  world.paused = false;
  world.growth.enabled = false;
  world.residents.forEach((resident) => (resident.nextDeparture = 1e9));
  world.tracks = [];
  world.berths = [
    {
      id: "left",
      kind: "parking",
      point: { x: 2, y: 27 },
      access: { x: 2, y: 28 },
      side: "south",
      paid: 0,
    },
    {
      id: "right",
      kind: "parking",
      point: { x: 8, y: 27 },
      access: { x: 8, y: 28 },
      side: "south",
      paid: 0,
    },
    {
      id: "left-target",
      kind: "parking",
      point: { x: 1, y: 28 },
      access: { x: 2, y: 28 },
      side: "east",
      paid: 0,
    },
    {
      id: "right-target",
      kind: "parking",
      point: { x: 9, y: 28 },
      access: { x: 8, y: 28 },
      side: "west",
      paid: 0,
    },
  ];
  world.pods = world.pods
    .slice(0, 2)
    .map((pod, index) => ({ ...pod, berthId: world.berths[index].id }));
  world.networkVersion++;
  expect(
    applyCommand(world, {
      type: "build-track",
      points: [
        { x: 2, y: 28 },
        { x: 8, y: 28 },
      ],
    }).ok,
  ).toBe(true);
  if (lanes === 2)
    expect(
      applyCommand(world, {
        type: "upgrade-tracks",
        ids: world.tracks.map((track) => track.id),
      }).ok,
    ).toBe(true);
  for (const [index, target] of [world.berths[3], world.berths[2]].entries()) {
    const planned = planRelocation(world, world.pods[index], target);
    expect(planned.ok).toBe(true);
    if (planned.ok) commitPlan(world, planned.plan);
  }
  stepWorld(world, 7);
  world.paused = true;
  return world;
}

function journeys(world: World) {
  return world.pods.map((pod) => ({
    id: pod.id,
    berthId: pod.berthId,
    plan: pod.plan && {
      ...pod.plan,
      reservations: undefined,
      segments: pod.plan.segments.map(
        ({ resources: _resources, ...segment }) => segment,
      ),
    },
  }));
}

describe("non-disruptive live construction", () => {
  it("joins a branch to a busy two-lane corridor without draining or interrupting either Pod", () => {
    const world = corridor();
    const before = journeys(world);
    expect(
      applyCommand(world, {
        type: "build-track",
        points: [
          { x: 5, y: 28 },
          { x: 5, y: 30 },
        ],
      }).ok,
    ).toBe(true);
    expect(journeys(world)).toEqual(before);
    expect(world.paused).toBe(true);
    expect(world.time).toBe(7);
    expect(world.pendingEdits).toEqual([]);
    expect(world.throughCorridors).toContainEqual({
      point: { x: 5, y: 28 },
      from: { x: 4, y: 28 },
      to: { x: 6, y: 28 },
    });
    expect(exclusiveNodeResources(world, { x: 5, y: 28 })).toEqual(
      expect.arrayContaining(["node-lane:5,28:0", "node-lane:5,28:1"]),
    );
    expect(() => parseWorld(serializeWorld(world))).not.toThrow();

    expect(
      applyCommand(world, {
        type: "add-parking",
        point: { x: 5, y: 31 },
        side: "north",
      }).ok,
    ).toBe(true);
    const berth = world.berths.at(-1)!;
    expect(applyCommand(world, { type: "buy-pod", berthId: berth.id }).ok).toBe(
      true,
    );
    const next = planRelocation(world, world.pods.at(-1)!, world.berths[1]);
    expect(next.ok).toBe(true);
    if (next.ok) commitPlan(world, next.plan);
    // Save validation independently reconstructs all simultaneous trajectories,
    // including the new turning Pod and both old through lanes.
    expect(() => parseWorld(serializeWorld(world))).not.toThrow();
  });

  it.each(["platform", "parking"] as const)(
    "adds a %s beside occupied through lanes immediately",
    (kind) => {
      const world = corridor();
      const before = journeys(world);
      const command: Command =
        kind === "platform"
          ? { type: "add-platform", point: { x: 5, y: 27 }, side: "south" }
          : { type: "add-parking", point: { x: 5, y: 27 }, side: "south" };
      expect(applyCommand(world, command).ok).toBe(true);
      expect(world.berths.at(-1)?.kind).toBe(kind);
      expect(journeys(world)).toEqual(before);
      expect(world.pendingEdits).toEqual([]);
      expect(() => parseWorld(serializeWorld(world))).not.toThrow();
    },
  );

  it("widens a reserved single track immediately, preserving timeline and collecting the cost once", () => {
    const world = corridor(1);
    const before = journeys(world);
    const cash = world.economy.cash;
    const used = world.tracks[2];
    expect(
      applyCommand(world, { type: "upgrade-tracks", ids: [used.id], lanes: 3 })
        .ok,
    ).toBe(true);
    expect(world.tracks.find((track) => track.id === used.id)?.lanes).toBe(3);
    expect(world.economy.cash).toBe(cash - 20);
    expect(world.pendingEdits).toEqual([]);
    expect(journeys(world)).toEqual(before);
    const widened = world.pods[0].plan!.segments.find(
      (segment) => segment.from.x === 4 && segment.to.x === 5,
    )!;
    expect(widened.resources).toEqual(
      movementResources(world, widened.from, widened.to, 0),
    );
    expect(
      applyCommand(world, { type: "upgrade-tracks", ids: [used.id], lanes: 3 })
        .ok,
    ).toBe(false);
    expect(world.economy.cash).toBe(cash - 20);
    expect(() => parseWorld(serializeWorld(world))).not.toThrow();
  });

  it("keeps parallel traffic valid when widening only part of a two-lane corridor", () => {
    const world = corridor();
    const before = journeys(world);
    expect(
      applyCommand(world, {
        type: "upgrade-tracks",
        ids: [world.tracks[2].id],
        lanes: 3,
      }).ok,
    ).toBe(true);
    expect(journeys(world)).toEqual(before);
    expect(world.pendingEdits).toEqual([]);
    expect(() => parseWorld(serializeWorld(world))).not.toThrow();
  });

  it("does not detach a passenger when widening their reserved route", () => {
    const world = corridor();
    world.pods.forEach((pod, index) => {
      pod.plan = null;
      pod.berthId = world.berths[index].id;
    });
    world.reservations = [];
    for (const x of [3, 7])
      expect(
        applyCommand(world, {
          type: "add-platform",
          point: { x, y: 27 },
          side: "south",
        }).ok,
      ).toBe(true);
    const [pickup, dropoff] = world.berths.slice(-2);
    const resident = world.residents[0];
    resident.atBuildingId = null;
    resident.status = "waiting";
    resident.journey = {
      originId: resident.homeId,
      destinationId: resident.workId,
      startedAt: world.time,
      walkBaseline: 800,
      purpose: "work",
      mode: "pod",
      stage: "queue",
      pickupId: pickup.id,
      dropoffId: dropoff.id,
    };
    const planned = planService(
      world,
      world.pods[0],
      resident,
      pickup,
      dropoff,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    commitPlan(world, planned.plan);
    resident.journey.podId = world.pods[0].id;
    const passengers = structuredClone(world.residents);
    const before = journeys(world);
    expect(
      applyCommand(world, {
        type: "upgrade-tracks",
        ids: world.tracks.map((track) => track.id),
        lanes: 3,
      }).ok,
    ).toBe(true);
    expect(journeys(world)).toEqual(before);
    expect(world.residents).toEqual(passengers);
    expect(() => parseWorld(serializeWorld(world))).not.toThrow();
  });

  it("completes saved prepaid widening orders while paused without charging twice", () => {
    const world = corridor(1);
    const track = world.tracks[2];
    book(world, "track-build", -10);
    world.pendingEdits.push({
      type: "upgrade-track",
      id: track.id,
      paid: 10,
      targetLanes: 2,
    });
    const restored = parseWorld(serializeWorld(world));
    const cash = restored.economy.cash;
    const before = journeys(restored);
    processPending(restored, true);
    expect(restored.paused).toBe(true);
    expect(restored.economy.cash).toBe(cash);
    expect(journeys(restored)).toEqual(before);
    expect(restored.pendingEdits).toEqual([]);
    expect(restored.tracks.find((entry) => entry.id === track.id)?.lanes).toBe(
      2,
    );
    expect(() => parseWorld(serializeWorld(restored))).not.toThrow();
  });

  it("rejects forged through-lane metadata in saved worlds", () => {
    const world = corridor();
    applyCommand(world, {
      type: "build-track",
      points: [
        { x: 5, y: 28 },
        { x: 5, y: 30 },
      ],
    });
    world.throughCorridors![0].from = { x: 40, y: 30 };
    expect(() => parseWorld(serializeWorld(world))).toThrow(
      "missing through corridor edge",
    );
  });

  it("still queues demolition until traffic clears and removes obsolete through metadata", () => {
    const world = corridor();
    applyCommand(world, {
      type: "build-track",
      points: [
        { x: 5, y: 28 },
        { x: 5, y: 30 },
      ],
    });
    const selected = world.tracks.find(
      (track) => track.a.x === 5 && track.b.x === 6,
    )!;
    expect(
      applyCommand(world, { type: "remove-tracks", ids: [selected.id] }).ok,
    ).toBe(true);
    expect(world.tracks.some((track) => track.id === selected.id)).toBe(true);
    expect(world.pendingEdits).toContainEqual({
      type: "remove-track",
      id: selected.id,
    });
    world.paused = false;
    const end = Math.max(...world.pods.map((pod) => pod.plan!.end));
    stepWorld(world, end - world.time + 3);
    expect(world.tracks.some((track) => track.id === selected.id)).toBe(false);
    expect(world.pendingEdits).toEqual([]);
    expect(world.throughCorridors).toEqual([]);
    expect(() => parseWorld(serializeWorld(world))).not.toThrow();
  });
});
