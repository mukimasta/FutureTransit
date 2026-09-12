import { fareForDistance, fareRate } from "../economy";
import { random } from "../shared/math";
import type { Resident, TravelDecision, World } from "../shared/types";

export interface TravelOption {
  waitSeconds: number;
  rideSeconds: number;
  podSeconds: number;
  distanceKm: number;
}

export function decideTravel(
  world: World,
  resident: Resident,
  walkSeconds: number,
  option: TravelOption | null,
  unavailable: TravelDecision["reason"] = "no-platform",
): TravelDecision {
  // One draw at departure, never each tick or each inspector render.
  if (resident.podPreference === undefined) {
    let hash = 0;
    for (const char of resident.id)
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    resident.podPreference = (hash % 181) - 90;
  }
  const preferenceSeconds = resident.podPreference + (random(world) - 0.5) * 90;
  const rate = fareRate(world);
  const base: TravelDecision = {
    at: world.time,
    mode: "walk",
    walkSeconds,
    farePerKm: rate,
    preferenceSeconds,
    reason: unavailable,
  };
  if (!option || !Number.isFinite(option.podSeconds)) return base;
  const fare = fareForDistance(option.distanceKm, rate);
  const timeAndFare = option.podSeconds + fare * resident.fareSensitivity;
  const mode =
    walkSeconds > 150 && timeAndFare + preferenceSeconds < walkSeconds
      ? "pod"
      : "walk";
  const reason: TravelDecision["reason"] =
    walkSeconds <= 150
      ? "short-walk"
      : mode === "pod"
        ? timeAndFare >= walkSeconds
          ? "preference"
          : "faster"
        : option.podSeconds >= walkSeconds
          ? "wait"
          : timeAndFare >= walkSeconds
            ? "price"
            : "preference";
  return { ...base, ...option, fare, mode, reason };
}
