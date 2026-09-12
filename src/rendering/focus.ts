import { residentPosition } from "../shared/selectors";
import type { Point, Resident, World } from "../shared/types";

/** Indoors residents remain inspectable: the camera follows their building,
 * while the map still intentionally draws no person inside its footprint. */
export function residentFocusPoint(
  world: World,
  resident: Resident,
  time = world.time,
): Point | null {
  const outside = residentPosition(world, resident, time);
  if (outside) return outside;
  const building = world.buildings.find((b) => b.id === resident.atBuildingId);
  return building
    ? {
        x: building.x + (building.w - 1) / 2,
        y: building.y + (building.h - 1) / 2,
      }
    : null;
}
