import type { World } from "../shared/types";

export type FlowMode = "demand" | "history" | "work";
export interface BuildingFlowRow {
  destinationId: string;
  walk: number;
  pod: number;
  planned: number;
  workers: number;
  residentIds: string[];
  total: number;
}
export interface BuildingFlow {
  originId: string;
  mode: FlowMode;
  rows: BuildingFlowRow[];
  total: number;
}

/** Intent is never mislabeled as a completed ride or a chosen transport mode. */
export function buildingFlow(
  world: World,
  buildingId: string,
  mode: FlowMode,
): BuildingFlow {
  const rows = new Map<string, BuildingFlowRow>();
  const add = (
    destinationId: string,
    residentId: string,
    kind: "walk" | "pod" | "planned" | "workers",
  ) => {
    if (
      destinationId === buildingId ||
      !world.buildings.some((b) => b.id === destinationId)
    )
      return;
    const row = rows.get(destinationId) ?? {
      destinationId,
      walk: 0,
      pod: 0,
      planned: 0,
      workers: 0,
      residentIds: [],
      total: 0,
    };
    row[kind]++;
    row.total++;
    if (!row.residentIds.includes(residentId)) row.residentIds.push(residentId);
    rows.set(destinationId, row);
  };
  if (mode === "history") {
    for (const trip of world.metrics.recentTrips)
      if (trip.originId === buildingId && trip.endedAt >= world.time - 1800)
        add(trip.destinationId, trip.residentId, trip.mode);
  } else if (mode === "work") {
    for (const r of world.residents)
      if (r.homeId === buildingId) add(r.workId, r.id, "workers");
  } else {
    for (const r of world.residents) {
      if (r.atBuildingId === buildingId)
        add(r.nextDestinationId, r.id, "planned");
      else if (r.journey?.originId === buildingId)
        add(r.journey.destinationId, r.id, r.journey.mode);
    }
  }
  const sorted = [...rows.values()].sort(
    (a, b) =>
      b.total - a.total || a.destinationId.localeCompare(b.destinationId),
  );
  return {
    originId: buildingId,
    mode,
    rows: sorted,
    total: sorted.reduce((n, r) => n + r.total, 0),
  };
}
