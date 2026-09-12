import { FARE, GRANT_AMOUNT, GRANT_INTERVAL } from "../shared/constants";
import type { Notice, TripRecord, World } from "../shared/types";

export {
  initialBuildings,
  initializeCityGrowth,
  updateGrowth,
} from "./lifecycle";

function notice(
  world: World,
  text: string,
  textEn: string,
  kind: Notice["kind"] = "info",
): void {
  world.notices.push({
    id: world.nextId++,
    time: world.time,
    text,
    textEn,
    kind,
  });
  world.notices = world.notices.slice(-8);
}

function assetValue(world: World): number {
  return (
    world.tracks.reduce((sum, track) => sum + Math.max(0, track.paid), 0) +
    world.berths.reduce((sum, berth) => sum + Math.max(0, berth.paid), 0) +
    world.pods.reduce((sum, pod) => sum + Math.max(0, pod.paid), 0)
  );
}

function settleMaintenance(world: World): void {
  const assets = assetValue(world);
  if (assets <= 0) return;
  const due = Math.max(1, Math.ceil(assets / 3000));
  // Operations may consume no more than 20% of actual fare income. Excess
  // upkeep is waived, not paid as an automatic cash subsidy.
  const fareAllowance = Math.floor(world.economy.income * 0.2);
  const remainingAllowance = Math.max(
    0,
    fareAllowance - world.economy.maintenance,
  );
  const charged = Math.min(
    due,
    remainingAllowance,
    Math.max(0, world.economy.cash),
  );
  world.economy.cash -= charged;
  world.economy.maintenance += charged;
}

/** Cash only changes when the player claims the available grants. */
export function claimGrant(world: World): number {
  const amount =
    (world.economy.pendingGrant ?? 0) + (world.economy.pendingGrowthGrant ?? 0);
  if (amount <= 0) return 0;
  world.economy.pendingGrant = 0;
  world.economy.pendingGrowthGrant = 0;
  world.economy.cash += amount;
  world.economy.subsidy += amount;
  return amount;
}

export function updateEconomy(world: World, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  while (world.time >= world.economy.nextGrantAt) {
    if (world.economy.cash < 3000 && !world.economy.pendingGrant) {
      // Keep one unclaimed installment; waiting does not stack free money.
      world.economy.pendingGrant = GRANT_AMOUNT;
      notice(
        world,
        `建设补助 ${GRANT_AMOUNT} 可领取。`,
        `A ${GRANT_AMOUNT} construction grant is ready to claim.`,
        "success",
      );
    }
    // Skipped grants are not banked for when the balance later falls.
    world.economy.nextGrantAt += GRANT_INTERVAL;
  }
  while (world.time >= world.economy.lastMaintenanceAt + 60) {
    world.economy.lastMaintenanceAt += 60;
    settleMaintenance(world);
  }
  world.economy.cash = Math.max(0, world.economy.cash);
}

export function recordDelivery(world: World, trip: TripRecord): void {
  const actualSeconds = trip.endedAt - trip.startedAt;
  world.metrics.savedSeconds += trip.walkBaseline - actualSeconds;
  world.metrics.totalWait += Math.max(0, trip.waited);
  world.metrics.recentTrips.push({ ...trip });
  world.metrics.recentTrips = world.metrics.recentTrips.slice(-160);
  if (trip.mode === "pod") {
    world.metrics.served += 1;
    world.economy.income += FARE;
    world.economy.cash += FARE;
    notice(
      world,
      `Pod 已送达，票款 +${FARE}。`,
      `Pod delivered; fare +${FARE}.`,
      "success",
    );
  } else {
    world.metrics.walked += 1;
    notice(world, "居民步行抵达。", "Resident arrived on foot.");
  }
}
