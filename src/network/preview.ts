import { samePoint } from "../shared/math";
import type { Point } from "../shared/types";

/** The cursor is a candidate only; it must never mutate the committed draft. */
export function previewPoints(
  draft: readonly Point[],
  cursor: Point | null,
): Point[] {
  if (!draft.length || !cursor || samePoint(draft[draft.length - 1], cursor))
    return [...draft];
  return [...draft, cursor];
}
