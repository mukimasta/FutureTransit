import { describe, expect, it } from "vitest";
import { updateGrowth } from "../src/city";
import { applyCommand, createWorld } from "../src/simulation";
import {
  CITY_DAY_SECONDS,
  GOVERNMENT_GRANT_AMOUNT,
  GOVERNMENT_GRANTS,
  INITIAL_CASH,
} from "../src/economy/config";

describe("manual grants", () => {
  it("pays exactly three immediate fixed grants and then rejects further claims", () => {
    const world = createWorld();
    for (let index = 0; index < GOVERNMENT_GRANTS; index += 1) {
      expect(applyCommand(world, { type: "claim-grant" }).ok).toBe(true);
      expect(world.economy.grantsClaimed).toBe(index + 1);
    }
    expect(world.economy.cash).toBe(
      INITIAL_CASH + GOVERNMENT_GRANTS * GOVERNMENT_GRANT_AMOUNT,
    );
    expect(world.economy.subsidy).toBe(
      GOVERNMENT_GRANTS * GOVERNMENT_GRANT_AMOUNT,
    );
    expect(applyCommand(world, { type: "claim-grant" }).ok).toBe(false);
  });

  it("does not create a new grant from elapsed time or city growth", () => {
    const world = createWorld();
    world.time = world.growth.nextAt;
    updateGrowth(world);
    expect(world.economy.cash).toBe(INITIAL_CASH);
    expect(world.economy.grantsClaimed).toBe(0);

    world.time += CITY_DAY_SECONDS * 100;
    expect(applyCommand(world, { type: "claim-grant" }).ok).toBe(true);
    expect(world.economy.cash).toBe(INITIAL_CASH + GOVERNMENT_GRANT_AMOUNT);
  });

  it("starts directly in the version-2 economy; no legacy grant migration is required", () => {
    const world = createWorld();
    expect(world.version).toBe(2);
    expect(world.economy.model).toBe(2);
    expect(world.economy.pendingGrant).toBeUndefined();
    expect(world.economy.pendingGrowthGrant).toBeUndefined();
  });
});
