import type { Point, World } from "./types";
export const pointKey = (p: Point) => `${p.x},${p.y}`;
export const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
export const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);
export function random(world: Pick<World, "rng">): number {
  let x = world.rng | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  world.rng = x >>> 0;
  return world.rng / 4294967296;
}
export const id = (world: World, prefix: string) =>
  `${prefix}${world.nextId++}`;
export function pathLength(path: Point[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1)
    total += Math.hypot(
      path[index].x - path[index - 1].x,
      path[index].y - path[index - 1].y,
    );
  return total;
}
export function alongPath(path: Point[], fraction: number): Point {
  if (!path.length) return { x: 0, y: 0 };
  let target = pathTotalLength(path) * Math.max(0, Math.min(1, fraction));
  for (let i = 1; i < path.length; i++) {
    const d = distance(path[i - 1], path[i]);
    if (target <= d) {
      const t = d ? target / d : 0;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
      };
    }
    target -= d;
  }
  return path[path.length - 1];
}

/**
 * Cached total length of a stable path array. Animation resamples the same
 * walk paths every frame, so their length is measured once per array.
 */
const pathTotals = new WeakMap<Point[], number>();
export function pathTotalLength(path: Point[]): number {
  const cached = pathTotals.get(path);
  if (cached !== undefined) return cached;
  const total = pathLength(path);
  pathTotals.set(path, total);
  return total;
}
