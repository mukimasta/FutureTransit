import { describe, expect, it } from "vitest";
import { createWorld } from "../src/simulation";
import {
  chooseLeisurePlace,
  chooseWorkplace,
  commuteDeparture,
} from "../src/population/demand";
import { createResidents } from "../src/population";
import { activeCapacity } from "../src/shared/development";
import { parseWorld, serializeWorld } from "../src/persistence";
import { updateGrowth } from "../src/city";

describe("finite development and real destination demand", () => {
  it("resumes a finished legacy city without regenerating people or moving buildings", () => {
    const w = createWorld();
    delete w.growth.model;
    delete w.growth.nextKind;
    w.growth.wave = 4;
    w.growth.complete = true;
    w.time = 15000;
    for (const building of w.buildings) delete building.development;
    const loaded = parseWorld(serializeWorld(w));
    expect(loaded.residents).toEqual(w.residents);
    expect(loaded.pods).toEqual(w.pods);
    expect(loaded.tracks).toEqual(w.tracks);
    expect(loaded.buildings.map(({ x, y, w, h }) => [x, y, w, h])).toEqual(
      w.buildings.map(({ x, y, w, h }) => [x, y, w, h]),
    );
    expect(loaded.growth.complete).toBe(false);
    expect(loaded.growth.nextAt).toBeGreaterThan(loaded.time);
    loaded.time = loaded.growth.nextAt;
    updateGrowth(loaded);
    expect(loaded.buildings.length).toBeGreaterThan(w.buildings.length);
  });

  it("does not complete a housing phase while jobs are full", () => {
    const w = createWorld();
    w.growth.nextAt = 1_000_000;
    const home = w.buildings[0];
    const office = w.buildings.find((b) => b.kind === "office")!;
    office.development!.capacity = 24;
    office.development!.stage = 3;
    office.development!.nextAt = 0;
    w.time = home.development!.nextAt;
    updateGrowth(w);
    expect(home.development!.stage).toBe(1);
    expect(w.residents).toHaveLength(24);
    expect(home.development!.nextAt).toBeGreaterThan(w.time);
  });
  it("draws workers to centers without exceeding commissioned jobs", () => {
    const w = createWorld(73);
    const home = w.buildings[0];
    const center = w.buildings.find((b) => b.kind === "office")!;
    center.development = {
      capacity: 80,
      stage: 1,
      nextAt: 9000,
      district: 0,
      layout: "organic",
      role: "employment",
      shift: 0,
    };
    const local = {
      ...center,
      id: "local-office",
      development: { ...center.development, role: "local" as const },
    };
    w.buildings.push(local);
    let centerPicks = 0;
    for (let i = 0; i < 150; i++)
      if (chooseWorkplace(w, home, new Map())?.id === center.id) centerPicks++;
    expect(centerPicks).toBeGreaterThan(100);
    const full = new Map([
      [center.id, 40],
      [local.id, 40],
    ]);
    expect(chooseWorkplace(w, home, full)).toBeNull();
    full.set(local.id, 39);
    expect(chooseWorkplace(w, home, full)?.id).toBe(local.id);
    expect(activeCapacity(center)).toBe(40);
    const identity = w.nextId;
    expect(() => createResidents(w, home, 1000)).toThrow();
    expect(w.nextId).toBe(identity);
  });

  it("commercial centers attract existing people, without creating any", () => {
    const w = createWorld(92);
    const center = w.buildings.find((b) => b.kind === "shop")!;
    center.development = {
      capacity: 24,
      stage: 3,
      nextAt: 9000,
      district: 0,
      layout: "ordered",
      role: "commercial",
      shift: 0,
    };
    const local = {
      ...center,
      id: "local-shop",
      development: { ...center.development, role: "local" as const },
    };
    const before = w.residents.map((r) => r.id);
    let centerPicks = 0;
    for (let i = 0; i < 150; i++)
      if (
        chooseLeisurePlace(w, w.buildings[0], [center, local])?.id === center.id
      )
        centerPicks++;
    expect(centerPicks).toBeGreaterThan(100);
    expect(w.residents.map((r) => r.id)).toEqual(before);
  });

  it("commuter waves retain individual timing and never add over 30 minutes", () => {
    const w = createWorld(74);
    const office = w.buildings.find((b) => b.kind === "office")!;
    office.development = {
      capacity: 128,
      stage: 1,
      nextAt: 9000,
      district: 0,
      layout: "organic",
      role: "employment",
      shift: 0,
    };
    const departures = w.residents.map((r) =>
      commuteDeparture(w, r, office, 10500, false),
    );
    expect(new Set(departures).size).toBeGreaterThan(2);
    expect(departures.every((time) => time >= 10500 && time <= 12300)).toBe(
      true,
    );
  });

  it("loads ongoing growth beyond the old four-wave and 3600-grant caps", () => {
    const w = createWorld();
    w.width = 160;
    w.height = 144;
    w.growth.wave = 12;
    w.economy.pendingGrowthGrant = 9000;
    const loaded = parseWorld(serializeWorld(w));
    expect(loaded.width).toBe(160);
    expect(loaded.growth.wave).toBe(12);
    expect(loaded.economy.pendingGrowthGrant).toBe(9000);
    const broken = structuredClone(w);
    broken.buildings[0].development!.stage = 8 as 1;
    expect(() => parseWorld(serializeWorld(broken))).toThrow();
  });
});
