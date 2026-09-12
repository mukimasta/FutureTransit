import { describe, expect, it } from "vitest";
import { applyCommand, createWorld, stepWorld } from "../src/simulation";
import {
  parkingGroups,
  parkingShortage,
  reachableIdlePods,
} from "../src/simulation/fleet";
import { parseWorld, serializeWorld } from "../src/persistence";
import { commitPlan, planService } from "../src/scheduler";

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
    expect(serializeWorld(w)).toBe(before);
    expect(applyCommand(w, { type: "buy-pod", berthId: empty.id }).ok).toBe(
      true,
    );
    expect(w.pods).toHaveLength(5);
    expect(parkingShortage(w)).toBe(0);
    const full = serializeWorld(w);
    expect(applyCommand(w, { type: "buy-pod", berthId: empty.id }).ok).toBe(
      false,
    );
    expect(serializeWorld(w)).toBe(full);
    expect(parkingGroups(w).find((g) => g.podIds.length)?.parking).toBe(5);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  });
  it("can serve a passenger with every parking occupied, reserving the Pod's own vacated slot", () => {
    const w = createWorld();
    const empty = w.berths.find(
      (b) => b.kind === "parking" && !w.pods.some((p) => p.berthId === b.id),
    )!;
    expect(applyCommand(w, { type: "buy-pod", berthId: empty.id }).ok).toBe(
      true,
    );
    expect(
      applyCommand(w, {
        type: "add-berth",
        buildingId: "b-office",
        kind: "platform",
        side: "west",
      }).ok,
    ).toBe(true);
    const pickup = w.berths.find(
      (b) => b.kind === "platform" && b.buildingId === "b-home",
    )!;
    const dropoff = w.berths.find(
      (b) => b.kind === "platform" && b.buildingId === "b-office",
    )!;
    expect(
      applyCommand(w, {
        type: "build-track",
        points: [
          { x: 10, y: 16 },
          { x: dropoff.access.x, y: 16 },
          dropoff.access,
        ],
      }).ok,
    ).toBe(true);
    expect(w.berths.filter((b) => b.kind === "parking")).toHaveLength(
      w.pods.length,
    );
    const rider = w.residents[0];
    for (const resident of w.residents) resident.nextDeparture = 100000;
    const pod = w.pods[0];
    const originalSlot = pod.berthId;
    const planned = planService(w, pod, rider, pickup, dropoff);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.finalBerthId).toBe(originalSlot);
    rider.status = "waiting";
    rider.atBuildingId = null;
    rider.journey = {
      originId: "b-home",
      destinationId: "b-office",
      startedAt: w.time,
      walkBaseline: 1000,
      purpose: "work",
      mode: "pod",
      stage: "queue",
      pickupId: pickup.id,
      dropoffId: dropoff.id,
      podId: pod.id,
      farePerKm: 18,
    };
    commitPlan(w, planned.plan);
    w.paused = false;
    w.growth.enabled = false;
    const until = Math.ceil(planned.plan.end) + 1;
    while (w.time < until) {
      stepWorld(w, 1);
      const terminals = w.pods.map((p) => p.plan?.finalBerthId ?? p.berthId);
      expect(new Set(terminals).size).toBe(w.pods.length);
      const owners = new Map<string, string>();
      for (const reservation of w.reservations.filter(
        (r) => r.start <= w.time && r.end > w.time,
      )) {
        const owner = owners.get(reservation.resource);
        expect(!owner || owner === reservation.ownerId).toBe(true);
        owners.set(reservation.resource, reservation.ownerId);
      }
    }
    expect(rider.atBuildingId).toBe("b-office");
    expect(w.metrics.served).toBe(1);
    expect(pod.berthId).toBe(originalSlot);
    expect(pod.plan).toBeNull();
    expect(parkingShortage(w)).toBe(0);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  });
  it("still detects a genuine parking shortage without manufacturing a spare requirement", () => {
    const w = createWorld();
    const empty = w.berths.find(
      (b) => b.kind === "parking" && !w.pods.some((p) => p.berthId === b.id),
    )!;
    expect(applyCommand(w, { type: "buy-pod", berthId: empty.id }).ok).toBe(
      true,
    );
    w.pods.push({
      id: "extra-pod",
      berthId: w.berths.find((b) => b.kind === "platform")!.id,
      parkedSince: 0,
      plan: null,
      trips: 0,
      paid: 0,
    });
    expect(parkingShortage(w)).toBe(1);
    expect(w.pods).toHaveLength(6);
    expect(parkingGroups(w).find((g) => g.podIds.length)?.parking).toBe(5);
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
