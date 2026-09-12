/** Pure city-demand and mode-choice policy. It deliberately has no network state. */
export type DemandNode = {
  id: string;
  kind: 'residential' | 'office' | 'university' | 'leisure' | 'junction';
  population: number;
};
export type DemandPair = { origin: string; destination: string };

const CORE_MIX: readonly (readonly [string, string, number])[] = [
  ['n1', 'c1', 0.3],
  ['n2', 'c1', 0.16],
  ['n4', 'c2', 0.16],
  ['n3', 'c2', 0.12],
  ['u3', 'u2', 0.12],
  ['n1', 'u1', 0.05],
  ['u3', 'c2', 0.04],
  ['n2', 'u1', 0.05],
];

/**
 * Keeps 75% of trips in the recognizable commuter mix. The other 25% is
 * independent of the network and lets every city building originate and attract
 * trips (including leisure destinations).
 */
export function chooseDemandPair(nodes: readonly DemandNode[], random: () => number): DemandPair {
  let roll = random();
  if (roll <= 0.75) {
    roll /= 0.75;
    for (const [origin, destination, weight] of CORE_MIX) {
      roll -= weight;
      if (roll <= 0) return { origin, destination };
    }
    return { origin: 'n1', destination: 'c1' };
  }
  const buildings = nodes.filter((n) => n.kind !== 'junction');
  if (buildings.length < 2) throw new Error('Demand needs at least two buildings');
  const origin =
    buildings[Math.min(buildings.length - 1, Math.floor(random() * buildings.length))].id;
  let destination =
    buildings[Math.min(buildings.length - 1, Math.floor(random() * buildings.length))].id;
  if (destination === origin)
    destination =
      buildings[(buildings.findIndex((n) => n.id === origin) + 1) % buildings.length].id;
  return { origin, destination };
}

export type ModeChoiceInput = {
  podTravelSeconds: number;
  expectedWaitSeconds: number;
  fare: number;
  directDistance: number;
};

export type ModeBenchmarks = { pod: number; car: number; bus: number; metro: number };

/** Comparable generalized costs in simulation seconds; lower is more attractive. */
export function modeBenchmarks(input: ModeChoiceInput): ModeBenchmarks {
  const directTrip = Math.max(6, input.directDistance / 18);
  return {
    pod: input.podTravelSeconds + input.expectedWaitSeconds * 1.35 + input.fare * 7,
    // Door-to-door car is quick but pays for parking/congestion in the city core.
    car: directTrip + 60,
    bus: directTrip * 1.7 + 26 + 18,
    metro: directTrip * 1.28 + 17 + 22,
  };
}

export function podAdoptionProbability(input: ModeChoiceInput, preference = 0): number {
  const costs = modeBenchmarks(input);
  const alternative = Math.min(costs.car, costs.bus, costs.metro);
  // A 25-second scale gives a smooth response while a fare change remains visible.
  const raw = 1 / (1 + Math.exp((costs.pod - alternative - preference) / 25));
  return Math.max(0.01, Math.min(0.99, raw));
}

/** A stable rider preference turns the probability into a deterministic choice. */
export function choosesPod(
  input: ModeChoiceInput,
  preferenceRoll: number,
  decisionRoll: number,
): boolean {
  const preference = (Math.max(0, Math.min(1, preferenceRoll)) * 2 - 1) * 8;
  return Math.max(0, Math.min(1, decisionRoll)) < podAdoptionProbability(input, preference);
}

export type WaitEstimateInput = {
  queued: number;
  assigned: number;
  podCount: number;
  activeRemainingSeconds: number;
  routeSeconds: number;
  recentServiceSeconds: readonly number[];
  recentWaitSeconds: readonly number[];
};

/** Conservative estimate based on live backlog plus completed-service observations. */
export function estimateExpectedWait(input: WaitEstimateInput): number {
  const mean = (values: readonly number[], fallback: number) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
  const service = mean(input.recentServiceSeconds, Math.max(12, input.routeSeconds));
  const observedWait = mean(input.recentWaitSeconds, 0);
  const backlog =
    ((Math.max(0, input.queued) + Math.max(0, input.assigned)) * service) /
    Math.max(1, input.podCount);
  return Math.max(
    0,
    Math.ceil(
      backlog +
        Math.max(0, input.activeRemainingSeconds) / Math.max(1, input.podCount) +
        observedWait * 0.25,
    ),
  );
}
