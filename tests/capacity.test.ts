import { describe, expect, it } from "vitest";
import { updateGrowth } from "../src/city";
import { findWalkPath } from "../src/network";
import { parseWorld, serializeWorld } from "../src/persistence";
import {
  applyCommand,
  createWorld,
  stepWorld,
  capacityValid,
} from "../src/simulation";
import { distance, pointKey } from "../src/shared/math";
import type { Point, World, Side } from "../src/shared/types";

function must(world: World, command: Parameters<typeof applyCommand>[1]) {
  const result = applyCommand(world, command);
  expect(result.ok, result.message).toBe(true);
}
function rush(parking: boolean, dual: boolean) {
  const w = createWorld(71);
  w.growth.enabled = false;
  must(w, {
    type: "add-berth",
    buildingId: "b-office",
    kind: "platform",
    side: "west",
  });
  must(w, {
    type: "build-track",
    points: [
      { x: 10, y: 16 },
      { x: 38, y: 16 },
      { x: 38, y: 10 },
    ],
  });
  if (parking)
    for (let i = 0; i < 3; i++)
      must(w, {
        type: "add-berth",
        buildingId: "b-office",
        kind: "parking",
        side: "west",
      });
  if (dual) must(w, { type: "upgrade-tracks", ids: w.tracks.map((t) => t.id) });
  for (const [i, r] of w.residents.entries()) {
    r.nextDeparture = i < 8 ? 0 : 50000;
    r.nextDestinationId = "b-office";
    r.purpose = "work";
    r.fareSensitivity = 0;
  }
  expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  w.paused = false;
  return w;
}
/** Connect real building-side berths using accepted construction commands. */
function connectBerth(w: World, access: Point) {
  const nodes = [
    ...new Map(
      w.tracks.flatMap((t) => [t.a, t.b]).map((p) => [pointKey(p), p]),
    ).values(),
  ];
  const nearest = nodes.sort(
    (a, b) => distance(a, access) - distance(b, access),
  )[0];
  if (!nearest || pointKey(nearest) === pointKey(access)) return;
  const shadow = {
    ...w,
    buildings: [
      ...w.buildings,
      ...w.berths.map((b) => ({
        id: `obstacle-${b.id}`,
        name: "obstacle",
        nameEn: "obstacle",
        kind: "home" as const,
        x: b.point.x,
        y: b.point.y,
        w: 1,
        h: 1,
        bornAt: 0,
      })),
    ],
  };
  const path = findWalkPath(shadow, access, nearest);
  expect(path).not.toBeNull();
  if (path && path.length > 1) must(w, { type: "build-track", points: path });
}
function matureConnectedWorld() {
  const w = createWorld(71);
  // Continuous growth no longer has a terminal wave. Keep this load fixture bounded.
  for (let wave = 0; wave < 4; wave++) {
    w.time = w.growth.nextAt;
    updateGrowth(w);
  }
  w.economy.cash = 100000; // Performance fixture only; budget is tested separately.
  for (const b of w.buildings)
    if (!w.berths.some((p) => p.buildingId === b.id && p.kind === "platform")) {
      for (const side of ["west", "east", "north", "south"] as Side[]) {
        if (
          applyCommand(w, {
            type: "add-berth",
            buildingId: b.id,
            kind: "platform",
            side,
          }).ok
        ) {
          connectBerth(w, w.berths.at(-1)!.access);
          break;
        }
      }
    }
  for (const b of w.buildings) {
    for (const side of ["west", "east", "north", "south"] as Side[]) {
      if (w.berths.filter((berth) => berth.kind === "parking").length >= 31)
        break;
      if (
        applyCommand(w, {
          type: "add-berth",
          buildingId: b.id,
          kind: "parking",
          side,
        }).ok
      )
        connectBerth(w, w.berths.at(-1)!.access);
    }
    if (w.berths.filter((berth) => berth.kind === "parking").length >= 31)
      break;
  }
  must(w, { type: "upgrade-tracks", ids: w.tracks.map((t) => t.id) });
  for (const berth of w.berths) {
    if (w.pods.length >= 30) break;
    applyCommand(w, { type: "buy-pod", berthId: berth.id });
  }
  expect(w.pods).toHaveLength(30);
  expect(capacityValid(w)).toBe(true);
  for (const [i, r] of w.residents.entries()) {
    r.nextDeparture = w.time + i * 8;
    r.nextDestinationId = r.workId;
    r.fareSensitivity = 0;
  }
  expect(() => parseWorld(serializeWorld(w))).not.toThrow();
  w.paused = false;
  return w;
}
describe("production-valid capacity acceptance", () => {
  it("compares eight identical departures with real parking and dual-track construction", () => {
    const base = rush(false, false),
      expanded = rush(true, true);
    stepWorld(base, 1800);
    stepWorld(expanded, 1800);
    expect(base.metrics.served).toBeGreaterThan(0);
    expect(expanded.metrics.served).toBeGreaterThan(base.metrics.served);
    expect(() => parseWorld(serializeWorld(expanded))).not.toThrow();
    console.log(
      JSON.stringify({
        name: "capacity-rush",
        base: base.metrics.served,
        expanded: expanded.metrics.served,
        baseWalk: base.metrics.walked,
        expandedWalk: expanded.metrics.walked,
      }),
    );
  });
  it("runs 30 connected Pods in a bounded grown city with actual services", () => {
    const w = matureConnectedWorld(),
      started = performance.now();
    const population = w.residents.length;
    w.growth.enabled = false;
    let maxActive = 0;
    for (let i = 0; i < 120; i++) {
      stepWorld(w, 30);
      maxActive = Math.max(
        maxActive,
        w.pods.filter((p) => p.plan?.residentId).length,
      );
      if (i % 20 === 0) {
        expect(() => parseWorld(serializeWorld(w))).not.toThrow();
        console.log(
          `connected stress: ${i * 30}s, ${w.metrics.served} delivered, ${Math.round(performance.now() - started)}ms CPU`,
        );
      }
    }
    expect(w.metrics.served).toBeGreaterThan(10);
    expect(maxActive).toBeGreaterThan(3);
    expect(w.residents).toHaveLength(population);
    expect(
      w.residents.every(
        (r) => (r.journey === null) === (r.atBuildingId !== null),
      ),
    ).toBe(true);
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
    console.log(
      JSON.stringify({
        name: "connected-max-load",
        cpuMs: Math.round(performance.now() - started),
        served: w.metrics.served,
        walked: w.metrics.walked,
        maxActive,
        tracks: w.tracks.length,
      }),
    );
  }, 60000);
});
