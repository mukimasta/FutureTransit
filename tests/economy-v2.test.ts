import { describe, expect, it } from "vitest";
import {
  accruePodMovement,
  book,
  claimGrant,
  createEconomy,
  fareForDistance,
  repayLoan,
  takeLoan,
  updateEconomy,
} from "../src/economy";
import {
  CITY_DAY_SECONDS,
  DEFAULT_FARE_PER_KM,
  GOVERNMENT_GRANT_AMOUNT,
  LEDGER_LIMIT,
  LOAN_AMOUNT,
  LOAN_DAILY_RATE,
  LOAN_TERM_DAYS,
  POD_RUNNING_PER_KM,
} from "../src/economy/config";
import { applyCommand, createWorld } from "../src/simulation";
import type { ServicePlan } from "../src/shared/types";
import { CELL_METERS } from "../src/shared/constants";

function movementPlan(): ServicePlan {
  return {
    id: "test-plan",
    podId: "pod-1",
    residentId: "resident-1",
    originBerthId: "origin",
    finalBerthId: "final",
    requestedAt: 0,
    departure: 0,
    pickupStart: 10,
    pickupEnd: 10,
    dropoffStart: 30,
    dropoffEnd: 30,
    end: 40,
    segments: [
      {
        from: { x: 0, y: 0 },
        to: { x: 10, y: 0 },
        start: 0,
        end: 10,
        kind: "move",
        stage: "empty",
        resources: [],
      },
      {
        from: { x: 10, y: 0 },
        to: { x: 20, y: 0 },
        start: 10,
        end: 30,
        kind: "move",
        stage: "loaded",
        resources: [],
      },
      {
        from: { x: 20, y: 0 },
        to: { x: 20, y: 0 },
        start: 30,
        end: 40,
        kind: "node",
        stage: "loaded",
        resources: [],
      },
    ],
    reservations: [],
  };
}

describe("economy v2", () => {
  it("creates independent, fully initialized economy state", () => {
    const first = createEconomy();
    const second = createEconomy();
    first.cash = 0;
    expect(second.cash).toBeGreaterThan(0);
    expect(second.farePerKm).toBe(DEFAULT_FARE_PER_KM);
    expect(second.ledger).not.toBe(first.ledger);
    expect(second.totals).not.toBe(first.totals);
  });

  it("uses kilometre fares rounded to cents", () => {
    expect(fareForDistance(1.234, 18)).toBe(22.21);
    expect(fareForDistance(0, 18)).toBe(0);
  });

  it("bounds fare changes through the public command", () => {
    const world = createWorld();
    expect(applyCommand(world, { type: "set-fare", value: 35 }).ok).toBe(true);
    expect(world.economy.farePerKm).toBe(35);
    expect(applyCommand(world, { type: "set-fare", value: 61 }).ok).toBe(false);
    expect(world.economy.farePerKm).toBe(35);
  });

  it("offers exactly three fixed grants, with no later recurring growth", () => {
    const world = createWorld();
    expect([claimGrant(world), claimGrant(world), claimGrant(world)]).toEqual([
      GOVERNMENT_GRANT_AMOUNT,
      GOVERNMENT_GRANT_AMOUNT,
      GOVERNMENT_GRANT_AMOUNT,
    ]);
    expect(claimGrant(world)).toBe(0);
    world.time = CITY_DAY_SECONDS * 100;
    updateEconomy(world, CITY_DAY_SECONDS * 100);
    expect(claimGrant(world)).toBe(0);
    expect(world.economy.grantsClaimed).toBe(3);
  });

  it("accrues empty and loaded movement by actual overlapping distance, excluding waits", () => {
    const full = createWorld();
    const split = createWorld();
    const plan = movementPlan();
    accruePodMovement(full, plan, 0, 40);
    accruePodMovement(split, plan, 0, 11);
    accruePodMovement(split, plan, 11, 40);
    expect(full.economy.distanceKm).toEqual(split.economy.distanceKm);
    expect(full.economy.runningAccrued).toEqual(split.economy.runningAccrued);
    const legKm = (10 * CELL_METERS) / 1000;
    expect(full.economy.distanceKm).toEqual({ empty: legKm, loaded: legKm });
    expect(full.economy.runningAccrued).toEqual({
      empty: legKm * POD_RUNNING_PER_KM,
      loaded: legKm * POD_RUNNING_PER_KM,
    });
  });

  it("does not stack loans and does not create cash on repeated due ticks", () => {
    const world = createWorld();
    claimGrant(world);
    claimGrant(world);
    claimGrant(world);
    const before = world.economy.cash;
    expect(takeLoan(world)).toBe(true);
    expect(world.economy.cash).toBe(before + LOAN_AMOUNT);
    expect(takeLoan(world)).toBe(false);

    world.economy.cash = 0;
    world.time = CITY_DAY_SECONDS;
    updateEconomy(world, CITY_DAY_SECONDS);
    const afterDue = structuredClone(world.economy.loan);
    const cashAfterDue = world.economy.cash;
    updateEconomy(world, CITY_DAY_SECONDS);
    expect(world.economy.loan).toEqual(afterDue);
    expect(world.economy.cash).toBe(cashAfterDue);
  });

  it("allows a cash-backed full early repayment exactly once", () => {
    const world = createWorld();
    claimGrant(world);
    claimGrant(world);
    claimGrant(world);
    expect(takeLoan(world)).toBe(true);
    const remaining = world.economy.loan!.remaining;
    world.economy.cash = remaining;
    expect(repayLoan(world)).toBe(true);
    expect(world.economy.cash).toBe(0);
    expect(world.economy.loan).toBeNull();
    expect(repayLoan(world)).toBe(false);
  });

  it("repays five game instalments with the exact disclosed total interest", () => {
    const world = createWorld();
    world.tracks = [];
    world.berths = [];
    world.pods = [];
    for (let n = 0; n < 3; n++) claimGrant(world);
    expect(takeLoan(world)).toBe(true);
    const openingCash = world.economy.cash;
    for (let day = 1; day <= LOAN_TERM_DAYS; day++) {
      world.time = day * CITY_DAY_SECONDS;
      updateEconomy(world, CITY_DAY_SECONDS);
    }
    const interest = (LOAN_AMOUNT * LOAN_DAILY_RATE * (LOAN_TERM_DAYS + 1)) / 2;
    expect(interest).toBe(300);
    expect(world.economy.totals?.interest).toBe(interest);
    expect(world.economy.totals?.repayment).toBe(LOAN_AMOUNT);
    expect(world.economy.cash).toBe(openingCash - LOAN_AMOUNT - interest);
    expect(world.economy.loan).toBeNull();
  });

  it("keeps financing out of operating income and retains totals after ledger truncation", () => {
    const world = createWorld();
    for (let index = 0; index < LEDGER_LIMIT + 5; index += 1)
      book(world, "fare", 1);
    book(world, "loan", LOAN_AMOUNT);
    expect(world.economy.income).toBe(LEDGER_LIMIT + 5);
    expect(world.economy.totals?.fare).toBe(LEDGER_LIMIT + 5);
    expect(world.economy.ledger).toHaveLength(LEDGER_LIMIT);
    expect(world.economy.income).not.toBe(world.economy.totals?.loan);
  });
});
