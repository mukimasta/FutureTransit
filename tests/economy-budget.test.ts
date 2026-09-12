import { describe, expect, it } from "vitest";
import { applyCommand, createWorld } from "../src/simulation";
import { updateGrowth } from "../src/city";
import {
  FARE,
  GRANT_AMOUNT,
  GRANT_INTERVAL,
  GROWTH_GRANT,
  PARKING_COST,
  PLATFORM_COST,
  POD_COST,
  TRACK_COST,
  TIME_SCALE,
} from "../src/shared/constants";

describe("construction budget envelope", () => {
  it("funds a 20-Pod modest network in thirty minutes without requiring fare grinding", () => {
    // Active spending and manual claims keep the recurring grants available.
    // This is an itemized design budget, not an optimal routing/throughput claim.
    const funds =
      createWorld().economy.cash +
      Math.floor((30 * 60 * TIME_SCALE) / GRANT_INTERVAL) * GRANT_AMOUNT +
      4 * GROWTH_GRANT;
    const twenty =
      (20 - 4) * POD_COST +
      13 * PLATFORM_COST +
      16 * PARKING_COST +
      180 * TRACK_COST;
    const twentyFour =
      (24 - 4) * POD_COST +
      13 * PLATFORM_COST +
      20 * PARKING_COST +
      180 * TRACK_COST;
    expect(funds).toBeGreaterThanOrEqual(twenty);
    expect(funds + 80 * FARE * 0.8).toBeGreaterThanOrEqual(twentyFour);
    expect(funds).toBeLessThan(
      400 * TRACK_COST + 26 * POD_COST + 13 * PLATFORM_COST,
    );
  });
  it("makes the connection grant available on arrival and pays only on claim", () => {
    const w = createWorld(71),
      before = w.economy.cash;
    w.time = w.growth.nextAt;
    updateGrowth(w);
    expect(w.economy.cash).toBe(before);
    expect(w.economy.pendingGrowthGrant).toBe(GROWTH_GRANT);
    updateGrowth(w);
    expect(w.economy.pendingGrowthGrant).toBe(GROWTH_GRANT);
    expect(applyCommand(w, { type: "claim-grant" }).ok).toBe(true);
    expect(w.economy.cash).toBe(before + GROWTH_GRANT);
  });
});
