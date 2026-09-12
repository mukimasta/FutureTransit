import { pointKey } from "../shared/math";
import type { Track, World } from "../shared/types";

function adjacency(world: World) {
  const nodes = new Map<string, Track[]>();
  for (const t of world.tracks)
    for (const p of [t.a, t.b]) {
      const key = pointKey(p),
        list = nodes.get(key) ?? [];
      list.push(t);
      nodes.set(key, list);
    }
  return nodes;
}

/** Select a corridor between junctions, including bends; loops terminate. */
export function corridorTracks(world: World, trackId: string): string[] {
  const first = world.tracks.find((t) => t.id === trackId);
  if (!first) return [];
  const nodes = adjacency(world),
    chosen = new Set([first.id]);
  const walk = (edge: Track, node: string) => {
    while (true) {
      if (world.berths.some((b) => pointKey(b.access) === node)) break;
      const touching = nodes.get(node) ?? [];
      if (touching.length !== 2) break;
      const next = touching.find((t) => t.id !== edge.id)!;
      if (chosen.has(next.id)) break;
      chosen.add(next.id);
      node = pointKey(next.a) === node ? pointKey(next.b) : pointKey(next.a);
      edge = next;
    }
  };
  walk(first, pointKey(first.a));
  walk(first, pointKey(first.b));
  return [...chosen];
}

/** Shift-select the shortest connected cell chain between two clicked tracks. */
export function trackRange(
  world: World,
  fromId: string,
  toId: string,
): string[] {
  if (
    !world.tracks.some((t) => t.id === fromId) ||
    !world.tracks.some((t) => t.id === toId)
  )
    return [];
  const nodes = adjacency(world),
    tracks = new Map(world.tracks.map((t) => [t.id, t]));
  const queue = [fromId],
    prior = new Map<string, string | null>([[fromId, null]]);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === toId) break;
    const track = tracks.get(id)!;
    for (const node of [pointKey(track.a), pointKey(track.b)])
      for (const next of nodes.get(node) ?? [])
        if (!prior.has(next.id)) {
          prior.set(next.id, id);
          queue.push(next.id);
        }
  }
  if (!prior.has(toId)) return [];
  const result: string[] = [];
  for (let id: string | null = toId; id !== null; id = prior.get(id) ?? null)
    result.push(id);
  return result.reverse();
}
