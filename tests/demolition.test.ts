import { describe, expect, it } from "vitest";
import { createWorld, applyCommand } from "../src/simulation";
import { serializeWorld, parseWorld } from "../src/persistence";

describe("atomic batch track demolition", () => {
  it("refunds a whole multi-lane selection once, including diagonal lengths", () => {
    const w = createWorld();
    const original = new Set(w.tracks.map((t) => t.id));
    const cash = w.economy.cash;
    expect(
      applyCommand(w, {
        type: "build-track",
        points: [
          { x: 2, y: 25 },
          { x: 6, y: 28 },
        ],
      }).ok,
    ).toBe(true);
    const ids = w.tracks.filter((t) => !original.has(t.id)).map((t) => t.id);
    expect(applyCommand(w, { type: "upgrade-tracks", ids, lanes: 3 }).ok).toBe(
      true,
    );
    expect(applyCommand(w, { type: "remove-tracks", ids }).ok).toBe(true);
    expect(w.economy.cash).toBeCloseTo(cash);
    expect(w.tracks).toHaveLength(original.size);
    expect(applyCommand(w, { type: "remove-tracks", ids }).ok).toBe(false);
    expect(w.economy.cash).toBeCloseTo(cash);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  });
  it("rejects duplicate/stale/capacity-breaking batches without partial effects", () => {
    const w = createWorld();
    const id = w.tracks[0].id;
    const before = serializeWorld(w);
    for (const ids of [[id, id], [id, "missing"], [id, w.tracks[1].id], []]) {
      expect(applyCommand(w, { type: "remove-tracks", ids }).ok).toBe(false);
      expect(serializeWorld(w)).toBe(before);
    }
  });
});
