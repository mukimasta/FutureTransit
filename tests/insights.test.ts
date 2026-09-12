import { describe, expect, it } from "vitest";
import { buildingFlow } from "../src/insights";
import { createWorld } from "../src/simulation";

describe("building destinations", () => {
  it("shows every resident workplace even before anybody travels", () => {
    const w = createWorld(),
      flow = buildingFlow(w, "b-home", "work");
    expect(flow.total).toBe(24);
    expect(flow.rows[0].destinationId).toBe("b-office");
    expect(flow.rows[0].residentIds).toHaveLength(24);
  });
  it("distinguishes intended departures from actual walking and Pod demand", () => {
    const w = createWorld();
    const a = w.residents[0],
      b = w.residents[1];
    for (const [r, mode] of [
      [a, "walk"],
      [b, "pod"],
    ] as const) {
      r.atBuildingId = null;
      r.status = "walking";
      r.journey = {
        originId: "b-home",
        destinationId: "b-office",
        mode,
        stage: mode === "walk" ? "direct" : "access",
        purpose: "work",
        startedAt: 0,
        walkBaseline: 600,
      };
    }
    const flow = buildingFlow(w, "b-home", "demand");
    expect(flow.total).toBe(24);
    expect(flow.rows.reduce((n, r) => n + r.planned, 0)).toBe(22);
    expect(flow.rows[0].walk).toBe(1);
    expect(flow.rows[0].pod).toBe(1);
  });
  it("counts completed trips, respects origin/time window, and never fabricates mode", () => {
    const w = createWorld();
    w.time = 4000;
    const trip = {
      residentId: w.residents[0].id,
      originId: "b-home",
      destinationId: "b-office",
      startedAt: 3000,
      endedAt: 3100,
      walkBaseline: 500,
      waited: 0,
      mode: "pod" as const,
    };
    w.metrics.recentTrips = [
      trip,
      { ...trip, mode: "walk" },
      { ...trip, endedAt: 1000, startedAt: 900 },
      { ...trip, originId: "b-shop" },
    ];
    const flow = buildingFlow(w, "b-home", "history");
    expect(flow.total).toBe(2);
    expect(flow.rows[0].pod).toBe(1);
    expect(flow.rows[0].walk).toBe(1);
    expect(flow.rows[0].residentIds).toHaveLength(1);
  });
});
