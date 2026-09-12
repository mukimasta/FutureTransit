import { describe, expect, it } from "vitest";
import { createWorld } from "../src/simulation";
import { residentFocusPoint } from "../src/rendering/focus";
import { residentPosition } from "../src/shared/selectors";

describe("persistent resident following", () => {
  it("keeps tracking through walking, entering a building and leaving again", () => {
    const w = createWorld();
    const r = w.residents[0];
    const office = w.buildings.find((b) => b.id === r.workId)!;
    r.status = "walking";
    r.atBuildingId = null;
    r.journey = {
      originId: r.homeId,
      destinationId: r.workId,
      startedAt: 0,
      walkBaseline: 10,
      purpose: "work",
      mode: "walk",
      stage: "direct",
      walk: {
        path: [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
        ],
        start: 0,
        end: 10,
      },
    };
    expect(residentFocusPoint(w, r, 5)).toEqual({ x: 15, y: 10 });
    r.status = "inside";
    r.atBuildingId = office.id;
    r.journey = null;
    expect(residentPosition(w, r)).toBeNull();
    expect(residentFocusPoint(w, r)).toEqual({
      x: office.x + (office.w - 1) / 2,
      y: office.y + (office.h - 1) / 2,
    });
    r.status = "walking";
    r.atBuildingId = null;
    r.journey = {
      originId: office.id,
      destinationId: r.homeId,
      startedAt: 20,
      walkBaseline: 10,
      purpose: "home",
      mode: "walk",
      stage: "direct",
      walk: {
        path: [
          { x: 20, y: 10 },
          { x: 10, y: 10 },
        ],
        start: 20,
        end: 30,
      },
    };
    expect(residentFocusPoint(w, r, 25)).toEqual({ x: 15, y: 10 });
  });
});
