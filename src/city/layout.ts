import { MAX_MAP_SIZE } from "../shared/constants";
import { random } from "../shared/math";
import type { BuildingKind, World } from "../shared/types";

export interface GrowthFootprint {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: BuildingKind;
  district: number;
  layout: "organic" | "ordered";
}

export interface GrowthLayout {
  footprints: GrowthFootprint[];
  width: number;
  height: number;
  expanded: "east" | "south" | null;
}

interface Rectangle {
  x: number;
  y: number;
  w: number;
  h: number;
}

const integer = (world: World, min: number, max: number) =>
  min + Math.floor(random(world) * (max - min + 1));

function buildingSize(world: World, kind: BuildingKind) {
  if (kind === "office")
    return { w: integer(world, 4, 7), h: integer(world, 3, 6) };
  if (kind === "shop")
    return { w: integer(world, 3, 6), h: integer(world, 3, 5) };
  return { w: integer(world, 3, 6), h: integer(world, 3, 5) };
}

function intersects(a: Rectangle, b: Rectangle, margin = 0): boolean {
  return (
    a.x - margin <= b.x + b.w - 1 &&
    a.x + a.w - 1 + margin >= b.x &&
    a.y - margin <= b.y + b.h - 1 &&
    a.y + a.h - 1 + margin >= b.y
  );
}

function pointInside(
  point: { x: number; y: number },
  area: Rectangle,
  margin = 0,
): boolean {
  return (
    point.x >= area.x - margin &&
    point.x <= area.x + area.w - 1 + margin &&
    point.y >= area.y - margin &&
    point.y <= area.y + area.h - 1 + margin
  );
}

function segmentTouches(
  area: Rectangle,
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  if (pointInside(a, area) || pointInside(b, area)) return true;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return (
    maxX >= area.x &&
    minX <= area.x + area.w - 1 &&
    maxY >= area.y &&
    minY <= area.y + area.h - 1
  );
}

/**
 * A site keeps a two-cell approach on every side. That is enough for a future
 * berth point plus its access cell, and also makes the default south door usable.
 */
export function clearDevelopmentSite(
  world: World,
  candidate: Rectangle,
  planned: readonly Rectangle[],
  width = world.width,
  height = world.height,
): boolean {
  if (
    candidate.x < 2 ||
    candidate.y < 2 ||
    candidate.x + candidate.w + 1 >= width ||
    candidate.y + candidate.h + 1 >= height
  )
    return false;
  if (
    world.buildings.some((building) => intersects(candidate, building, 2)) ||
    planned.some((building) => intersects(candidate, building, 2))
  )
    return false;

  const approach = {
    x: candidate.x - 2,
    y: candidate.y - 2,
    w: candidate.w + 4,
    h: candidate.h + 4,
  };
  if (
    world.berths.some(
      (berth) =>
        pointInside(berth.point, approach) ||
        pointInside(berth.access, approach),
    ) ||
    world.tracks.some((track) => segmentTouches(approach, track.a, track.b))
  )
    return false;

  // Existing doors remain valid even on buildings without a berth yet.
  if (
    world.buildings.some((building) =>
      pointInside(
        {
          x: building.x + Math.floor((building.w - 1) / 2),
          y: building.y + building.h,
        },
        approach,
      ),
    )
  )
    return false;

  return !world.residents.some(
    (resident) =>
      resident.journey?.walk &&
      resident.journey.walk.end > world.time &&
      resident.journey.walk.path.some((point) => pointInside(point, approach)),
  );
}

function kindsForEvent(
  wave: number,
  event: "expansion" | "infill",
): BuildingKind[] {
  if (event === "infill") {
    const phase = Math.floor(wave / 2) % 4;
    return [["shop"], ["home"], ["office"], ["home", "shop"]][
      phase
    ]!.slice() as BuildingKind[];
  }
  if (wave % 6 === 4) return ["home", "home", "office", "shop"];
  if (wave % 6 === 0) return ["office", "shop", "shop"];
  return ["home", "office", "shop"];
}

