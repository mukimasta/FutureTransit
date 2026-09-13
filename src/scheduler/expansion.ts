import {
  movementLaneIndex,
  movementResourceOptions,
  movementResources,
  preserveThroughCorridors,
} from "../network";
import {
  assertTrajectory,
  requiredTrajectoryWindows,
} from "../shared/trajectory";
import type { Reservation, World } from "../shared/types";

/** An additive edit changes capacity, never geometry/time of a committed trip.
 * Rebind its physical reservations atomically before new dispatch can use the
 * extra capacity. In particular edge:... becomes lane:...:0 when widening. */
export function prepareExpansion(before: World, after: World): World {
  const candidate: World = {
    ...after,
    resourceModel: 2,
    networkVersion: before.networkVersion + 1,
  };
  preserveThroughCorridors(before, candidate);
  const activeOwners = new Set(
    before.pods.filter((pod) => pod.plan).map((pod) => pod.id),
  );
  candidate.pods = before.pods.map((pod) => {
    if (!pod.plan) return pod;
    const original = pod.plan;
    const lanes = original.segments.map((segment) =>
      segment.kind === "move"
        ? (movementLaneIndex(
            before,
            segment.from,
            segment.to,
            segment.resources,
          ) ?? 0)
        : 0,
    );
    // The dispatcher uses one lane profile along a route, clipped on narrow
    // edges. Recover that profile so widening does not introduce a lane change.
    const profile = Math.max(...lanes);
    const segments = original.segments.map((segment, index) => {
      if (segment.kind !== "move") return segment;
      const oldCount = movementResourceOptions(
        before,
        segment.from,
        segment.to,
      ).length;
      const count = movementResourceOptions(
        candidate,
        segment.from,
        segment.to,
      ).length;
      const lane =
        count > oldCount ? Math.min(profile, count - 1) : lanes[index];
      return {
        ...segment,
        resources: movementResources(candidate, segment.from, segment.to, lane),
      };
    });
    const reservations: Reservation[] = requiredTrajectoryWindows(
      candidate,
      segments,
      original.safetyBuffer ?? 0,
    ).map((window) => ({ ...window, ownerId: pod.id }));
    if (original.departure > before.time)
      reservations.push({
        resource: `berth:${original.originBerthId}`,
        start: before.time,
        end: original.departure,
        ownerId: pod.id,
      });
    const plan = { ...original, segments, reservations };
    assertTrajectory(candidate, plan);
    return { ...pod, plan };
  });
  // Completed trips retain only terminal berth/connector clearance. Additive
  // construction cannot move a berth or widen its automatic connector.
  candidate.reservations = [
    ...before.reservations.filter(
      (reservation) =>
        !activeOwners.has(reservation.ownerId) && reservation.end > before.time,
    ),
    ...candidate.pods.flatMap((pod) => pod.plan?.reservations ?? []),
  ];
  return candidate;
}
