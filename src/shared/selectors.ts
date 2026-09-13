import type { Berth, Language, Pod, Point, Resident, World } from "./types";
import { alongPath } from "./math";
import { movementLaneIndex, trackBetween } from "../network";

/**
 * Rendering resamples every Pod and Resident 60 times a second, so the lookups
 * those samples share are built once per world snapshot instead of once per
 * sample. A snapshot is a fresh object from the worker, so the entries never
 * go stale.
 */
interface FrameIndex {
  time: number;
  residents: Resident[];
  berths: Berth[];
  pods: Pod[];
  berthsById: Map<string, Berth>;
  podsById: Map<string, Pod>;
  /**
   * Position of each waiting Resident within its pickup queue, in the same
   * `world.residents` order the queue used to be filtered out of.
   */
  queuePlaces: Map<string, number>;
}
const frameIndexes = new WeakMap<World, FrameIndex>();

function frameIndex(world: World): FrameIndex {
  const existing = frameIndexes.get(world);
  if (
    existing &&
    existing.time === world.time &&
    existing.residents === world.residents &&
    existing.berths === world.berths &&
    existing.pods === world.pods
  )
    return existing;
  const queuePlaces = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const resident of world.residents) {
    const pickupId = resident.journey?.pickupId;
    if (resident.status !== "waiting" || !pickupId) continue;
    const place = counts.get(pickupId) ?? 0;
    counts.set(pickupId, place + 1);
    queuePlaces.set(resident.id, place);
  }
  const index: FrameIndex = {
    time: world.time,
    residents: world.residents,
    berths: world.berths,
    pods: world.pods,
    berthsById: new Map(world.berths.map((berth) => [berth.id, berth])),
    podsById: new Map(world.pods.map((pod) => [pod.id, pod])),
    queuePlaces,
  };
  frameIndexes.set(world, index);
  return index;
}

export function podPosition(world: World, pod: Pod, time = world.time): Point {
  const plan = pod.plan;
  if (plan) {
    const segment = plan.segments.find((s) => s.start <= time && time < s.end);
    if (segment) {
      const t = Math.max(
        0,
        Math.min(1, (time - segment.start) / (segment.end - segment.start)),
      );
      const position = {
        x: segment.from.x + (segment.to.x - segment.from.x) * t,
        y: segment.from.y + (segment.to.y - segment.from.y) * t,
      };
      if (segment.kind === "move") {
        const lanes = trackBetween(world, segment.from, segment.to)?.lanes ?? 1;
        const laneIndex = movementLaneIndex(
          world,
          segment.from,
          segment.to,
          segment.resources,
        );
        const [first, second] =
          segment.from.x < segment.to.x ||
          (segment.from.x === segment.to.x && segment.from.y <= segment.to.y)
            ? [segment.from, segment.to]
            : [segment.to, segment.from];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const length = Math.hypot(dx, dy);
        if (lanes > 1 && laneIndex !== null && length > 0) {
          const offset = ((lanes - 1) / 2 - laneIndex) * 0.26;
          return {
            x: position.x + (dy / length) * offset,
            y: position.y - (dx / length) * offset,
          };
        }
      }
      return position;
    }
    const berthId =
      time < plan.departure ? plan.originBerthId : plan.finalBerthId;
    return (
      frameIndex(world).berthsById.get(berthId)?.point ??
      plan.segments.at(-1)?.to ?? { x: 0, y: 0 }
    );
  }
  return (
    (pod.berthId ? frameIndex(world).berthsById.get(pod.berthId) : undefined)
      ?.point ?? { x: 0, y: 0 }
  );
}
export function residentPosition(
  world: World,
  resident: Resident,
  time = world.time,
): Point | null {
  if (resident.status === "inside") return null;
  const journey = resident.journey;
  if (!journey) return null;
  if (["boarding", "riding", "alighting"].includes(resident.status)) {
    const pod = journey.podId
      ? frameIndex(world).podsById.get(journey.podId)
      : undefined;
    return pod ? podPosition(world, pod, time) : null;
  }
  if (resident.status === "walking" && journey.walk)
    return alongPath(
      journey.walk.path,
      (time - journey.walk.start) / (journey.walk.end - journey.walk.start),
    );
  const index = frameIndex(world);
  const berth = journey.pickupId
    ? index.berthsById.get(journey.pickupId)
    : undefined;
  if (!berth) return null;
  const place = index.queuePlaces.get(resident.id) ?? -1;
  return {
    x: berth.point.x + 0.48 + (place % 5) * 0.26,
    y: berth.point.y + 0.48 + Math.floor(place / 5) * 0.28,
  };
}
export function berthOccupant(world: World, berthId: string): Pod | undefined {
  return world.pods.find((p) => {
    if (!p.plan) return p.berthId === berthId;
    if (world.time < p.plan.departure) return p.plan.originBerthId === berthId;
    if (
      p.plan.pickupId === berthId &&
      world.time >= p.plan.pickupStart! &&
      world.time < p.plan.pickupEnd!
    )
      return true;
    return (
      p.plan.dropoffId === berthId &&
      world.time >= p.plan.dropoffStart! &&
      world.time < p.plan.dropoffEnd!
    );
  });
}
export function cityStats(world: World) {
  const podTrips = world.metrics.recentTrips.filter((t) => t.mode === "pod");
  return {
    population: world.residents.length,
    buildings: world.buildings.length,
    pods: world.pods.length,
    waiting: world.residents.filter((r) => r.status === "waiting").length,
    walking: world.residents.filter((r) => r.status === "walking").length,
    riding: world.residents.filter((r) =>
      ["boarding", "riding", "alighting"].includes(r.status),
    ).length,
    served: world.metrics.served,
    walked: world.metrics.walked,
    savedMinutes: Math.round(world.metrics.savedSeconds / 60),
    averageTrip: podTrips.length
      ? podTrips.reduce((sum, t) => sum + t.endedAt - t.startedAt, 0) /
        podTrips.length
      : 0,
    averageWait: podTrips.length
      ? podTrips.reduce((sum, t) => sum + t.waited, 0) / podTrips.length
      : 0,
    serviceShare:
      world.metrics.served + world.metrics.walked
        ? world.metrics.served / (world.metrics.served + world.metrics.walked)
        : 0,
  };
}
export function formatClock(seconds: number, minuteStep = 1): string {
  const step = Math.max(1, Math.floor(minuteStep));
  const minutes = Math.floor(seconds / (60 * step)) * step + 7 * 60;
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
export function formatDuration(
  seconds: number,
  language: Language = "zh",
): string {
  if (!Number.isFinite(seconds)) return "—";
  const value = Math.max(0, seconds);
  if (value < 60)
    return language === "zh"
      ? `${Math.ceil(value)} 秒`
      : `${Math.ceil(value)}s`;
  return language === "zh"
    ? `${(value / 60).toFixed(1)} 分钟`
    : `${(value / 60).toFixed(1)} min`;
}
