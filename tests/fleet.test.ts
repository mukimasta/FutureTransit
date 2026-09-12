import { describe, expect, it } from "vitest";
import { applyCommand, createWorld, stepWorld } from "../src/simulation";
import {
  parkingGroups,
  parkingShortage,
  reachableIdlePods,
} from "../src/simulation/fleet";
import { parseWorld, serializeWorld } from "../src/persistence";

describe("dedicated fleet parking", () => {
  it("does not count passenger platforms as parking or spend money on rejected purchases", () => {
    const w = createWorld();
    const platform = w.berths.find((b) => b.kind === "platform")!;
    const empty = w.berths.find(
      (b) => b.kind === "parking" && !w.pods.some((p) => p.berthId === b.id),
    )!;
    const before = serializeWorld(w);
    expect(applyCommand(w, { type: "buy-pod", berthId: platform.id }).ok).toBe(
      false,
    );
    expect(applyCommand(w, { type: "buy-pod", berthId: empty.id }).ok).toBe(
      false,
    );
    expect(serializeWorld(w)).toBe(before);
    expect(
      applyCommand(w, {
        type: "add-berth",
        buildingId: "b-home",
        kind: "parking",
        side: "east",
      }).ok,
    ).toBe(true);
    const parking = w.berths.at(-1)!;
    expect(
      applyCommand(w, {
        type: "build-track",
        points: [
          { x: 15, y: 16 },
          { x: parking.access.x, y: 16 },
          parking.access,
        ],
      }).ok,
    ).toBe(true);
    expect(applyCommand(w, { type: "buy-pod", berthId: parking.id }).ok).toBe(
      true,
    );
    expect(w.pods).toHaveLength(5);
    expect(parkingShortage(w)).toBe(0);
    expect(parkingGroups(w).find((g) => g.podIds.length)?.parking).toBe(6);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  });
  it("evacuates old idle platform Pods physically without deleting them", () => {
    const w = createWorld();
    for (const r of w.residents) r.nextDeparture = 10000;
    const pod = w.pods[0];
    pod.berthId = w.berths.find((b) => b.kind === "platform")!.id;
    const beforeIds = w.pods.map((p) => p.id);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
    w.paused = false;
    w.growth.enabled = false;
    stepWorld(w, 6);
    expect(pod.plan).not.toBeNull();
    expect(w.berths.find((b) => b.id === pod.plan?.finalBerthId)?.kind).toBe(
      "parking",
    );
    stepWorld(w, 120);
    expect(w.pods.map((p) => p.id)).toEqual(beforeIds);
    expect(w.berths.find((b) => b.id === pod.berthId)?.kind).toBe("parking");
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  });
  it("preserves legacy parking shortages on load", () => {
    const w = createWorld();
    w.berths.find((b) => b.id === w.pods[0].berthId)!.kind = "platform";
    expect(parkingShortage(w)).toBe(1);
    expect(parseWorld(serializeWorld(w)).pods).toHaveLength(4);
  });
  it("finds a seventh reachable Pod behind six nearby disconnected vehicles", () => {
    const w = createWorld();
    w.buildings = [];
    w.tracks = [];
    w.berths = [];
    w.pods = [];
    const pickup = {
      id: "pickup",
      buildingId: "unit",
      kind: "platform" as const,
      side: "west" as const,
      point: { x: 10, y: 10 },
      access: { x: 11, y: 10 },
      paid: 0,
    };
    w.berths.push(pickup);
    for (let i = 0; i < 7; i++) {
      const point = i === 6 ? { x: 20, y: 10 } : { x: 10 + i, y: 8 };
      const berth = {
        id: `p${i}`,
        buildingId: "unit",
        kind: "parking" as const,
        side: "west" as const,
        point,
        access: { x: point.x + 1, y: point.y },
        paid: 0,
      };
      w.berths.push(berth);
      w.pods.push({
        id: `pod${i}`,
        berthId: berth.id,
        parkedSince: 0,
        plan: null,
        trips: 0,
        paid: 0,
      });
    }
    for (let x = 11; x < 20; x++)
      w.tracks.push({
        id: `edge${x}`,
        a: { x, y: 10 },
        b: { x: x + 1, y: 10 },
        paid: 0,
      });
    w.networkVersion++;
    expect(reachableIdlePods(w, pickup).map((p) => p.id)).toEqual(["pod6"]);
  });
});
