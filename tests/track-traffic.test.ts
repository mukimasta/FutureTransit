import { describe, expect, it } from "vitest";
import { createWorld } from "../src/simulation";
import {
  forgetTrackTraffic,
  recordTrackTraffic,
  trackTraffic,
  trafficColor,
} from "../src/insights/traffic";
import { parseWorld, serializeWorld } from "../src/persistence";

function fixture() {
  const world = createWorld();
  const track = {
    id: "traffic-test",
    a: { x: 2, y: 28 },
    b: { x: 3, y: 28 },
    paid: 0,
  };
  world.tracks = [track];
  world.pods = [
    {
      id: "test-pod",
      berthId: null,
      paid: 0,
      trips: 0,
      parkedSince: 0,
      plan: {
        id: "test-plan",
        podId: "test-pod",
        residentId: null,
        originBerthId: "origin",
        finalBerthId: "destination",
        requestedAt: 0,
        departure: 0,
        end: 11,
        reservations: [],
        segments: [
          {
            kind: "move",
            from: track.a,
            to: track.b,
            start: 0,
            end: 5,
            stage: "empty",
            resources: [],
          },
          {
            kind: "node",
            from: track.b,
            to: track.b,
            start: 5,
            end: 6,
            stage: "empty",
            resources: [],
          },
          {
            kind: "move",
            from: track.b,
            to: track.a,
            start: 6,
            end: 11,
            stage: "loaded",
            resources: [],
          },
        ],
      },
    },
  ];
  return world;
}

describe("track traffic", () => {
  it("counts completed passages in both directions, not future reservations or node dwell", () => {
    const w = fixture();
    w.time = 4;
    recordTrackTraffic(w, 0);
    expect(trackTraffic(w, "total")).toEqual({});
    w.time = 5;
    recordTrackTraffic(w, 4);
    expect(trackTraffic(w, "total")["traffic-test"]).toBe(1);
    w.time = 6;
    recordTrackTraffic(w, 5);
    expect(trackTraffic(w, "total")["traffic-test"]).toBe(1);
    w.time = 11;
    recordTrackTraffic(w, 6);
    expect(trackTraffic(w, "total")["traffic-test"]).toBe(2);
  });

  it("expires recent buckets but keeps cumulative counts", () => {
    const w = fixture();
    w.time = 11;
    recordTrackTraffic(w, 0);
    w.time = 3599;
    recordTrackTraffic(w, 11);
    expect(trackTraffic(w, "recent")["traffic-test"]).toBe(2);
    w.time = 3600;
    recordTrackTraffic(w, 3599);
    expect(trackTraffic(w, "recent")).toEqual({});
    expect(trackTraffic(w, "total")["traffic-test"]).toBe(2);
    expect(w.metrics.trackTraffic!.buckets).toHaveLength(0);
  });

  it("retains widening history and forgets demolished sections", () => {
    const w = fixture();
    w.time = 11;
    recordTrackTraffic(w, 0);
    w.tracks[0].lanes = 3;
    expect(trackTraffic(w, "total")["traffic-test"]).toBe(2);
    forgetTrackTraffic(w, ["traffic-test"]);
    expect(trackTraffic(w, "total")).toEqual({});
    expect(trackTraffic(w, "recent")).toEqual({});
  });

  it("round-trips traffic and migrates legacy saves from current city time", () => {
    const w = createWorld();
    const id = w.tracks[0].id;
    w.metrics.trackTraffic = {
      since: 0,
      totals: { [id]: 3 },
      buckets: [{ minute: 0, counts: { [id]: 2 } }],
    };
    expect(parseWorld(serializeWorld(w)).metrics.trackTraffic).toEqual(
      w.metrics.trackTraffic,
    );
    delete w.metrics.trackTraffic;
    const loaded = parseWorld(serializeWorld(w));
    expect(loaded.metrics.trackTraffic).toEqual({
      since: w.time,
      totals: {},
      buckets: [],
    });
  });

  it("rejects inconsistent stored traffic", () => {
    const w = createWorld();
    const id = w.tracks[0].id;
    w.metrics.trackTraffic = {
      since: 0,
      totals: { [id]: 1 },
      buckets: [{ minute: 0, counts: { [id]: 2 } }],
    };
    expect(() => parseWorld(serializeWorld(w))).toThrow(/traffic total/);
  });

  it("uses gray for zero and the highest heat for the current maximum", () => {
    expect(trafficColor(0, 0)).toBe("#c4c7c4");
    expect(trafficColor(10, 10)).toBe("#cd594b");
  });
});
