import type { Command, Point, Selection, Side, World } from "../shared/types";
import { PARKING_COST, PLATFORM_COST } from "../shared/constants";
import { distance } from "../shared/math";
import { buildingDoor } from "../network";
import { berthPlacement, canPlaceBerth } from "../simulation";

export type BuildKind = "track" | "parking" | "platform";
export interface EditorContext {
  point: Point;
  selection: Selection;
}
export interface PlacementPreview {
  kind: "parking" | "platform";
  point: Point;
  access: Point;
  command: Command;
  cost: number;
  valid: boolean;
}
const offset: Record<Side, Point> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};
const opposite: Record<Side, Side> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

/** Every infrastructure selection opens the same menu at a real network anchor. */
export function editorContext(
  world: World,
  selection: Selection,
  clicked?: Point,
): EditorContext | null {
  if (!selection) return clicked ? { point: clicked, selection: null } : null;
  if (selection.kind === "track") {
    const track = world.tracks.find((t) => t.id === selection.id);
    if (!track) return null;
    const point =
      clicked && distance(clicked, track.b) < distance(clicked, track.a)
        ? track.b
        : track.a;
    return { point, selection };
  }
  if (selection.kind === "berth") {
    const berth = world.berths.find((b) => b.id === selection.id);
    return berth ? { point: berth.access, selection } : null;
  }
  if (selection.kind === "building") {
    const building = world.buildings.find((b) => b.id === selection.id);
    return building
      ? {
          point: {
            x: building.x + (building.w - 1) / 2,
            y: building.y + (building.h - 1) / 2,
          },
          selection,
        }
      : null;
  }
  return null;
}

export function trackStart(world: World, context: EditorContext): Point {
  if (context.selection?.kind !== "building") return context.point;
  const building = world.buildings.find((b) => b.id === context.selection!.id);
  if (!building) return context.point;
  return (
    world.berths.find(
      (b) => b.kind === "platform" && b.buildingId === building.id,
    )?.access ?? buildingDoor(building)
  );
}

export function placementPreview(
  world: World,
  context: EditorContext,
  kind: "parking" | "platform",
  pointer: Point | null,
): PlacementPreview | null {
  if (!pointer || distance(pointer, context.point) < 0.3) return null;
  const dx = pointer.x - context.point.x,
    dy = pointer.y - context.point.y;
  const outward: Side =
    Math.abs(dx) > Math.abs(dy)
      ? dx > 0
        ? "east"
        : "west"
      : dy > 0
        ? "south"
        : "north";
  const building =
    context.selection?.kind === "building"
      ? world.buildings.find((b) => b.id === context.selection!.id)
      : undefined;
  const attached = building
    ? berthPlacement(world, building, kind, outward)
    : null;
  // On existing track/stations, add the bay beside the network anchor, facing
  // back towards it. On free land, the clicked cell is the bay itself.
  const onNetwork =
    context.selection?.kind === "track" || context.selection?.kind === "berth";
  const side = onNetwork ? opposite[outward] : outward;
  const point =
    attached?.point ??
    (onNetwork
      ? {
          x: context.point.x + offset[outward].x,
          y: context.point.y + offset[outward].y,
        }
      : context.point);
  const access = attached?.access ?? {
    x: point.x + offset[side].x,
    y: point.y + offset[side].y,
  };
  const command: Command =
    kind === "platform"
      ? building
        ? { type: "add-platform", buildingId: building.id, side: outward }
        : { type: "add-platform", point, side }
      : { type: "add-parking", point, side: attached ? outward : side };
  const cost = kind === "parking" ? PARKING_COST : PLATFORM_COST;
  return {
    kind,
    point,
    access,
    command,
    cost,
    valid:
      (!building || !!attached) &&
      canPlaceBerth(world, point, attached ? outward : side) &&
      world.economy.cash >= cost,
  };
}
