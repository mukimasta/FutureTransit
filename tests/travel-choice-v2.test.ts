import { describe, expect, it } from "vitest";
import { applyCommand, createWorld, stepWorld } from "../src/simulation";
import { decideTravel } from "../src/population/choice";
import { fareForDistance, loadedDistanceKm } from "../src/economy";
import { parseWorld, serializeWorld, SAVE_KEY } from "../src/persistence";
import type { LedgerCategory } from "../src/shared/types";

function oneRider() {
  const world = createWorld();
  world.growth.enabled = false;
  applyCommand(world, {
    type: "add-berth",
    buildingId: "b-office",
    kind: "platform",
    side: "west",
  });
  const office = world.berths.find((b) => b.buildingId === "b-office")!;
  expect(
    applyCommand(world, {
      type: "build-track",
      points: [{ x: 10, y: 16 }, { x: office.access.x, y: 16 }, office.access],
    }).ok,
  ).toBe(true);
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

describe("real travel choice and internal building access", () => {
  it("enters the building's platform queue directly, without an outdoor access walk", () => {
    const { world, resident } = oneRider();
    stepWorld(world, 1);
    expect(resident.status).toBe("waiting");
    expect(resident.journey?.stage).toBe("queue");
    expect(resident.journey?.walk).toBeUndefined();
    expect(resident.decision?.destinationId).toBe("b-office");
  });

  it("charges loaded kilometres only and goes straight inside after alighting", () => {
    const { world, resident } = oneRider();
    stepWorld(world, 3);
    const pod = world.pods.find((p) => p.plan?.residentId === resident.id)!;
    expect(pod.plan).not.toBeNull();
    const plan = pod.plan!;
    const km = loadedDistanceKm(plan);
    applyCommand(world, { type: "set-fare", value: 50 });
    stepWorld(world, Math.ceil(plan.dropoffEnd! - world.time));
    expect(resident.status).toBe("inside");
    expect(resident.atBuildingId).toBe("b-office");
    expect(resident.journey).toBeNull();
    const trip = world.metrics.recentTrips.find(
      (t) => t.residentId === resident.id,
    )!;
    expect(trip.distanceKm).toBeCloseTo(km, 8);
    expect(trip.fare).toBe(fareForDistance(km, 18));
    expect(world.economy.distanceKm!.empty).toBeGreaterThan(0);
    expect(world.economy.totals!.fare).toBe(trip.fare);
    expect(world.economy.totals!["empty-running"]).toBeGreaterThan(0);
  });

  it("price can switch the same person's decision, with reproducible preference", () => {
    const world = createWorld();
    const expensive = structuredClone(world);
    world.economy.farePerKm = 2;
    expensive.economy.farePerKm = 60;
    const option = {
      podSeconds: 250,
      waitSeconds: 50,
      rideSeconds: 185,
      distanceKm: 1,
    };
    world.residents[0].fareSensitivity = 15;
    expensive.residents[0].fareSensitivity = 15;
    const cheap = decideTravel(world, world.residents[0], 900, option);
    const dear = decideTravel(expensive, expensive.residents[0], 900, option);
    expect(cheap.mode).toBe("pod");
    expect(dear.mode).toBe("walk");
    expect(dear.reason).toBe("price");
    expect(cheap.preferenceSeconds).toBe(dear.preferenceSeconds);
    expect(decideTravel(world, world.residents[0], 100, option).reason).toBe(
      "short-walk",
    );
  });

  it("construction, grants, operating bills and fares reconcile to cash", () => {
    const { world } = oneRider();
    applyCommand(world, { type: "claim-grant" });
    stepWorld(world, 600);
    const credits: LedgerCategory[] = [
      "opening",
      "fare",
      "grant",
      "loan",
      "refund",
    ];
    const balance = Object.entries(world.economy.totals!).reduce(
      (sum, [category, value]) =>
        sum + (credits.includes(category as LedgerCategory) ? value : -value),
      0,
    );
    expect(world.economy.cash).toBeCloseTo(balance, 2);
    const restored = parseWorld(serializeWorld(world));
    expect(restored.economy).toEqual(world.economy);
    expect(restored.residents.map((r) => r.decision)).toEqual(
      world.residents.map((r) => r.decision),
    );
  });

  it("uses an independent station-revision save key and validates loan balances", () => {
    expect(SAVE_KEY).toBe("futuretransit-mvp-stations-v3");
    const world = createWorld();
    for (let i = 0; i < 3; i++) applyCommand(world, { type: "claim-grant" });
    applyCommand(world, { type: "take-loan" });
    expect(parseWorld(serializeWorld(world)).economy.loan).toEqual(
      world.economy.loan,
    );
    world.economy.loan!.arrears = 6000;
    expect(() => parseWorld(serializeWorld(world))).toThrow();
    const old = JSON.parse(serializeWorld(createWorld()));
    old.version = 1;
    expect(() => parseWorld(JSON.stringify(old))).toThrow(/new city/);
  });
});
