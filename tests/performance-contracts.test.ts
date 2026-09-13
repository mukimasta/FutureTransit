import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createWorld,
  processPending,
  stepWorld,
  stepWorldAsync,
} from "../src/simulation";
import { WorldDeltaWriter, applyWorldDelta } from "../src/shared/world-delta";
import { RetryQueue } from "../src/simulation/retry";
import { edgeKey } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";

describe("lossless worker deltas", () => {
  it("reconstructs simulation, edits and saves exactly without retransmitting static plans", () => {
    const world = createWorld();
    const writer = new WorldDeltaWriter();
    writer.capture(world);
    let view = structuredClone(world);
    const oldTracks = view.tracks;
    world.paused = false;
    for (let tick = 0; tick < 120; tick++) {
      stepWorld(world, 1);
      const delta = structuredClone(writer.capture(world));
      view = applyWorldDelta(view, delta);
      expect(view).toEqual(world);
    }
    expect(view.tracks).toBe(oldTracks);
    expect(() => parseWorld(serializeWorld(view))).not.toThrow();
    applyCommand(world, { type: "speed", value: 4 });
    applyCommand(world, {
      type: "build-track",
      points: [
        { x: 2, y: 28 },
        { x: 5, y: 28 },
      ],
    });
    view = applyWorldDelta(view, structuredClone(writer.capture(world)));
    expect(view).toEqual(world);
    const quiet = writer.capture(world);
    expect(quiet.pods).toBeUndefined();
    expect(quiet.reservations).toBeUndefined();
    expect(quiet.entities).toEqual({});
  });
  it("handles reservation insertion, removal and reordering losslessly", () => {
    const w = createWorld(),
      writer = new WorldDeltaWriter();
    writer.capture(w);
    let view = structuredClone(w);
    const a = { resource: "test-a", ownerId: "p", start: 1, end: 2 };
    const b = { resource: "test-b", ownerId: "p", start: 2, end: 3 };
    for (const reservations of [[a, b], [b, a], [b], []]) {
      w.reservations = reservations;
      view = applyWorldDelta(view, structuredClone(writer.capture(w)));
      expect(view).toEqual(w);
    }
    writer.reset();
    expect(writer.capture(createWorld(11)).sequence).toBe(1);
  });
});

describe("demand retry events", () => {
  it("cooperative and synchronous stepping produce the same city", async () => {
    const a = createWorld(23),
      b = structuredClone(a);
    a.paused = b.paused = false;
    stepWorld(a, 180);
    await stepWorldAsync(b, 180, async () => {});
    expect(b).toEqual(a);
  });
  it("sleeps a jammed request on the clock, a Pod-less one on the fleet, and both on topology", () => {
    const w = createWorld(),
      queue = new RetryQueue();
    queue.refresh(w);
    queue.failed("ride", w.time, "track-busy");
    w.time += 19;
    queue.refresh(w);
    expect(queue.ready("ride", w.time)).toBe(false);
    // A Pod parking elsewhere leaves a busy corridor exactly as it was.
    w.pods[0].berthId = "changed";
    queue.refresh(w);
    expect(queue.ready("ride", w.time)).toBe(false);
    // The spread puts every request back within 40 city seconds regardless.
    w.time += 21;
    queue.refresh(w);
    expect(queue.ready("ride", w.time)).toBe(true);
    // Waiting on a Pod is waiting on the fleet, and wakes with it.
    queue.failed("ride", w.time, "no-pod");
    w.pods[0].berthId = "changed again";
    queue.refresh(w);
    expect(queue.ready("ride", w.time)).toBe(true);
    queue.failed("ride", w.time, "track-busy");
    w.networkVersion++;
    queue.refresh(w);
    expect(queue.ready("ride", w.time)).toBe(true);
  });
});

describe("pending parking evacuation", () => {
  it("lets the occupant leave a pending origin before demolishing it", () => {
    const w = createWorld();
    w.paused = false;
    w.growth.enabled = false;
    w.residents.forEach((r) => {
      r.nextDeparture = 1e9;
    });
    w.berths = [
      {
        id: "origin",
        kind: "parking",
        point: { x: 2, y: 27 },
        access: { x: 2, y: 28 },
        side: "south",
        paid: 0,
      },
      {
        id: "target",
        kind: "parking",
        point: { x: 8, y: 27 },
        access: { x: 8, y: 28 },
        side: "south",
        paid: 0,
      },
    ];
    w.tracks = Array.from({ length: 6 }, (_, i) => {
      const a = { x: 2 + i, y: 28 },
        b = { x: 3 + i, y: 28 };
      return { id: edgeKey(a, b), a, b, paid: 0 };
    });
    w.pods = [{ ...w.pods[0], berthId: "origin", plan: null }];
    w.reservations = [];
    w.networkVersion++;
    w.pendingEdits = [{ type: "remove-berth", id: "origin" }];
    processPending(w);
    expect(w.pods[0].plan?.finalBerthId).toBe("target");
    expect(w.berths.some((b) => b.id === "origin")).toBe(true);
    stepWorld(w, 60);
    expect(w.pods[0].berthId).toBe("target");
    expect(w.berths.some((b) => b.id === "origin")).toBe(false);
    expect(w.pendingEdits).toEqual([]);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  });
});
