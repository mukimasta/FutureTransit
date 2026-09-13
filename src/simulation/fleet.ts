import { pointKey } from "../shared/math";
import { trackPathLength } from "../network";
import type { Berth, Pod, World } from "../shared/types";

/**
 * Which Pods are reachable depends on where the idle ones are parked and on the
 * network, not on who is waiting, so a dispatch pass asking berth after berth
 * reuses one answer per platform until a Pod takes or finishes a plan.
 */
interface ReachableCache {
  berths: Berth[];
  pods: Pod[];
  networkVersion: number;
  idle: (string | null)[];
  byPickup: Map<string, Pod[]>;
}
const reachableCaches = new WeakMap<World, ReachableCache>();

function idleStampMatches(cache: ReachableCache, pods: Pod[]): boolean {
  if (cache.idle.length !== pods.length) return false;
  for (let index = 0; index < pods.length; index += 1)
    if (cache.idle[index] !== (pods[index].plan ? null : pods[index].berthId))
      return false;
  return true;
}

export function reachableIdlePods(world: World, pickup: Berth): Pod[] {
  let cache = reachableCaches.get(world);
  if (
    !cache ||
    cache.berths !== world.berths ||
    cache.pods !== world.pods ||
    cache.networkVersion !== world.networkVersion ||
    !idleStampMatches(cache, world.pods)
  ) {
    cache = {
      berths: world.berths,
      pods: world.pods,
      networkVersion: world.networkVersion,
      idle: world.pods.map((pod) => (pod.plan ? null : pod.berthId)),
      byPickup: new Map(),
    };
    reachableCaches.set(world, cache);
  }
  const hit = cache.byPickup.get(pickup.id);
  if (hit) return hit;
  const berthsById = new Map(world.berths.map((berth) => [berth.id, berth]));
  const reachable = world.pods
    .filter((p) => !p.plan && p.berthId)
    .flatMap((pod) => {
      const origin = berthsById.get(pod.berthId!);
      const length = origin
        ? trackPathLength(world, origin.point, pickup.point)
        : null;
      return length === null ? [] : [{ pod, length }];
    })
    .sort((a, b) => a.length - b.length || a.pod.id.localeCompare(b.pod.id))
    .map((entry) => entry.pod);
  cache.byPickup.set(pickup.id, reachable);
  return reachable;
}

export interface ParkingGroup {
  berthIds: string[];
  podIds: string[];
  parking: number;
  platforms: number;
  shortage: number;
}

/** Platforms are passenger interfaces, never fleet storage capacity. One parking
 * berth per Pod is sufficient: an atomic service plan may reserve its own
 * vacated origin as its terminal. Extra parking improves positioning, not safety. */
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
      ? Math.max(0, group.podIds.length - group.parking)
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
  return group ? Math.max(0, group.podIds.length + 1 - group.parking) : 1;
}
