import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createWorld,
  parkingPlacement,
  stepWorld,
} from "../src/simulation";
import { findTrackPath } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import { fareForDistance } from "../src/economy";
import { PARKING_COST } from "../src/shared/constants";
import { clearDevelopmentSite } from "../src/city/layout";

function detachedJourney() {
  const world = createWorld();
  world.growth.enabled = false;
  expect(
    applyCommand(world, {
      type: "add-platform",
      buildingId: "b-office",
      side: "west",
    }).ok,
  ).toBe(true);
  const office = world.berths.find((b) => b.buildingId === "b-office")!;
  expect(
    applyCommand(world, {
      type: "build-track",
      points: [{ x: 10, y: 16 }, { x: office.access.x, y: 16 }, office.access],
    }).ok,
  ).toBe(true);
  for (const b of world.berths) delete b.buildingId;
  world.residents.forEach((r) => {
    r.nextDeparture = 100000;
  });
  const resident = world.residents[0];
  resident.nextDeparture = 1;
  resident.nextDestinationId = "b-office";
  resident.fareSensitivity = 0;
  resident.podPreference = -90;
  world.paused = false;
  return { world, resident };
}

describe("independent stations and parking", () => {
  it("keeps future growth off a booked passenger's final walk before alighting", () => {
    const world = createWorld();
    const site = { x: 30, y: 30, w: 3, h: 3 };
    expect(clearDevelopmentSite(world, site, [])).toBe(true);
    world.residents[0].journey = {
      originId: "b-home",
      destinationId: "b-office",
      startedAt: 0,
      walkBaseline: 1000,
      purpose: "work",
      mode: "pod",
      stage: "onboard",
      egressPath: [
        { x: 29, y: 31 },
        { x: 30, y: 31 },
        { x: 31, y: 31 },
      ],
    };
    expect(clearDevelopmentSite(world, site, [])).toBe(false);
  });
  it("creates an independent platform at the selected cell and validates geometry", () => {
    const world = createWorld();
    expect(
      applyCommand(world, {
        type: "add-platform",
        point: { x: 3, y: 3 },
        side: "east",
      }).ok,
    ).toBe(true);
    const platform = world.berths.at(-1)!;
    expect(platform).toMatchObject({
      kind: "platform",
      point: { x: 3, y: 3 },
      access: { x: 4, y: 3 },
    });
    expect(platform.buildingId).toBeUndefined();
    expect(
      applyCommand(world, {
        type: "add-platform",
        point: { x: 3, y: 3 },
        side: "west",
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(world, {
        type: "add-platform",
        point: { x: NaN, y: 3 },
        side: "west",
      }).ok,
    ).toBe(false);
    expect(parseWorld(serializeWorld(world))).toEqual(world);
  });

  it("keeps parking independent even when using a nearby-platform placement shortcut", () => {
    const world = createWorld();
    expect(
      world.berths
        .filter((b) => b.kind === "parking")
        .every((b) => !b.buildingId && !("platformId" in b)),
    ).toBe(true);
    applyCommand(world, {
      type: "add-platform",
      point: { x: 3, y: 3 },
      side: "east",
    });
    const platform = world.berths.at(-1)!;
    for (let i = 0; i < 2; i++) {
      const placement = parkingPlacement(world, platform, "north")!;
      expect(placement).not.toBeNull();
      const cash = world.economy.cash;
      expect(
        applyCommand(world, {
          type: "add-parking",
          nearPlatformId: platform.id,
          side: "north",
        }).ok,
      ).toBe(true);
      const parking = world.berths.at(-1)!;
      expect("platformId" in parking).toBe(false);
      expect(parking.buildingId).toBeUndefined();
      expect(world.economy.cash).toBe(
        cash - PARKING_COST - placement.trackCost,
      );
      expect(
        findTrackPath(world, parking.point, platform.point),
      ).not.toBeNull();
      if (i === 1) expect(placement.trackCost).toBeGreaterThan(0);
    }
    expect(
      applyCommand(world, { type: "remove-berth", id: platform.id }).ok,
    ).toBe(true);
    expect(world.berths.filter((b) => b.kind === "parking")).toHaveLength(7);
    expect(parseWorld(serializeWorld(world))).toEqual(world);
  });

  it("builds parking on free land without any platform and strips obsolete owner metadata", () => {
    const world = createWorld();
    const cash = world.economy.cash;
    expect(
      applyCommand(world, {
        type: "add-parking",
        point: { x: 3, y: 3 },
        side: "east",
      }).ok,
    ).toBe(true);
    const parking = world.berths.at(-1)!;
    expect(parking).toMatchObject({
      kind: "parking",
      point: { x: 3, y: 3 },
      access: { x: 4, y: 3 },
    });
    expect(world.economy.cash).toBe(cash - PARKING_COST);
    expect(
      applyCommand(world, { type: "buy-pod", berthId: parking.id }).ok,
    ).toBe(true);
    Object.assign(parking, { platformId: "old-owner" });
    const restored = parseWorld(serializeWorld(world));
    expect("platformId" in restored.berths.at(-1)!).toBe(false);
    parking.buildingId = "b-home";
    expect(() => parseWorld(serializeWorld(world))).toThrow(
      /parking is independent/,
    );
  });

  it("walks to detached pickup, then completes and bills once after destination egress", () => {
    const { world, resident } = detachedJourney();
    stepWorld(world, 1);
    expect(resident.journey?.stage).toBe("access");
    expect(resident.status).toBe("walking");
    expect(parseWorld(serializeWorld(world)).residents[0].journey?.stage).toBe(
      "access",
    );
    for (let i = 0; i < 1600 && resident.journey?.stage !== "egress"; i++)
      stepWorld(world, 1);
    expect(resident.journey?.stage).toBe("egress");
    expect(resident.journey?.podId).toBeUndefined();
    expect(world.metrics.served).toBe(0);
    const expectedFare = fareForDistance(
      resident.journey!.distanceKm!,
      resident.journey!.farePerKm!,
    );
    const restored = parseWorld(serializeWorld(world));
    restored.paused = false;
    const untilArrival = Math.ceil(resident.journey!.walk!.end - world.time);
    stepWorld(world, untilArrival);
    stepWorld(restored, untilArrival);
    expect(restored).toEqual(world);
    expect(resident.atBuildingId).toBe("b-office");
    expect(world.metrics.served).toBe(1);
    expect(world.economy.totals!.fare).toBe(expectedFare);
    resident.nextDeparture = world.time + 100000;
    stepWorld(world, 120);
    expect(world.metrics.served).toBe(1);
    expect(world.economy.totals!.fare).toBe(expectedFare);
  });
});
