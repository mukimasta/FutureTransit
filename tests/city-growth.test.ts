import { describe, expect, it } from "vitest";
import { updateGrowth } from "../src/city";
import { createWorld } from "../src/simulation";
import { MAX_BUILDINGS, MAX_RESIDENTS } from "../src/shared/constants";
import { activeCapacity } from "../src/shared/development";
import type { Building, Point, World } from "../src/shared/types";

function prepare(seed = 71): World {
  const world = createWorld(seed);
  world.growth.model = 2;
  world.growth.nextKind = "expansion";
  world.growth.nextAt = 3600;
  world.growth.announced = false;
  world.growth.complete = false;
  return world;
}

function grow(world: World, events: number) {
  for (let index = 0; index < events; index += 1) {
    world.time = world.growth.nextAt;
    updateGrowth(world);
  }
}

const inside = (point: Point, building: Building, margin = 0) =>
  point.x >= building.x - margin &&
  point.x <= building.x + building.w - 1 + margin &&
  point.y >= building.y - margin &&
  point.y <= building.y + building.h - 1 + margin;

describe("continuous city growth", () => {
  it("preserves infrastructure and live walking space through later districts", () => {
    const world = prepare();
    const initialGeometry = world.buildings.map(({ id, x, y, w, h }) => ({
      id,
      x,
      y,
      w,
      h,
    }));
    world.tracks.push({
      id: "protected-crosstown",
      a: { x: 1, y: 40 },
      b: { x: 62, y: 40 },
      paid: 0,
    });
    const walker = world.residents[0]!;
    const livePath = Array.from({ length: 62 }, (_, index) => ({
      x: index + 1,
      y: 36,
    }));
    walker.status = "walking";
    walker.atBuildingId = null;
    walker.journey = {
      originId: walker.homeId,
      destinationId: walker.workId,
      startedAt: 0,
      walkBaseline: 100,
      purpose: "work",
      mode: "walk",
      stage: "direct",
      walk: { path: livePath, start: 0, end: 100_000 },
    };
    const berths = structuredClone(world.berths);
    const tracks = structuredClone(world.tracks);

    grow(world, 10);

    expect(
      world.buildings
        .slice(0, 3)
        .map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    ).toEqual(initialGeometry);
    expect(world.berths).toEqual(berths);
    expect(world.tracks).toEqual(tracks);
    for (const building of world.buildings.slice(3)) {
      expect(
        world.berths.some(
          (berth) =>
            inside(berth.point, building, 2) ||
            inside(berth.access, building, 2),
        ),
      ).toBe(false);
      expect(livePath.some((point) => inside(point, building, 2))).toBe(false);
      expect(inside({ x: 20, y: 40 }, building, 2)).toBe(false);
    }
  });

  it("fills homes from half occupancy to full with durable resident IDs", () => {
    const world = prepare();
    world.growth.nextAt = 1_000_000;
    const home = world.buildings.find((building) => building.id === "b-home")!;
    expect(home.development?.stage).toBe(1);
    expect(activeCapacity(home)).toBe(24);
    expect(
      world.residents.filter((resident) => resident.homeId === home.id),
    ).toHaveLength(24);

    while (home.development!.stage < 3) {
      const next = Math.min(
        ...world.buildings
          .filter(
            (building) =>
              building.development && building.development.stage < 3,
          )
          .map((building) => building.development!.nextAt),
      );
      world.time = next;
      updateGrowth(world);
    }

    const residents = world.residents.filter(
      (resident) => resident.homeId === home.id,
    );
    expect(residents).toHaveLength(home.development!.capacity);
    expect(new Set(world.residents.map((resident) => resident.id)).size).toBe(
      world.residents.length,
    );
    expect(world.residents.length).toBeLessThanOrEqual(MAX_RESIDENTS);
  });

  it("freezes due development while disabled and reports hard limits without completion", () => {
    const world = prepare();
    world.growth.enabled = false;
    world.time = 100_000;
    const stages = world.buildings.map(
      (building) => building.development?.stage,
    );
    const residents = world.residents.length;
    updateGrowth(world);
    expect(
      world.buildings.map((building) => building.development?.stage),
    ).toEqual(stages);
    expect(world.residents).toHaveLength(residents);
    expect(world.growth.nextAt).toBeGreaterThan(world.time);
    expect(
      world.buildings
        .filter((building) => building.development!.stage < 3)
        .every((building) => building.development!.nextAt > world.time),
    ).toBe(true);

    world.growth.enabled = true;
    updateGrowth(world);
    expect(world.residents).toHaveLength(residents);
    while (world.buildings.length < MAX_BUILDINGS)
      world.buildings.push({
        id: `limit-${world.buildings.length}`,
        name: "limit",
        nameEn: "limit",
        kind: "shop",
        x: 2,
        y: 2,
        w: 1,
        h: 1,
        bornAt: world.time,
        development: {
          capacity: 1,
          stage: 3,
          nextAt: 0,
          district: 999,
          layout: "organic",
          role: "local",
          shift: 0,
        },
      });
    world.time = world.growth.nextAt;
    updateGrowth(world);
    expect(world.growth.limited).toBe("buildings");
    expect(world.growth.complete).toBe(false);
  });
});
