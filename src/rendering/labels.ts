export interface MapLabel {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep neighboring destination badges separate without moving their anchors. */
export function separateLabels<T extends MapLabel>(labels: readonly T[]): T[] {
  const placed: T[] = [];
  for (const label of labels) {
    const next = { ...label };
    for (let attempt = 0; attempt < labels.length; attempt++) {
      const overlaps = placed.filter(
        (other) =>
          Math.abs(next.x - other.x) < (next.width + other.width) / 2 + 0.3 &&
          Math.abs(next.y - other.y) < (next.height + other.height) / 2 + 0.3,
      );
      if (!overlaps.length) break;
      next.y = Math.min(
        ...overlaps.map(
          (other) => other.y - (next.height + other.height) / 2 - 0.35,
        ),
      );
    }
    placed.push(next);
  }
  return placed;
}
