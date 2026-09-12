import { describe, expect, it } from "vitest";
import { applyCommand, createWorld } from "../src/simulation";
import { editorContext, placementPreview, trackStart } from "../src/ui/editor";

function emptyWorld() {
  const world = createWorld();
  world.buildings = [];
  world.berths = [];
  world.tracks = [];
  world.pods = [];
  world.residents = [];
  world.reservations = [];
  return world;
}

describe("unified map editor", () => {
  it("starts track from the closest existing endpoint", () => {
    const world = emptyWorld();
    applyCommand(world, {
      type: "build-track",
      points: [
        { x: 10, y: 10 },
        { x: 11, y: 10 },
      ],
    });
    const context = editorContext(
      world,
      { kind: "track", id: world.tracks[0].id },
      { x: 11, y: 10 },
    )!;
    expect(trackStart(world, context)).toEqual({ x: 11, y: 10 });
    const preview = placementPreview(world, context, "parking", {
      x: 11,
      y: 12,
    })!;
    expect(preview.valid).toBe(true);
    expect(preview.point).toEqual({ x: 11, y: 11 });
    expect(preview.access).toEqual(context.point);
    expect(applyCommand(world, preview.command).ok).toBe(true);
    expect(world.berths[0].access).toEqual(context.point);
  });

  it("uses a station access, never its occupied bay, as the track origin", () => {
    const world = emptyWorld();
    applyCommand(world, {
      type: "add-platform",
      point: { x: 10, y: 10 },
      side: "east",
    });
    const berth = world.berths[0];
    const context = editorContext(world, { kind: "berth", id: berth.id })!;
    expect(trackStart(world, context)).toEqual(berth.access);
    expect(
      placementPreview(world, context, "parking", berth.point)?.valid,
    ).toBe(false);
    const preview = placementPreview(world, context, "platform", {
      x: 11,
      y: 12,
    })!;
    expect(preview.valid).toBe(true);
    expect(applyCommand(world, preview.command).ok).toBe(true);
    expect(world.berths[1].access).toEqual(berth.access);
  });

  it("keeps a free-land bay fixed while the mouse changes its connection direction", () => {
    const world = emptyWorld();
    const context = editorContext(world, null, { x: 10, y: 10 })!;
    const cash = world.economy.cash;
    const north = placementPreview(world, context, "parking", { x: 10, y: 5 })!;
    const east = placementPreview(world, context, "parking", { x: 15, y: 10 })!;
    expect(north.point).toEqual(context.point);
    expect(north.access).toEqual({ x: 10, y: 9 });
    expect(east.point).toEqual(context.point);
    expect(east.access).toEqual({ x: 11, y: 10 });
    expect(world.economy.cash).toBe(cash);
    expect(world.berths).toHaveLength(0);
    expect(placementPreview(world, context, "parking", null)).toBeNull();
    world.economy.cash = 0;
    expect(
      placementPreview(world, context, "parking", { x: 15, y: 10 })?.valid,
    ).toBe(false);
  });

  it("keeps indoor platforms attached but building-side parking independent", () => {
    const world = createWorld();
    const context = editorContext(world, { kind: "building", id: "b-office" })!;
    const pointer = { x: context.point.x + 5, y: context.point.y };
    const station = placementPreview(world, context, "platform", pointer)!;
    expect(station.valid).toBe(true);
    expect(station.command).toEqual({
      type: "add-platform",
      buildingId: "b-office",
      side: "east",
    });
    const parking = placementPreview(world, context, "parking", pointer)!;
    expect(parking.valid).toBe(true);
    expect(parking.command).not.toHaveProperty("buildingId");
    expect(applyCommand(world, parking.command).ok).toBe(true);
    expect(world.berths.at(-1)?.point).toEqual(parking.point);
    expect(world.berths.at(-1)?.access).toEqual(parking.access);
  });
});
