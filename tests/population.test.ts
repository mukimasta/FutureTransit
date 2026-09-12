import { describe, expect, it } from "vitest";
import {
  createResidents,
  chooseTravelMode,
  planNextActivity,
} from "../src/population";
import type { Building, World } from "../src/shared/types";

const home: Building = {
  id: "home-1",
  name: "晨光公寓",
  nameEn: "Morning Homes",
  kind: "home",
  x: 1,
  y: 1,
  w: 2,
  h: 2,
  bornAt: 0,
};
const office: Building = {
  id: "office-1",
  name: "北岸办公室",
  nameEn: "North Office",
  kind: "office",
  x: 8,
  y: 1,
  w: 2,
  h: 2,
  bornAt: 0,
};
const shop: Building = {
  id: "shop-1",
  name: "街角商店",
  nameEn: "Corner Shop",
  kind: "shop",
  x: 4,
  y: 7,
  w: 2,
  h: 2,
  bornAt: 0,
};

function world(seed = 1234): World {
  return {
    version: 1,
    seed,
    rng: seed,
    time: 0,
    paused: false,
    speed: 1,
    width: 20,
    height: 20,
    nextId: 1,
    networkVersion: 0,
    buildings: [home, office, shop],
    berths: [],
    tracks: [],
    residents: [],
    pods: [],
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
      enabled: true,
      complete: false,
    },
    notices: [],
    pendingEdits: [],
  };
}

describe("population", () => {
  it("creates deterministic, legal residents without adding them to the world", () => {
    const a = world();
    const b = world();
    const left = createResidents(a, home, 24);
    const right = createResidents(b, home, 24);

    expect(left).toEqual(right);
    expect(a.residents).toEqual([]);
    expect(left[0]!.nextDeparture).toBeLessThanOrEqual(30);
    expect(left.map((resident) => resident.id)).toEqual([
      ...new Set(left.map((resident) => resident.id)),
    ]);
    for (const resident of left) {
      expect(resident.homeId).toBe(home.id);
      expect(resident.workId).toBe(office.id);
      expect([office.id, shop.id]).toContain(resident.nextDestinationId);
      expect(resident.atBuildingId).toBe(home.id);
      expect(resident.name).not.toBe("");
    }
    expect(left[0].nextDestinationId).toBe(office.id);
    expect(left.some((r) => r.purpose === "shop")).toBe(true);
  });

  it("stages newly arriving residents relative to the current city clock", () => {
    const state = world();
    state.time = 8000;
    const people = createResidents(state, home, 24);
    expect(people.every((p) => p.nextDeparture > state.time)).toBe(true);
    expect(
      people.at(-1)!.nextDeparture - people[0].nextDeparture,
    ).toBeGreaterThan(1800);
  });

  it("does not rewrite an intended destination until the resident has arrived", () => {
    const state = world();
    const resident = createResidents(state, home, 1)[0]!;
    const before = {
      destination: resident.nextDestinationId,
      departure: resident.nextDeparture,
      work: resident.workId,
    };
    state.time = before.departure + 100;
    resident.atBuildingId = null;
    resident.status = "walking";
    resident.journey = {
      originId: home.id,
      destinationId: office.id,
      startedAt: 0,
      walkBaseline: 300,
      purpose: "work",
      mode: "walk",
      stage: "direct",
    };

    planNextActivity(state, resident);
    expect({
      destination: resident.nextDestinationId,
      departure: resident.nextDeparture,
      work: resident.workId,
    }).toEqual(before);

    resident.atBuildingId = office.id;
    resident.status = "inside";
    resident.journey = null;
    planNextActivity(state, resident);
    expect(resident.nextDestinationId).toBeTruthy();
    expect(resident.nextDestinationId).not.toBe(office.id);
    expect(resident.nextDeparture).toBeGreaterThanOrEqual(state.time + 75 * 60);
  });

  it("walks nearby and compares complete pod time with a stable fare preference", () => {
    const state = world();
    const resident = createResidents(state, home, 1)[0]!;
    resident.fareSensitivity = 10;
    expect(chooseTravelMode(state, resident, 120, 20)).toBe("walk");
    expect(chooseTravelMode(state, resident, 600, 500)).toBe("pod");
    expect(chooseTravelMode(state, resident, 600, 570)).toBe("walk");
  });
});
