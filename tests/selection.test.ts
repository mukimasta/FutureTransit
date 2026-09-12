import { describe, it, expect } from "vitest";
import { createWorld } from "../src/simulation";
import { corridorTracks, trackRange } from "../src/network/selection";
import type { Track } from "../src/shared/types";
const t = (
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Track => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, paid: 0 });
describe("whole corridor and range selection", () => {
  it("crosses bends but stops at a junction", () => {
    const w = createWorld();
    w.berths = [];
    w.tracks = [
      t("a", 0, 0, 1, 0),
      t("b", 1, 0, 1, 1),
      t("c", 1, 1, 2, 1),
      t("d", 1, 1, 1, 2),
    ];
    expect(corridorTracks(w, "a").sort()).toEqual(["a", "b"]);
    expect(trackRange(w, "a", "d")).toEqual(["a", "b", "d"]);
  });
  it("handles closed loops and disconnected Shift ranges", () => {
    const w = createWorld();
    w.berths = [];
    w.tracks = [
      t("a", 0, 0, 1, 0),
      t("b", 1, 0, 1, 1),
      t("c", 1, 1, 0, 1),
      t("d", 0, 1, 0, 0),
      t("e", 9, 9, 10, 9),
    ];
    expect(corridorTracks(w, "a")).toHaveLength(4);
    expect(trackRange(w, "a", "e")).toEqual([]);
  });
});