function dimensionsForExpansion(world: World, wave: number) {
  if (wave < 2 || (world.width >= MAX_MAP_SIZE && world.height >= MAX_MAP_SIZE))
    return {
      width: world.width,
      height: world.height,
      expanded: null,
    } as const;
  const east = Math.floor(wave / 2) % 2 === 1;
  const strip = integer(world, 10, 14);
  if ((east && world.width < MAX_MAP_SIZE) || world.height >= MAX_MAP_SIZE)
    return {
      width: Math.min(MAX_MAP_SIZE, world.width + strip),
      height: world.height,
      expanded: "east" as const,
    };
  return {
    width: world.width,
    height: Math.min(MAX_MAP_SIZE, world.height + strip),
    expanded: "south" as const,
  };
}

function randomCandidate(
  world: World,
  kind: BuildingKind,
  width: number,
  height: number,
  event: "expansion" | "infill",
  expanded: "east" | "south" | null,
  anchor: { x: number; y: number } | null,
  layout: "organic" | "ordered",
  orderedIndex: number,
): Rectangle & { kind: BuildingKind } {
  const size = buildingSize(world, kind);
  const maxX = width - size.w - 2;
  const maxY = height - size.h - 2;
  let x: number;
  let y: number;

  if (anchor && event === "expansion") {
    if (layout === "ordered") {
      // Ordered districts share a strict, berth-accessible block grid.
      const column = orderedIndex % 2;
      const row = Math.floor(orderedIndex / 2);
      x = anchor.x + column * 10;
      y = anchor.y + row * 9;
    } else {
      // Organic districts remain compact but deliberately irregular.
      x = anchor.x + integer(world, -12, 12);
      y = anchor.y + integer(world, -10, 10);
    }
  } else if (expanded === "east") {
    x = integer(world, Math.max(2, world.width - 8), maxX);
    y = integer(world, 2, maxY);
  } else if (expanded === "south") {
    x = integer(world, 2, maxX);
    y = integer(world, Math.max(2, world.height - 8), maxY);
  } else {
    // Infill favors the old core; the edge is left for later district growth.
    const coreMaxX = Math.max(2, Math.min(maxX, Math.floor(width * 0.76)));
    const coreMaxY = Math.max(2, Math.min(maxY, Math.floor(height * 0.76)));
    x = integer(world, 2, coreMaxX);
    y = integer(world, 2, coreMaxY);
  }
  return {
    kind,
    ...size,
    x: Math.max(2, Math.min(maxX, x)),
    y: Math.max(2, Math.min(maxY, y)),
  };
}

/** Plans one atomic district/infill event without moving existing geometry. */
export function planGrowthLayout(
  world: World,
  event: "expansion" | "infill",
  maximumBuildings: number,
): GrowthLayout | null {
  const district = world.growth.wave + 1;
  const layout: "organic" | "ordered" =
    event === "expansion" && Math.floor(world.growth.wave / 2) % 4 === 3
      ? "ordered"
      : "organic";
  const dimensions =
    event === "expansion"
      ? dimensionsForExpansion(world, world.growth.wave)
      : { width: world.width, height: world.height, expanded: null as null };
  const kinds = kindsForEvent(world.growth.wave, event).slice(
    0,
    maximumBuildings,
  );
  if (!kinds.length) return null;

  // Retry the whole cluster so failed attempts never leave a partial district.
  for (let clusterAttempt = 0; clusterAttempt < 24; clusterAttempt += 1) {
    const planned: GrowthFootprint[] = [];
    let anchor: { x: number; y: number } | null = null;
    for (let index = 0; index < kinds.length; index += 1) {
      const kind = kinds[index]!;
      let placed: GrowthFootprint | null = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const candidate = randomCandidate(
          world,
          kind,
          dimensions.width,
          dimensions.height,
          event,
          dimensions.expanded,
          anchor,
          layout,
          index,
        );
        if (
          clearDevelopmentSite(
            world,
            candidate,
            planned,
            dimensions.width,
            dimensions.height,
          )
        ) {
          placed = { ...candidate, district, layout };
          anchor ??= { x: candidate.x, y: candidate.y };
          break;
        }
      }
      if (!placed) break;
      planned.push(placed);
    }
    if (planned.length === kinds.length)
      return { footprints: planned, ...dimensions };
  }
  return null;
}
