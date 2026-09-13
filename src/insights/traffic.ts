import type { World } from "../shared/types";
import { edgeKey } from "../network";

export type TrafficRange = "recent" | "total";

export function forgetTrackTraffic(world: World, ids: Iterable<string>): void {
  const stats = world.metrics.trackTraffic;
  if (!stats) return;
  for (const id of ids) {
    delete stats.totals[id];
    for (const bucket of stats.buckets) delete bucket.counts[id];
  }
}

/** Actual completed traversals, not reservations. One-minute, 60-bucket window. */
export function recordTrackTraffic(world: World, from: number): void {
  const stats = (world.metrics.trackTraffic ??= {
    since: from,
    totals: {},
    buckets: [],
  });
  const minute = Math.floor(world.time / 60);
  const tracks = new Map(world.tracks.map((t) => [edgeKey(t.a, t.b), t.id]));
  stats.buckets = stats.buckets.filter((b) => b.minute > minute - 60);
  for (const pod of world.pods) {
    for (const segment of pod.plan?.segments ?? []) {
      if (
        segment.kind !== "move" ||
        segment.end <= from ||
        segment.end > world.time
      )
        continue;
      const id = tracks.get(edgeKey(segment.from, segment.to));
      if (!id) continue;
      stats.totals[id] = (stats.totals[id] ?? 0) + 1;
      const at = Math.floor(segment.end / 60);
      if (at <= minute - 60) continue;
      let bucket = stats.buckets.find((b) => b.minute === at);
      if (!bucket) {
        bucket = { minute: at, counts: {} };
        stats.buckets.push(bucket);
      }
      bucket.counts[id] = (bucket.counts[id] ?? 0) + 1;
    }
  }
}

export function trackTraffic(
  world: World,
  range: TrafficRange,
): Record<string, number> {
  const stats = world.metrics.trackTraffic;
  if (!stats) return {};
  if (range === "total") return stats.totals;
  const counts: Record<string, number> = {};
  const minute = Math.floor(world.time / 60);
  for (const bucket of stats.buckets) {
    if (bucket.minute <= minute - 60 || bucket.minute > minute) continue;
    for (const [id, count] of Object.entries(bucket.counts))
      counts[id] = (counts[id] ?? 0) + count;
  }
  return counts;
}

export function trafficColor(count: number, max: number): string {
  if (!count || !max) return "#c4c7c4";
  const ratio = count / max;
  if (ratio <= 0.25) return "#5aaba3";
  if (ratio <= 0.5) return "#bac05c";
  if (ratio <= 0.75) return "#e7a04b";
  return "#cd594b";
}
