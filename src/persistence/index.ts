import type { Reservation, ServicePlan, World } from "../shared/types";
import {
  MAX_BUILDINGS,
  MAX_MAP_SIZE,
  MAX_PODS,
  MAX_RESIDENTS,
  TRACK_UPGRADE_COST,
} from "../shared/constants";
import { initializeCityGrowth } from "../city";
import {
  CITY_DAY_SECONDS,
  GOVERNMENT_GRANTS,
  GOVERNMENT_GRANT_AMOUNT,
  LEDGER_CATEGORIES,
  LEDGER_LIMIT,
  LOAN_AMOUNT,
  LOAN_TERM_DAYS,
  MAX_FARE_PER_KM,
  MIN_FARE_PER_KM,
} from "../economy/config";
import {
  buildingDoor,
  canonicalMovementResources,
  corridorNodeResources,
  edgeKey,
  isBlocked,
  movementResources,
  nodeKey,
  trackResources,
} from "../network";
import { distance, samePoint } from "../shared/math";
import {
  assertTrajectory,
  requiredTrajectoryWindows,
} from "../shared/trajectory";

export const SAVE_KEY = "futuretransit-mvp-stations-v3";
const purposes = [
  "work",
  "shop",
  "visit",
  "home",
  "study",
  "care",
  "meal",
  "leisure",
];
const fail = (message: string): never => {
  throw new Error(`存档无效 / Invalid save: ${message}`);
};
function check(value: unknown, message: string): asserts value {
  if (!value) fail(message);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "expected object",
  );
}
function number(value: unknown, min = 0, max = 1e12): asserts value is number {
  check(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    "number out of range",
  );
}
function string(value: unknown): asserts value is string {
  check(
    typeof value === "string" && value.length > 0 && value.length <= 200,
    "invalid text",
  );
}
function array(value: unknown, max: number): asserts value is unknown[] {
  check(
    Array.isArray(value) && value.length <= max,
    "array too large or missing",
  );
}
function ids(items: { id: string }[]) {
  const keys = new Set<string>();
  for (const item of items) {
    string(item.id);
    check(!keys.has(item.id), "duplicate identity");
    keys.add(item.id);
  }
  return keys;
}
function finiteTree(value: unknown, depth = 0): void {
  check(depth <= 24, "structure too deep");
  if (typeof value === "number")
    check(Number.isFinite(value), "non-finite value");
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      check(
        !["__proto__", "prototype", "constructor"].includes(key),
        "unsafe property",
      );
      finiteTree(child, depth + 1);
    }
}

function sameResources(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((resource) => right.includes(resource))
  );
}

