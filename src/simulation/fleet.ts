import { pathLength, pointKey } from "../shared/math";
import { findTrackPath } from "../network";
import type { Berth, Pod, World } from "../shared/types";

export function reachableIdlePods(world: World, pickup: Berth): Pod[] {
  return world.pods
    .filter((p) => !p.plan && p.berthId)
    .flatMap((pod) => {
      const origin = world.berths.find((b) => b.id === pod.berthId);
      const path = origin
        ? findTrackPath(world, origin.point, pickup.point)
        : null;
      return path ? [{ pod, length: pathLength(path) }] : [];
    })
    .sort((a, b) => a.length - b.length || a.pod.id.localeCompare(b.pod.id))
    .map((entry) => entry.pod);
}

export interface ParkingGroup {
  berthIds: string[];
  podIds: string[];
  parking: number;
  platforms: number;
  shortage: number;
}

/** Platforms are passenger interfaces, never fleet storage capacity. A network
 * keeps one unassigned parking slot in addition to one per Pod for circulation. */
export function parkingGroups(world: World): ParkingGroup[] {
  const parents = new Map<string, string>();
  const root = (key: string): string => {
    if (!parents.has(key)) parents.set(key, key);
    let cursor = key;
    while (parents.get(cursor) !== cursor) cursor = parents.get(cursor)!;
    return cursor;
  };
  const join = (a: string, b: string) => parents.set(root(a), root(b));
  for (const track of world.tracks) join(pointKey(track.a), pointKey(track.b));
  for (const berth of world.berths)
    join(pointKey(berth.point), pointKey(berth.access));
  const groups = new Map<string, ParkingGroup>();
  for (const berth of world.berths) {
    const key = root(pointKey(berth.point));
    const group = groups.get(key) ?? {
      berthIds: [],
      podIds: [],
      parking: 0,
      platforms: 0,
      shortage: 0,
    };
    group.berthIds.push(berth.id);
    if (berth.kind === "parking") group.parking++;
    else group.platforms++;
    groups.set(key, group);
  }
  for (const pod of world.pods) {
    const berth = world.berths.find(
      (b) => b.id === (pod.plan?.finalBerthId ?? pod.berthId),
    );
    if (berth) groups.get(root(pointKey(berth.point)))?.podIds.push(pod.id);
  }
  for (const group of groups.values())
    group.shortage = group.podIds.length
      ? Math.max(0, group.podIds.length + 1 - group.parking)
      : 0;
  return [...groups.values()];
}
export function parkingShortage(world: World): number {
  return parkingGroups(world).reduce((sum, g) => sum + g.shortage, 0);
}
/** Old saves are preserved; edits may repair but may not worsen their shortage. */
export function parkingEditAllowed(before: World, after: World): boolean {
  return parkingShortage(after) <= parkingShortage(before);
}
export function parkingPurchaseShortage(world: World, berthId: string): number {
  const group = parkingGroups(world).find((g) => g.berthIds.includes(berthId));
  return group ? Math.max(0, group.podIds.length + 2 - group.parking) : 1;
}
