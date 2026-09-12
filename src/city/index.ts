import type { Notice, TripRecord, World } from "../shared/types";
import { book, fareForDistance, fareRate } from "../economy";

export {
  initialBuildings,
  initializeCityGrowth,
  updateGrowth,
} from "./lifecycle";
export { claimGrant, updateEconomy } from "../economy";

function notice(
  world: World,
  text: string,
  textEn: string,
  kind: Notice["kind"] = "info",
) {
  world.notices.push({
    id: world.nextId++,
    time: world.time,
    text,
    textEn,
    kind,
  });
  world.notices = world.notices.slice(-8);
}

export function recordDelivery(world: World, trip: TripRecord): void {
  const actualSeconds = trip.endedAt - trip.startedAt;
  world.metrics.savedSeconds += trip.walkBaseline - actualSeconds;
  world.metrics.totalWait += Math.max(0, trip.waited);
  if (trip.mode === "pod") {
    const fare = fareForDistance(
      trip.distanceKm ?? 0,
      trip.farePerKm ?? fareRate(world),
    );
    trip = { ...trip, fare };
    world.metrics.served += 1;
    book(world, "fare", fare);
    notice(
      world,
      `Pod 已送达，${(trip.distanceKm ?? 0).toFixed(2)} 公里 · 票款 +${fare.toFixed(2)}。`,
      `Pod delivered, ${(trip.distanceKm ?? 0).toFixed(2)} km · fare +${fare.toFixed(2)}.`,
      "success",
    );
  } else {
    world.metrics.walked += 1;
    notice(world, "居民步行抵达。", "Resident arrived on foot.");
  }
  world.metrics.recentTrips.push({ ...trip });
  world.metrics.recentTrips = world.metrics.recentTrips.slice(-160);
}
