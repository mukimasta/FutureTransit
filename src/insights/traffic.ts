import type { Track, World } from "../shared/types";
import { edgeKey } from "../network";

/**
 * Traffic is recorded once per simulated second, so the edge lookup is kept
 * until the network itself changes rather than rebuilt from the track list
 * every time.
 */
const trackIndexes = new WeakMap<
  World,
  { tracks: Track[]; byEdge: Map<string, string> }
>();

function trackIdsByEdge(world: World): Map<string, string> {
  const cached = trackIndexes.get(world);
  if (cached && cached.tracks === world.tracks) return cached.byEdge;
  const byEdge = new Map(world.tracks.map((t) => [edgeKey(t.a, t.b), t.id]));
  trackIndexes.set(world, { tracks: world.tracks, byEdge });
  return byEdge;
}

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
  const tracks = trackIdsByEdge(world);
  const retained = stats.buckets.filter((b) => b.minute > minute - 60);
  if (retained.length !== stats.buckets.length) stats.buckets = retained;
  // A Pod's plan is a sorted timeline, so the traversals that ended in this
  // second sit in one run: the scan can stop at the first segment beyond it.
  for (const pod of world.pods) {
    const segments = pod.plan?.segments;
    if (!segments) continue;
    for (const segment of segments) {
      if (segment.end <= from) continue;
      if (segment.end > world.time) break;
      if (segment.kind !== "move") continue;
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
