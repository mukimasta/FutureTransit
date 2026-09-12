import { CELL_METERS } from "../shared/constants";
import { distance } from "../shared/math";
import type {
  Economy,
  LedgerCategory,
  ServicePlan,
  UpkeepCategory,
  World,
} from "../shared/types";
import {
  CITY_DAY_SECONDS,
  DEFAULT_FARE_PER_KM,
  GOVERNMENT_GRANT_AMOUNT,
  GOVERNMENT_GRANTS,
  INITIAL_CASH,
  LEDGER_LIMIT,
  LOAN_AMOUNT,
  LOAN_DAILY_RATE,
  LOAN_TERM_DAYS,
  PARKING_UPKEEP_PER_DAY,
  PLATFORM_UPKEEP_PER_DAY,
  POD_RUNNING_PER_KM,
  POD_UPKEEP_PER_DAY,
  TRACK_UPKEEP_PER_LANE_KM_DAY,
} from "./config";

export const money = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export const fareRate = (world: World) =>
  world.economy.farePerKm ?? DEFAULT_FARE_PER_KM;
export const fareForDistance = (km: number, rate: number) =>
  Number.isFinite(km) && Number.isFinite(rate)
    ? money(Math.max(0, km) * Math.max(0, rate))
    : 0;

export function createEconomy(time = 0): Economy {
  return {
    model: 2,
    cash: INITIAL_CASH,
    income: 0,
    maintenance: 0,
    subsidy: 0,
    spent: 0,
    nextGrantAt: 0,
    lastMaintenanceAt: time,
    farePerKm: DEFAULT_FARE_PER_KM,
    grantsClaimed: 0,
    loan: null,
    ledger: [{ at: time, category: "opening", amount: INITIAL_CASH }],
    totals: { opening: INITIAL_CASH },
    runningAccrued: { loaded: 0, empty: 0 },
    upkeepAccrued: {},
    distanceKm: { loaded: 0, empty: 0 },
  };
}

/** All cash mutations pass here, including edit deposits and refunds. */
export function book(
  world: World,
  category: LedgerCategory,
  value: number,
): void {
  if (!Number.isFinite(value)) throw new Error("Invalid cash movement");
  const amount = money(value);
  if (!amount) return;
  const economy = world.economy;
  economy.cash = money(economy.cash + amount);
  economy.totals ??= {};
  economy.totals[category] = money(
    (economy.totals[category] ?? 0) + Math.abs(amount),
  );
  economy.ledger ??= [];
  economy.ledger.push({ at: world.time, category, amount });
  if (economy.ledger.length > LEDGER_LIMIT)
    economy.ledger.splice(0, economy.ledger.length - LEDGER_LIMIT);
  if (category === "fare") economy.income = money(economy.income + amount);
  if (category === "grant") economy.subsidy = money(economy.subsidy + amount);
  if (category.endsWith("upkeep") || category.endsWith("running"))
    economy.maintenance = money(economy.maintenance - amount);
  if (category.endsWith("build") || category === "pod-buy")
    economy.spent = money(economy.spent - amount);
}

export function claimGrant(world: World): number {
  const used = world.economy.grantsClaimed ?? 0;
  if (used >= GOVERNMENT_GRANTS) return 0;
  world.economy.grantsClaimed = used + 1;
  book(world, "grant", GOVERNMENT_GRANT_AMOUNT);
  return GOVERNMENT_GRANT_AMOUNT;
}

export function takeLoan(world: World): boolean {
  if (
    (world.economy.grantsClaimed ?? 0) < GOVERNMENT_GRANTS ||
    world.economy.loan
  )
    return false;
  world.economy.loan = {
    principal: LOAN_AMOUNT,
    remaining: LOAN_AMOUNT,
    installment: LOAN_AMOUNT / LOAN_TERM_DAYS,
    nextPaymentAt: world.time + CITY_DAY_SECONDS,
    arrears: 0,
  };
  book(world, "loan", LOAN_AMOUNT);
  return true;
}

