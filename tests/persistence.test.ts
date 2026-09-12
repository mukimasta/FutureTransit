import { describe, expect, it } from "vitest";
import { parseWorld, serializeWorld } from "../src/persistence";
import { applyCommand, createWorld, stepWorld } from "../src/simulation";

function runningWorld() {
  const w = createWorld();
  applyCommand(w, {
    type: "add-berth",
    buildingId: "b-office",
    kind: "platform",
    side: "west",
  });
  const p = w.berths.find((b) => b.buildingId === "b-office")!;
  applyCommand(w, {
    type: "build-track",
    points: [{ x: 10, y: 16 }, { x: p.access.x, y: 16 }, p.access],
  });
  w.paused = false;
  return w;
}
describe("save and recovery", () => {
  it("round-trips a new city without regenerating residents", () => {
    const w = createWorld();
    expect(parseWorld(serializeWorld(w))).toEqual(w);
  });
  it("restores in-transit identities and reservations, paused, then continues the same future", () => {
    const w = runningWorld();
    stepWorld(w, 100);
    expect(w.pods.some((p) => p.plan)).toBe(true);
    const restored = parseWorld(serializeWorld(w));
    expect(restored.paused).toBe(true);
    restored.paused = false;
    stepWorld(w, 500);
    stepWorld(restored, 500);
    expect(restored).toEqual(w);
  });
  it("rejects unsupported versions, duplicated identities, and missing reservations", () => {
    expect(() => parseWorld('{"version":0}')).toThrow();
    const w = createWorld();
    w.residents.push({ ...w.residents[0] });
    expect(() => parseWorld(serializeWorld(w))).toThrow();
    const active = runningWorld();
    stepWorld(active, 100);
    active.reservations = [];
    expect(() => parseWorld(serializeWorld(active))).toThrow();
  });
});
