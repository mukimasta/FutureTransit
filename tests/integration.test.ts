import { describe, expect, it } from "vitest";
import {
  applyCommand,
  capacityValid,
  createWorld,
  stepWorld,
} from "../src/simulation";
import { findTrackPath } from "../src/network";
import type { World } from "../src/shared/types";

export function connectStarter(world: World) {
  expect(
    applyCommand(world, {
      type: "add-berth",
      buildingId: "b-office",
      kind: "platform",
      side: "west",
    }).ok,
  ).toBe(true);
  expect(
    applyCommand(world, {
      type: "add-berth",
      buildingId: "b-shop",
      kind: "platform",
      side: "west",
    }).ok,
  ).toBe(true);
  const office = world.berths.find((b) => b.buildingId === "b-office")!;
  const shop = world.berths.find((b) => b.buildingId === "b-shop")!;
  expect(
    applyCommand(world, {
      type: "build-track",
      points: [{ x: 10, y: 16 }, { x: office.access.x, y: 16 }, office.access],
    }).ok,
  ).toBe(true);
  expect(
    applyCommand(world, {
      type: "build-track",
      points: [
        { x: office.access.x, y: 16 },
        { x: shop.access.x, y: 17 },
        shop.access,
      ],
    }).ok,
  ).toBe(true);
}

describe("complete city simulation", () => {
  it("starts with 24 unique residents, a visible finite yard, and no inter-building service", () => {
    const w = createWorld();
    expect(w.residents).toHaveLength(24);
    expect(w.pods).toHaveLength(4);
    expect(w.berths).toHaveLength(6);
    expect(capacityValid(w)).toBe(true);
    const homePlatform = w.berths.find((b) => b.kind === "platform")!;
    for (const pod of w.pods)
      expect(
        findTrackPath(
          w,
          w.berths.find((b) => b.id === pod.berthId)!.point,
          homePlatform.point,
        ),
      ).not.toBeNull();
    const copy = JSON.stringify(w);
    stepWorld(w, 300);
    expect(JSON.stringify(w)).toBe(copy);
  });
  it("residents complete walking trips without any destination platforms", () => {
    const w = createWorld();
    w.paused = false;
    w.growth.enabled = false;
    stepWorld(w, 1800);
    expect(w.metrics.walked).toBeGreaterThan(0);
    expect(w.metrics.served).toBe(0);
    expect(w.residents.every((r) => !!r.atBuildingId !== !!r.journey)).toBe(
      true,
    );
  });
  it("built service performs visible empty pickup and same-person delivery with collision-free plans", () => {
    const w = createWorld();
    connectStarter(w);
    w.paused = false;
    w.growth.enabled = false;
    let sawEmpty = false,
      sawBoard = false,
      sawRide = false;
    for (let second = 0; second < 1500; second++) {
      stepWorld(w, 1);
      sawEmpty ||= w.pods.some((p) =>
        p.plan?.segments.some(
          (s) =>
            s.stage === "empty" &&
            s.kind === "move" &&
            s.start <= w.time &&
            s.end > w.time,
        ),
      );
      sawBoard ||= w.residents.some((r) => r.status === "boarding");
      sawRide ||= w.residents.some((r) => r.status === "riding");
      expect(w.residents.every((r) => !!r.atBuildingId !== !!r.journey)).toBe(
        true,
      );
      const terminals = w.pods.map((p) => p.plan?.finalBerthId ?? p.berthId);
      expect(new Set(terminals).size).toBe(w.pods.length);
      const current = w.reservations.filter(
        (r) => r.start <= w.time && r.end > w.time,
      );
      const owners = new Map<string, string>();
      for (const r of current) {
        expect(
          !owners.has(r.resource) || owners.get(r.resource) === r.ownerId,
        ).toBe(true);
        owners.set(r.resource, r.ownerId);
      }
    }
    expect(sawEmpty && sawBoard && sawRide).toBe(true);
    expect(w.metrics.served).toBeGreaterThan(3);
    expect(w.economy.income).toBeCloseTo(
      w.metrics.recentTrips.reduce((sum, trip) => sum + (trip.fare ?? 0), 0),
      2,
    );
    expect(
      w.metrics.recentTrips
        .filter((t) => t.mode === "pod")
        .some((t) => t.endedAt - t.startedAt < t.walkBaseline),
    ).toBe(true);
  }, 30000);
});