function rebuiltPlanReservations(
  world: World,
  plan: ServicePlan,
): Reservation[] {
  const windows = requiredTrajectoryWindows(
    world,
    plan.segments,
    plan.safetyBuffer ?? 0,
  ).map((window) => ({ ...window, ownerId: plan.podId }));
  if (plan.departure > world.time + 1e-8)
    windows.push({
      resource: `berth:${plan.originBerthId}`,
      start: world.time,
      end: plan.departure,
      ownerId: plan.podId,
    });
  windows.sort(
    (left, right) =>
      left.resource.localeCompare(right.resource) ||
      left.start - right.start ||
      left.end - right.end,
  );
  const merged: Reservation[] = [];
  for (const window of windows) {
    const prior = merged.at(-1);
    if (
      prior &&
      prior.resource === window.resource &&
      window.start <= prior.end + 1e-8
    )
      prior.end = Math.max(prior.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

export function serializeWorld(world: World): string {
  return JSON.stringify({ format: "futuretransit-mvp", version: 2, world });
}

export function parseWorld(text: string): World {
  check(
    typeof text === "string" && text.length <= 64_000_000,
    "file too large",
  );
  const envelope: unknown = JSON.parse(text);
  object(envelope);
  check(
    envelope.format === "futuretransit-mvp" && envelope.version === 2,
    "此版本需要新建城市，不支持旧版存档 / This version needs a new city; old saves are not supported",
  );
  object(envelope.world);
  finiteTree(envelope.world);
  const w = envelope.world as unknown as World;
  check(w.version === 2, "unsupported world");
  check(
    w.resourceModel === undefined || w.resourceModel === 2,
    "unsupported reservation model",
  );
  number(w.time);
  number(w.seed);
  number(w.rng, 1, 4294967295);
  number(w.nextId, 1);
  number(w.networkVersion);
  number(w.width, 10, MAX_MAP_SIZE);
  number(w.height, 10, MAX_MAP_SIZE);
  check(
    Number.isInteger(w.width) && Number.isInteger(w.height),
    "invalid map size",
  );
  check(
    typeof w.paused === "boolean" && [1, 2, 4].includes(w.speed),
    "invalid clock",
  );
  array(w.buildings, MAX_BUILDINGS);
  array(w.residents, MAX_RESIDENTS);
  array(w.pods, MAX_PODS);
  array(w.berths, 2048);
  array(w.tracks, 12000);
  array(w.reservations, 512000);
  array(w.notices, 8);
  array(w.pendingEdits, 256);
  check(w.buildings.length >= 3 && w.pods.length >= 1, "empty city");
  const buildingIds = ids(w.buildings),
    berthIds = ids(w.berths),
    residentIds = ids(w.residents),
    podIds = ids(w.pods);
  ids(w.tracks);
  const generatedIds = [
    ...buildingIds,
    ...berthIds,
    ...residentIds,
    ...podIds,
  ].map((id) =>
    Number(id.match(/^(?:b-|berth-|resident-|pod-)(\d+)$/)?.[1] ?? 0),
  );
  check(
    Number.isInteger(w.nextId) &&
      w.nextId > Math.max(0, ...generatedIds, ...w.notices.map((n) => n.id)),
    "nextId identity high-water mark",
  );
  const point = (p: { x: number; y: number }, grid = true) => {
    object(p);
    number(p.x, 0, w.width - 1);
    number(p.y, 0, w.height - 1);
    if (grid)
      check(
        Number.isInteger(p.x) && Number.isInteger(p.y),
        "invalid grid point",
      );
  };
  for (const b of w.buildings) {
    point(b);
    string(b.name);
    string(b.nameEn);
    check(
      [
        "home",
        "office",
        "shop",
        "school",
        "hospital",
        "restaurant",
        "park",
      ].includes(b.kind),
      "building kind",
    );
    number(b.w, 1, 12);
    number(b.h, 1, 12);
    check(
      Number.isInteger(b.w) &&
        Number.isInteger(b.h) &&
        b.x + b.w <= w.width &&
        b.y + b.h <= w.height,
      "building footprint",
    );
    number(b.bornAt, 0, w.time);
    if (b.development !== undefined) {
      const d = b.development;
      object(d);
      number(d.capacity, 1, MAX_RESIDENTS);
      number(d.nextAt);
      number(d.district, 0, 1_000_000);
      number(d.shift, 0, CITY_DAY_SECONDS);
      check(
        Number.isInteger(d.capacity) && Number.isInteger(d.district),
        "development capacity",
      );
      check([1, 2, 3].includes(d.stage), "development stage");
      check(["organic", "ordered"].includes(d.layout), "district layout");
      check(
        ["local", "employment", "commercial"].includes(d.role),
        "building role",
      );
      check(
        d.role !== "employment" ||
          ["office", "school", "hospital"].includes(b.kind),
        "employment center kind",
      );
      check(
        d.role !== "commercial" || ["shop", "restaurant"].includes(b.kind),
        "commercial center kind",
      );
    }
  }
  for (let i = 0; i < w.buildings.length; i++)
    for (let j = i + 1; j < w.buildings.length; j++) {
      const a = w.buildings[i],
        b = w.buildings[j];
      check(
        a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y,
        "overlapping buildings",
      );
    }
  const berthPositions = new Set<string>();
  for (const b of w.berths) {
    // The previous revision stored a station owner. It is no longer a runtime
    // relationship; retain the physical bay and discard only that old metadata.
    if ("platformId" in b) delete b.platformId;
    if (b.kind === "platform") {
      check(
        b.buildingId === undefined || buildingIds.has(b.buildingId),
        "platform building",
      );
    } else {
      check(b.buildingId === undefined, "parking is independent of buildings");
    }
    check(
      ["platform", "parking"].includes(b.kind) &&
        ["north", "east", "south", "west"].includes(b.side),
      "berth kind",
    );
    point(b.point);
    point(b.access);
    number(b.paid);
    check(
      !isBlocked(w, b.point) &&
        !isBlocked(w, b.access) &&
        distance(b.point, b.access) === 1,
      "berth geometry",
    );
    check(!berthPositions.has(nodeKey(b.point)), "overlapping berths");
    berthPositions.add(nodeKey(b.point));
  }
  for (const b of w.berths)
    check(
      !berthPositions.has(nodeKey(b.access)),
      "berth access blocked by another berth",
    );
  const physicalTracks = new Set<string>();
  for (const t of w.tracks) {
    point(t.a);
    point(t.b);
    number(t.paid);
    check(
      t.lanes === undefined || t.lanes === 1 || t.lanes === 2 || t.lanes === 3,
      "track lanes",
    );
    const d = distance(t.a, t.b);
    check(
      d > 0 &&
        d <= Math.SQRT2 + 1e-8 &&
        !isBlocked(w, t.a) &&
        !isBlocked(w, t.b),
      "track geometry",
    );
    check(
      !berthPositions.has(nodeKey(t.a)) && !berthPositions.has(nodeKey(t.b)),
      "track through berth",
    );
    const key = edgeKey(t.a, t.b);
    check(!physicalTracks.has(key), "duplicate track geometry");
    physicalTracks.add(key);
  }
  if (w.throughCorridors !== undefined) {
    check(
      w.resourceModel === 2,
      "through lanes require the current reservation model",
    );
    array(w.throughCorridors, 24000);
    const seen = new Set<string>();
    for (const entry of w.throughCorridors) {
      object(entry);
      point(entry.point);
      point(entry.from);
      point(entry.to);
      const key = nodeKey(entry.point);
      check(
        !seen.has(key) && !samePoint(entry.from, entry.to),
        "duplicate through corridor",
      );
      seen.add(key);
      for (const neighbor of [entry.from, entry.to])
        check(
          w.tracks.some(
            (track) =>
              (track.lanes ?? 1) >= 2 &&
              ((samePoint(track.a, entry.point) &&
                samePoint(track.b, neighbor)) ||
                (samePoint(track.b, entry.point) &&
                  samePoint(track.a, neighbor))),
          ),
          "missing through corridor edge",
        );
    }
  }
  const validResources = new Set<string>();
  for (const b of w.berths) {
    validResources.add(`berth:${b.id}`);
    corridorNodeResources(w, b.point).forEach((k) => validResources.add(k));
    corridorNodeResources(w, b.access).forEach((k) => validResources.add(k));
    movementResources(w, b.point, b.access).forEach((k) =>
      validResources.add(k),
    );
    movementResources(w, b.access, b.point).forEach((k) =>
      validResources.add(k),
    );
  }
  for (const t of w.tracks) {
    trackResources(w, t).forEach((k) => validResources.add(k));
    corridorNodeResources(w, t.a).forEach((k) => validResources.add(k));
    corridorNodeResources(w, t.b).forEach((k) => validResources.add(k));
  }
  // Check the original calendar before any compatibility rewrite so malformed
  // or invented legacy resources cannot be silently discarded.
  for (const reservation of w.reservations) {
    string(reservation.resource);
    string(reservation.ownerId);
    number(reservation.start);
    number(reservation.end, reservation.start + 1e-8);
    check(
      validResources.has(reservation.resource) &&
        podIds.has(reservation.ownerId),
      "unknown reservation",
    );
  }
  const terminalClaims = new Set<string>();
  const passengerClaims = new Set<string>();
  const migratedOwners = new Set<string>();
  const reconstructed: {
    resource: string;
    start: number;
    end: number;
    owner: string;
  }[] = [];
  for (const pod of w.pods) {
    number(pod.parkedSince, 0, w.time);
    number(pod.trips);
    number(pod.paid);
    check(pod.berthId === null || berthIds.has(pod.berthId), "pod position");
    const terminal = pod.plan?.finalBerthId ?? pod.berthId;
    check(
      terminal && berthIds.has(terminal) && !terminalClaims.has(terminal),
      "duplicate or missing final berth",
    );
    terminalClaims.add(terminal);
    if (!pod.plan) {
      check(pod.berthId, "idle pod without berth");
      reconstructed.push({
        resource: `berth:${pod.berthId}`,
        start: w.time,
        end: Infinity,
        owner: pod.id,
      });
      continue;
    }
    const plan = pod.plan;
    object(plan);
    check(
      plan.safetyBuffer === undefined || plan.safetyBuffer === 1,
      "plan safety buffer",
    );
    check(
      plan.podId === pod.id && berthIds.has(plan.originBerthId),
      "plan origin",
    );
    check(
      plan.residentId === null || residentIds.has(plan.residentId),
      "plan resident",
    );
    number(plan.requestedAt, 0, w.time);
    number(plan.departure, 0, w.time + 1800);
    number(plan.end, w.time, w.time + 3600);
    array(plan.segments, 5000);
    array(plan.reservations, 20000);
    check(plan.segments.length > 0, "empty plan");
    check(
      samePoint(
        plan.segments[0].from,
        w.berths.find((b) => b.id === plan.originBerthId)!.point,
      ) &&
        samePoint(
          plan.segments.at(-1)!.to,
          w.berths.find((b) => b.id === terminal)!.point,
        ),
      "plan endpoints",
    );
    check(
      Math.abs(plan.segments[0].start - plan.departure) < 1e-6 &&
        Math.abs(plan.segments.at(-1)!.end - plan.end) < 1e-6,
      "plan end time",
    );
    let legacyPlan = false;
    for (let i = 0; i < plan.segments.length; i++) {
      const s = plan.segments[i];
      point(s.from);
      point(s.to);
      number(s.start);
      number(s.end, s.start + 1e-8);
      check(
        ["move", "node", "boarding", "alighting"].includes(s.kind) &&
          ["empty", "loaded", "relocate"].includes(s.stage),
        "segment type",
      );
      array(s.resources, 8);
      if (i)
        check(
          samePoint(plan.segments[i - 1].to, s.from) &&
            Math.abs(plan.segments[i - 1].end - s.start) < 1e-6,
          "discontinuous trajectory",
        );
      const keys =
        s.kind === "move"
          ? canonicalMovementResources(w, s.from, s.to, s.resources)
          : [
              nodeKey(s.from),
              ...w.berths
                .filter((b) => samePoint(b.point, s.from))
                .map((b) => `berth:${b.id}`),
            ];
      if (s.kind === "move")
        check(
          distance(s.from, s.to) > 0 &&
            distance(s.from, s.to) <= Math.SQRT2 + 1e-8,
          "impossible move",
        );
      else check(samePoint(s.from, s.to), "moving dwell");
      check(
        keys && keys.every((key) => validResources.has(key)),
        "trajectory outside network",
      );
      if (s.kind === "move" && keys)
        legacyPlan ||= !sameResources(keys, s.resources);
      check(
        s.kind === "move" ||
          (keys!.length === s.resources.length &&
            keys!.every((key) => s.resources.includes(key))),
        "wrong trajectory resources",
      );
    }
    if (legacyPlan) {
      for (const reservation of plan.reservations) {
        string(reservation.resource);
        number(reservation.start);
        number(reservation.end, reservation.start + 1e-8);
        check(
          reservation.ownerId === pod.id &&
            validResources.has(reservation.resource),
          "invalid legacy reservation",
        );
      }
      for (const segment of plan.segments) {
        if (segment.kind !== "move") continue;
        const canonical = canonicalMovementResources(
          w,
          segment.from,
          segment.to,
          segment.resources,
        )!;
        const covers = (resources: string[]) =>
          resources.every((resource) =>
            plan.reservations.some(
              (reservation) =>
                reservation.resource === resource &&
                reservation.start <= segment.start + 1e-6 &&
                reservation.end >= segment.end - 1e-6,
            ),
          );
        check(
          covers(segment.resources) || covers(canonical),
          "legacy trajectory without reservation",
        );
      }
      // Old v1 directional slots are mapped to shared physical slots by
      // canonical edge orientation. The active plan and passenger stay intact;
      // only its physical reservation calendar is rebuilt.
      plan.reservations = rebuiltPlanReservations(w, plan);
      migratedOwners.add(pod.id);
    }
    if (plan.departure > w.time)
      reconstructed.push({
        resource: `berth:${plan.originBerthId}`,
        start: w.time,
        end: plan.departure,
        owner: pod.id,
      });
    reconstructed.push({
      resource: `berth:${terminal}`,
      start: plan.end,
      end: Infinity,
      owner: pod.id,
    });
    if (plan.residentId) {
      check(
        plan.pickupId &&
          plan.dropoffId &&
          berthIds.has(plan.pickupId) &&
          berthIds.has(plan.dropoffId),
        "passenger platforms",
      );
      for (const t of [
        plan.pickupStart,
        plan.pickupEnd,
        plan.dropoffStart,
        plan.dropoffEnd,
      ])
        number(t, plan.departure, plan.end);
      check(
        plan.pickupStart! < plan.pickupEnd! &&
          plan.pickupEnd! <= plan.dropoffStart! &&
          plan.dropoffStart! < plan.dropoffEnd!,
        "passenger timeline",
      );
    }
    assertTrajectory(w, plan);
    for (const required of requiredTrajectoryWindows(
      w,
      plan.segments,
      plan.safetyBuffer ?? 0,
    )) {
      if (required.end > w.time)
        reconstructed.push({
          resource: required.resource,
          start: Math.max(w.time, required.start),
          end: required.end,
          owner: pod.id,
        });
    }
    if (plan.residentId && plan.dropoffEnd! > w.time) {
      const resident = w.residents.find((r) => r.id === plan.residentId)!;
      check(
        !passengerClaims.has(resident.id) &&
          resident.atBuildingId === null &&
          resident.journey?.podId === pod.id,
        "duplicate or detached passenger identity",
      );
      passengerClaims.add(resident.id);
    }
  }
  if (migratedOwners.size) {
    w.reservations = [
      ...w.reservations.filter(
        (reservation) => !migratedOwners.has(reservation.ownerId),
      ),
      ...w.pods.flatMap((pod) =>
        migratedOwners.has(pod.id) && pod.plan ? pod.plan.reservations : [],
      ),
    ];
  }
  const bookingsByKey = new Map<string, typeof w.reservations>();
  for (const r of w.reservations) {
    string(r.resource);
    check(
      validResources.has(r.resource) && podIds.has(r.ownerId),
      "unknown reservation",
    );
    number(r.start);
    number(r.end, r.start + 1e-8);
    const entries = bookingsByKey.get(r.resource) ?? [];
    entries.push(r);
    bookingsByKey.set(r.resource, entries);
  }
  for (const [key, entries] of bookingsByKey) {
    entries.sort((a, b) => a.start - b.start);
    for (let i = 0; i < entries.length; i++)
      for (
        let j = i + 1;
        j < entries.length && entries[j].start < entries[i].end - 1e-8;
        j++
      )
        check(
          entries[i].ownerId === entries[j].ownerId,
          `reservation collision ${key}`,
        );
  }
  const physical = new Map<string, typeof reconstructed>();
  for (const r of reconstructed) {
    const entries = physical.get(r.resource) ?? [];
    entries.push(r);
    physical.set(r.resource, entries);
    if (Number.isFinite(r.end))
      check(
        (bookingsByKey.get(r.resource) ?? []).some(
          (b) =>
            b.ownerId === r.owner &&
            b.start <= r.start + 1e-6 &&
            b.end >= r.end - 1e-6,
        ),
        `trajectory without reservation ${r.resource}`,
      );
  }
  for (const [key, entries] of physical) {
    entries.sort((a, b) => a.start - b.start);
    for (let i = 0; i < entries.length; i++)
      for (
        let j = i + 1;
        j < entries.length && entries[j].start < entries[i].end - 1e-8;
        j++
      )
        check(
          entries[i].owner === entries[j].owner,
          `physical collision ${key}`,
        );
  }
  for (const r of w.residents) {
    string(r.name);
    string(r.color);
    check(/^#[0-9a-fA-F]{6}$/.test(r.color), "resident color");
    check(
      w.buildings.find((b) => b.id === r.homeId)?.kind === "home" &&
        buildingIds.has(r.workId) &&
        buildingIds.has(r.nextDestinationId),
      "resident places",
    );
    array(r.favorites, 20);
    check(
      r.favorites.every((id) => buildingIds.has(id)),
      "resident favorites",
    );
    number(r.nextDeparture);
    number(r.fareSensitivity, 0, 1000);
    if (r.occupation !== undefined)
      check(
        ["worker", "student", "teacher", "medic", "service"].includes(
          r.occupation,
        ),
        "occupation",
      );
    if (r.podPreference !== undefined) number(r.podPreference, -1000, 1000);
    if (r.decision !== undefined) {
      const d = r.decision;
      object(d);
      number(d.at, 0, w.time);
      if (d.destinationId !== undefined)
        check(buildingIds.has(d.destinationId), "decision destination");
      number(d.walkSeconds);
      number(d.farePerKm, MIN_FARE_PER_KM, MAX_FARE_PER_KM);
      number(d.preferenceSeconds, -2000, 2000);
      check(["pod", "walk"].includes(d.mode), "decision mode");
      check(
        [
          "faster",
          "short-walk",
          "price",
          "wait",
          "preference",
          "no-platform",
          "disconnected",
          "no-pod",
          "wait-abandoned",
        ].includes(d.reason),
        "decision reason",
      );
      for (const key of [
        "podSeconds",
        "waitSeconds",
        "rideSeconds",
        "distanceKm",
        "fare",
      ] as const)
        if (d[key] !== undefined) number(d[key]);
    }
    number(r.trips);
    check(
      purposes.includes(r.purpose) &&
        [
          "inside",
          "walking",
          "waiting",
          "boarding",
          "riding",
          "alighting",
        ].includes(r.status),
      "resident state",
    );
    check(
      r.status === "inside"
        ? buildingIds.has(r.atBuildingId!) && r.journey === null
        : r.atBuildingId === null && !!r.journey,
      "resident location invariant",
    );
    if (!r.journey) continue;
    const j = r.journey;
    check(
      buildingIds.has(j.originId) && buildingIds.has(j.destinationId),
      "journey endpoints",
    );
    number(j.startedAt, 0, w.time);
    number(j.walkBaseline);
    check(
      ["walk", "pod"].includes(j.mode) &&
        ["direct", "access", "queue", "onboard", "egress"].includes(j.stage),
      "journey mode",
    );
    check(purposes.includes(j.purpose), "journey purpose");
    if (r.status === "walking") check(j.walk, "walking without path");
    if (j.eta !== undefined) number(j.eta);
    if (j.waited !== undefined) number(j.waited);
    if (j.farePerKm !== undefined)
      number(j.farePerKm, MIN_FARE_PER_KM, MAX_FARE_PER_KM);
    if (j.distanceKm !== undefined) number(j.distanceKm);
    if (j.egressPath !== undefined) {
      array(j.egressPath, 6000);
      check(j.egressPath.length > 0, "empty egress route");
      j.egressPath.forEach((p) => point(p));
      for (let i = 1; i < j.egressPath.length; i++)
        check(
          distance(j.egressPath[i - 1], j.egressPath[i]) <= Math.SQRT2 + 1e-8,
          "egress teleport",
        );
      const dropoff = w.berths.find((b) => b.id === j.dropoffId);
      check(
        dropoff && samePoint(dropoff.point, j.egressPath[0]),
        "egress station",
      );
      const destination = w.buildings.find((b) => b.id === j.destinationId)!;
      check(
        samePoint(buildingDoor(destination), j.egressPath.at(-1)!),
        "egress destination",
      );
    }
    if (j.walk) {
      array(j.walk.path, 6000);
      check(j.walk.path.length > 0, "empty walking path");
      j.walk.path.forEach((p) => point(p));
      number(j.walk.start, 0, w.time);
      number(j.walk.end, j.walk.start);
      for (let i = 1; i < j.walk.path.length; i++)
        check(
          distance(j.walk.path[i - 1], j.walk.path[i]) <= Math.SQRT2 + 1e-8,
          "walking teleport",
        );
    }
    if (j.pickupId)
      check(
        w.berths.some((b) => b.id === j.pickupId && b.kind === "platform"),
        "missing pickup platform",
      );
    if (j.dropoffId)
      check(
        w.berths.some((b) => b.id === j.dropoffId && b.kind === "platform"),
        "missing dropoff platform",
      );
    if (j.mode === "pod") {
      check(
        j.pickupId &&
          j.dropoffId &&
          j.pickupId !== j.dropoffId &&
          j.stage !== "direct",
        "Pod journey stations",
      );
      if (j.stage === "access" || j.stage === "egress") {
        check(
          r.status === "walking" && j.walk && !j.podId,
          "station walking phase",
        );
        const station = w.berths.find(
          (b) => b.id === (j.stage === "access" ? j.pickupId : j.dropoffId),
        )!;
        const endpoint =
          j.stage === "access" ? j.walk!.path.at(-1)! : j.walk!.path[0];
        check(samePoint(endpoint, station.point), "station walking endpoint");
        if (j.stage === "egress")
          check(
            j.distanceKm !== undefined && j.farePerKm !== undefined,
            "egress loaded fare",
          );
      }
    }
    if (j.podId) check(podIds.has(j.podId), "missing Pod");
    if (["boarding", "riding", "alighting"].includes(r.status))
      check(
        w.pods.find((p) => p.id === j.podId)?.plan?.residentId === r.id,
        "passenger-Pod mismatch",
      );
  }
  object(w.economy);
  check(w.economy.model === 2, "economy model");
  number(w.economy.cash, -1e12);
  number(w.economy.farePerKm, MIN_FARE_PER_KM, MAX_FARE_PER_KM);
  number(w.economy.grantsClaimed, 0, GOVERNMENT_GRANTS);
  check(Number.isInteger(w.economy.grantsClaimed), "grant count");
  check(
    w.economy.subsidy === w.economy.grantsClaimed! * GOVERNMENT_GRANT_AMOUNT,
    "grant history",
  );
  array(w.economy.ledger, LEDGER_LIMIT);
  for (const entry of w.economy.ledger!) {
    object(entry);
    number(entry.at, 0, w.time);
    check(LEDGER_CATEGORIES.includes(entry.category), "ledger category");
    number(entry.amount, -1e12);
    const credit = ["opening", "fare", "grant", "loan", "refund"].includes(
      entry.category,
    );
    check(credit ? entry.amount > 0 : entry.amount < 0, "ledger sign");
  }
  object(w.economy.totals);
  object(w.economy.upkeepAccrued);
  for (const [category, value] of Object.entries(w.economy.upkeepAccrued!)) {
    check(
      [
        "track-upkeep",
        "platform-upkeep",
        "parking-upkeep",
        "pod-upkeep",
      ].includes(category),
      "upkeep category",
    );
    number(value, 0, 0.011);
  }
  for (const [category, value] of Object.entries(w.economy.totals!)) {
    check(
      (LEDGER_CATEGORIES as readonly string[]).includes(category),
      "totals category",
    );
    number(value);
  }
  for (const field of ["runningAccrued", "distanceKm"] as const) {
    object(w.economy[field]);
    number(w.economy[field]!.loaded);
    number(w.economy[field]!.empty);
  }
  if (w.economy.loan !== null) {
    const loan = w.economy.loan;
    object(loan);
    check(loan!.principal === LOAN_AMOUNT, "loan principal");
    check(
      loan!.installment === LOAN_AMOUNT / LOAN_TERM_DAYS,
      "loan installment",
    );
    number(loan!.remaining, 0.01, LOAN_AMOUNT);
    number(loan!.arrears, 0, loan!.remaining);
    number(loan!.nextPaymentAt, w.time, w.time + CITY_DAY_SECONDS);
    check(w.economy.grantsClaimed === GOVERNMENT_GRANTS, "loan before grants");
  }
  for (const key of [
    "income",
    "maintenance",
    "subsidy",
    "spent",
    "nextGrantAt",
    "lastMaintenanceAt",
  ] as const)
    number(w.economy[key]);
  object(w.metrics);
  if (w.metrics.trackTraffic === undefined)
    w.metrics.trackTraffic = { since: w.time, totals: {}, buckets: [] };
  const traffic = w.metrics.trackTraffic;
  object(traffic);
  number(traffic.since, 0, w.time);
  const trafficIds = new Set(w.tracks.map((t) => t.id));
  const validateCounts = (counts: Record<string, number>) => {
    object(counts);
    check(Object.keys(counts).length <= 12000, "traffic size");
    for (const [id, count] of Object.entries(counts)) {
      check(trafficIds.has(id), "traffic track");
      number(count, 0, Number.MAX_SAFE_INTEGER);
      check(Number.isInteger(count), "traffic count");
    }
  };
  validateCounts(traffic.totals);
  array(traffic.buckets, 60);
  const trafficMinutes = new Set<number>();
  const recentCounts: Record<string, number> = {};
  for (const bucket of traffic.buckets) {
    object(bucket);
    number(bucket.minute, 0, Math.floor(w.time / 60));
    check(
      Number.isInteger(bucket.minute) && !trafficMinutes.has(bucket.minute),
      "traffic minute",
    );
    trafficMinutes.add(bucket.minute);
    validateCounts(bucket.counts);
    for (const [id, count] of Object.entries(bucket.counts)) {
      recentCounts[id] = (recentCounts[id] ?? 0) + count;
      check(recentCounts[id] <= (traffic.totals[id] ?? 0), "traffic total");
    }
  }
  number(w.metrics.served);
  number(w.metrics.walked);
  number(w.metrics.savedSeconds, -1e12);
  number(w.metrics.totalWait);
  array(w.metrics.recentTrips, 160);
  for (const t of w.metrics.recentTrips) {
    check(
      residentIds.has(t.residentId) &&
        buildingIds.has(t.originId) &&
        buildingIds.has(t.destinationId) &&
        ["walk", "pod"].includes(t.mode),
      "trip history",
    );
    number(t.startedAt, 0, w.time);
    number(t.endedAt, t.startedAt, w.time);
    number(t.walkBaseline);
    number(t.waited);
    if (t.distanceKm !== undefined) number(t.distanceKm);
    if (t.farePerKm !== undefined)
      number(t.farePerKm, MIN_FARE_PER_KM, MAX_FARE_PER_KM);
    if (t.fare !== undefined) number(t.fare);
  }
  object(w.growth);
  number(w.growth.wave, 0, 1_000_000);
  check(Number.isInteger(w.growth.wave), "growth wave");
  check(w.growth.model === undefined || w.growth.model === 2, "growth model");
  check(
    w.growth.nextKind === undefined ||
      ["expansion", "infill"].includes(w.growth.nextKind),
    "growth kind",
  );
  check(
    w.growth.limited === undefined ||
      ["space", "population", "buildings"].includes(w.growth.limited),
    "growth limit",
  );
  number(w.growth.nextAt);
  check(
    typeof w.growth.enabled === "boolean" &&
      typeof w.growth.complete === "boolean" &&
      typeof w.growth.announced === "boolean",
    "growth state",
  );
  for (const n of w.notices) {
    number(n.id);
    number(n.time, 0, w.time);
    string(n.text);
    string(n.textEn);
    check(["info", "success", "warning"].includes(n.kind), "notice");
  }
  const pendingIds = new Set<string>();
  for (const e of w.pendingEdits) {
    check(
      ["remove-track", "remove-berth", "move-berth", "upgrade-track"].includes(
        e.type,
      ),
      "pending edit",
    );
    string(e.id);
    check(!pendingIds.has(e.id), "duplicate pending edit");
    pendingIds.add(e.id);
    if (e.type === "move-berth")
      check(
        ["north", "east", "south", "west"].includes(e.side),
        "edit direction",
      );
    if (e.type === "upgrade-track") {
      const track = w.tracks.find((t) => t.id === e.id);
      const currentLanes = track?.lanes ?? 1;
      const targetLanes = e.targetLanes ?? 2;
      check(
        track &&
          (e.targetLanes === undefined ||
            e.targetLanes === 2 ||
            e.targetLanes === 3) &&
          targetLanes > currentLanes,
        "upgrade target",
      );
      number(e.paid);
      check(
        Math.abs(
          e.paid -
            TRACK_UPGRADE_COST *
              distance(track!.a, track!.b) *
              (targetLanes - currentLanes),
        ) < 1e-6,
        "upgrade ledger",
      );
    }
  }
  initializeCityGrowth(w);
  w.paused = true;
  return w;
}

export function saveLocal(world: World): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(SAVE_KEY, serializeWorld(world));
    return true;
  } catch {
    return false;
  }
}
export function loadLocal(): World | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? parseWorld(raw) : null;
  } catch {
    return null;
  }
}
