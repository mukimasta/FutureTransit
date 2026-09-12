import { describe, expect, it } from "vitest";
import { separateLabels } from "../src/rendering/labels";

describe("destination badge layout", () => {
  it("separates dense labels deterministically without mutating inputs", () => {
    const labels = Array.from({ length: 14 }, (_, id) => ({
      id: String(id),
      x: 20 + (id % 2),
      y: 30,
      width: 8,
      height: 2,
    }));
    const result = separateLabels(labels);
    expect(separateLabels(labels)).toEqual(result);
    expect(labels.every((label) => label.y === 30)).toBe(true);
    for (let i = 0; i < result.length; i++)
      for (let j = i + 1; j < result.length; j++) {
        expect(Math.abs(result[i].y - result[j].y)).toBeGreaterThanOrEqual(2.3);
      }
  });
  it("keeps already separated labels at their building anchors", () => {
    const labels = [
      { id: "a", x: 10, y: 10, width: 5, height: 2 },
      { id: "b", x: 20, y: 10, width: 5, height: 2 },
    ];
    expect(separateLabels(labels)).toEqual(labels);
  });
});