export function repayLoan(world: World): boolean {
  const loan = world.economy.loan;
  if (!loan || world.economy.cash < loan.remaining) return false;
  book(world, "repayment", -loan.remaining);
  world.economy.loan = null;
  return true;
}

export function loadedDistanceKm(plan: ServicePlan): number {
  return plan.segments.reduce(
    (sum, segment) =>
      sum +
      (segment.kind === "move" && segment.stage === "loaded"
        ? (distance(segment.from, segment.to) * CELL_METERS) / 1000
        : 0),
    0,
  );
}

/** Charge only movement actually traversed this tick, including empty approach.
 * Never charge an entire future reservation or a stationary wait. */
export function accruePodMovement(
  world: World,
  plan: ServicePlan,
  from: number,
  to: number,
): void {
  if (!(to > from)) return;
  const accrued = (world.economy.runningAccrued ??= { loaded: 0, empty: 0 });
  const traveled = (world.economy.distanceKm ??= { loaded: 0, empty: 0 });
  for (const segment of plan.segments) {
    if (segment.kind !== "move") continue;
    const overlap = Math.max(
      0,
      Math.min(to, segment.end) - Math.max(from, segment.start),
    );
    if (!overlap || segment.end <= segment.start) continue;
    const km =
      (((distance(segment.from, segment.to) * CELL_METERS) / 1000) * overlap) /
      (segment.end - segment.start);
    const kind = segment.stage === "loaded" ? "loaded" : "empty";
    traveled[kind] += km;
    accrued[kind] += km * POD_RUNNING_PER_KM;
  }
}

export function dailyUpkeep(world: World) {
  return {
    "track-upkeep":
      world.tracks.reduce(
        (sum, track) =>
          sum +
          ((distance(track.a, track.b) * CELL_METERS) / 1000) *
            (track.lanes ?? 1),
        0,
      ) * TRACK_UPKEEP_PER_LANE_KM_DAY,
    "platform-upkeep":
      world.berths.filter((b) => b.kind === "platform").length *
      PLATFORM_UPKEEP_PER_DAY,
    "parking-upkeep":
      world.berths.filter((b) => b.kind === "parking").length *
      PARKING_UPKEEP_PER_DAY,
    "pod-upkeep": world.pods.length * POD_UPKEEP_PER_DAY,
  };
}

export function updateEconomy(world: World, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const economy = world.economy;
  while (world.time >= economy.lastMaintenanceAt + 60) {
    economy.lastMaintenanceAt += 60;
    const maintenance = (economy.upkeepAccrued ??= {});
    for (const [key, daily] of Object.entries(dailyUpkeep(world))) {
      const category = key as UpkeepCategory;
      const due =
        (maintenance[category] ?? 0) + (daily * 60) / CITY_DAY_SECONDS;
      const paid = Math.floor((due + 1e-10) * 100) / 100;
      book(world, category, -paid);
      maintenance[category] = Math.max(0, due - paid);
    }
    const accrued = (economy.runningAccrued ??= { loaded: 0, empty: 0 });
    for (const kind of ["loaded", "empty"] as const) {
      // Keep sub-cent remainder so repeated short movements cannot become free.
      const paid = Math.floor((accrued[kind] + 1e-10) * 100) / 100;
      book(world, `${kind}-running`, -paid);
      accrued[kind] = Math.max(0, accrued[kind] - paid);
    }
  }
  const loan = economy.loan;
  if (!loan) return;
  while (world.time >= loan.nextPaymentAt && loan.remaining > 0) {
    book(world, "interest", -money(loan.remaining * LOAN_DAILY_RATE));
    loan.arrears = money(
      loan.arrears + Math.min(loan.installment, loan.remaining - loan.arrears),
    );
    const principalPayment = money(
      Math.min(loan.arrears, Math.max(0, economy.cash)),
    );
    if (principalPayment > 0) {
      book(world, "repayment", -principalPayment);
      loan.remaining = money(loan.remaining - principalPayment);
      loan.arrears = money(loan.arrears - principalPayment);
    }
    loan.nextPaymentAt += CITY_DAY_SECONDS;
  }
  if (loan.remaining === 0) economy.loan = null;
}
