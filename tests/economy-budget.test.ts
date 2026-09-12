import { describe, expect, it } from "vitest";
import { applyCommand, createWorld } from "../src/simulation";
import { updateGrowth } from "../src/city";
import {
  GOVERNMENT_GRANT_AMOUNT,
  GOVERNMENT_GRANTS,
  INITIAL_CASH,
} from "../src/economy/config";

describe("construction budget envelope", () => {
  it("has a finite bootstrap envelope rather than recurring construction grants", () => {
    const world = createWorld();
    const bootstrap =
      INITIAL_CASH + GOVERNMENT_GRANTS * GOVERNMENT_GRANT_AMOUNT;
    for (let index = 0; index < GOVERNMENT_GRANTS; index += 1)
      expect(applyCommand(world, { type: "claim-grant" }).ok).toBe(true);
    expect(world.economy.cash).toBe(bootstrap);
    expect(applyCommand(world, { type: "claim-grant" }).ok).toBe(false);
  });
  it("does not turn a city expansion into a cash grant", () => {
    const world = createWorld(71);
    const before = world.economy.cash;
    world.time = world.growth.nextAt;
    updateGrowth(world);
    expect(world.economy.cash).toBe(before);
    expect(world.economy.subsidy).toBe(0);
  });
});
