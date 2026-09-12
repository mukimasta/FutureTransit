import { describe, expect, it } from "vitest";
import { applyCommand, createWorld, stepWorld } from "../src/simulation";
import { parseWorld, serializeWorld } from "../src/persistence";

describe("long running sandbox", () => {
  it("runs six city hours of growth and keeps a restorable consistent world", () => {
    const world = createWorld(71);
    const before = performance.now();
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
        points: [
          { x: 10, y: 16 },
          { x: office.access.x, y: 16 },
          office.access,
        ],
      }).ok,
    ).toBe(true);
    world.paused = false;
    for (let i = 0; i < 12; i++) {
      stepWorld(world, 1800);
      expect(() => parseWorld(serializeWorld(world))).not.toThrow();
      expect(
        world.residents.every((r) =>
          r.journey ? r.atBuildingId === null : !!r.atBuildingId,
        ),
      ).toBe(true);
    }
    expect(world.time).toBe(21600);
    expect(world.buildings.length).toBeGreaterThan(14);
    expect(world.residents.length).toBeGreaterThan(24);
    expect(world.metrics.served).toBeGreaterThan(10);
    expect(world.growth.complete).toBe(false);
    console.log(
      JSON.stringify({
        name: "six-hour-city",
        cpuMs: Math.round(performance.now() - before),
        buildings: world.buildings.length,
        residents: world.residents.length,
        served: world.metrics.served,
        walked: world.metrics.walked,
        reservations: world.reservations.length,
      }),
    );
  }, 60000);
});
