import { describe, expect, it } from "vitest";
import {
  initialBuildings,
  initializeCityGrowth,
  recordDelivery,
  updateEconomy,
  updateGrowth,
} from "../src/city";
import type { World } from "../src/shared/types";

function world(seed = 71): World {
  return {
    version: 1,
    seed,
    rng: seed,
    time: 0,
    paused: false,
    speed: 1,
    width: 64,
    height: 44,
    nextId: 1,
    networkVersion: 0,
    buildings: initialBuildings(),
    berths: [],
    tracks: [],
    residents: [],
    pods: [],
    reservations: [],
    economy: {
      cash: 1900,
      income: 0,
      maintenance: 0,
      subsidy: 0,
      spent: 0,
      nextGrantAt: 1800,
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
      nextAt: 10,
      announced: false,
      enabled: true,
      complete: false,
      model: 2,
      nextKind: "expansion",
    },
    notices: [],
    pendingEdits: [],
  };
}

function growOne(state: World): void {
  state.time = state.growth.nextAt;
  updateGrowth(state);
}

describe("city", () => {
  it("keeps growing reproducibly beyond the old four-wave city", () => {
    const a = world();
    const b = world();
    for (let index = 0; index < 10; index += 1) {
      growOne(a);
      growOne(b);
    }
    expect(a.buildings).toEqual(b.buildings);
    expect(a.residents).toEqual(b.residents);
    expect(a.buildings.length).toBeGreaterThan(14);
    expect(a.growth.wave).toBe(10);
    expect(a.growth.complete).toBe(false);
    expect(a.width > 64 || a.height > 44).toBe(true);
    expect(
      new Set(a.buildings.map((building) => `${building.w}x${building.h}`))
        .size,
    ).toBeGreaterThan(3);
    expect(
      a.buildings.some(
        (building) => building.development?.layout === "organic",
      ),
    ).toBe(true);
    expect(
      a.buildings.some(
        (building) => building.development?.layout === "ordered",
      ),
    ).toBe(true);
    for (const building of a.buildings) {
      expect(building.x).toBeGreaterThanOrEqual(0);
      expect(building.y).toBeGreaterThanOrEqual(0);
      expect(building.x + building.w).toBeLessThanOrEqual(a.width);
      expect(building.y + building.h).toBeLessThanOrEqual(a.height);
    }
    for (let left = 0; left < a.buildings.length; left += 1)
      for (let right = left + 1; right < a.buildings.length; right += 1) {
        const xOverlap =
          a.buildings[left]!.x <=
            a.buildings[right]!.x + a.buildings[right]!.w - 1 &&
          a.buildings[left]!.x + a.buildings[left]!.w - 1 >=
            a.buildings[right]!.x;
        const yOverlap =
          a.buildings[left]!.y <=
            a.buildings[right]!.y + a.buildings[right]!.h - 1 &&
          a.buildings[left]!.y + a.buildings[left]!.h - 1 >=
            a.buildings[right]!.y;
        expect(xOverlap && yOverlap).toBe(false);
      }
    for (const resident of a.residents)
      expect(
        a.buildings.find((building) => building.id === resident.homeId)?.kind,
      ).toBe("home");
  });

  it("does not accumulate deferred growth", () => {
    const state = world();
    state.growth.enabled = false;
    state.time = 99_000;
    updateGrowth(state);
    expect(state.buildings).toHaveLength(3);
    const deferredUntil = state.growth.nextAt;
    state.growth.enabled = true;
    updateGrowth(state);
    expect(state.buildings).toHaveLength(3);
    expect(deferredUntil).toBeGreaterThan(state.time);
  });

  it("migrates a completed legacy city without moving or reassigning entities", () => {
    const state = world();
    state.time = 20_000;
    state.growth.complete = true;
    delete state.growth.model;
    delete state.growth.nextKind;
    for (const building of state.buildings) delete building.development;
    const geometry = state.buildings.map(({ id, x, y, w, h }) => ({
      id,
      x,
      y,
      w,
      h,
    }));
    const residents = structuredClone(state.residents);

    initializeCityGrowth(state);

    expect(
      state.buildings.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    ).toEqual(geometry);
    expect(state.residents).toEqual(residents);
    expect(state.buildings.every((building) => building.development)).toBe(
      true,
    );
    expect(state.growth.complete).toBe(false);
    expect(state.growth.nextAt).toBeGreaterThanOrEqual(state.time + 600);
  });

  it("settles grants and maintenance deterministically without consuming construction cash beyond fare allowance", () => {
    const a = world();
    const b = world();
    for (const state of [a, b]) {
      state.tracks.push({
        id: "t",
        a: { x: 1, y: 1 },
        b: { x: 2, y: 1 },
        paid: 3000,
      });
      state.economy.cash = 100;
      state.time = 1800;
      updateEconomy(state, 1800);
    }
    expect(a.economy).toEqual(b.economy);
    expect(a.economy.cash).toBe(100);
    expect(a.economy.maintenance).toBe(0);
    expect(a.economy.subsidy).toBe(0);
    expect(a.economy.pendingGrant).toBe(280);
    a.economy.cash = 3100;
    a.time = 3600;
    updateEconomy(a, 1800);
    expect(a.economy.nextGrantAt).toBe(5400);
  });

  it("records only actual Pod fare deliveries, preserves negative time savings, and bounds trip history", () => {
    const state = world();
    recordDelivery(state, {
      residentId: "r",
      originId: "a",
      destinationId: "b",
      mode: "walk",
      startedAt: 0,
      endedAt: 130,
      walkBaseline: 100,
      waited: 2,
    });
    recordDelivery(state, {
      residentId: "r",
      originId: "a",
      destinationId: "b",
      mode: "pod",
      startedAt: 200,
      endedAt: 260,
      walkBaseline: 100,
      waited: 4,
    });
    expect(state.economy.income).toBe(4);
    expect(state.economy.cash).toBe(1904);
    expect(state.metrics.walked).toBe(1);
    expect(state.metrics.served).toBe(1);
    expect(state.metrics.savedSeconds).toBe(10);
    expect(state.metrics.totalWait).toBe(6);
    for (let index = 0; index < 200; index += 1)
      recordDelivery(state, {
        residentId: String(index),
        originId: "a",
        destinationId: "b",
        mode: "walk",
        startedAt: 0,
        endedAt: 2,
        walkBaseline: 1,
        waited: 0,
      });
    expect(state.metrics.recentTrips).toHaveLength(160);
  });
});
