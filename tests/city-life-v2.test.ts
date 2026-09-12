import { describe, expect, it } from "vitest";
import { updateGrowth } from "../src/city";
import {
  chooseTravelMode,
  createResidents,
  planNextActivity,
} from "../src/population";
import { assignmentCapacity, jobCounts } from "../src/shared/development";
import type { Building, BuildingKind, World } from "../src/shared/types";
import { createWorld } from "../src/simulation";

function civicBuilding(
  kind: Exclude<BuildingKind, "home" | "office" | "shop">,
  index: number,
): Building {
  return {
    id: `civic-${kind}`,
    name: kind,
    nameEn: kind,
    kind,
    x: 4 + index * 9,
    y: 34,
    w: kind === "park" ? 6 : 4,
    h: 4,
    bornAt: 0,
    development: {
      capacity: kind === "restaurant" ? 36 : 72,
      stage: 3,
      nextAt: 0,
      district: 1,
      layout: "ordered",
      role: kind === "restaurant" ? "commercial" : "local",
      shift: 0,
    },
  };
}

describe("city life v2", () => {
  it("keeps the three-building, 24-person start and adds every civic type early", () => {
    const world = createWorld(812);
    expect(world.buildings).toHaveLength(3);
    expect(world.residents).toHaveLength(24);

    for (let event = 0; event < 2; event += 1) {
      world.time = world.growth.nextAt;
      updateGrowth(world);
    }

    const kinds = new Set(world.buildings.map((building) => building.kind));
    for (const kind of ["school", "hospital", "restaurant", "park"] as const)
      expect(kinds.has(kind)).toBe(true);
    expect(world.economy.pendingGrowthGrant).toBeUndefined();
  });

  it("assigns durable roles only to real places and never exceeds their finite capacity", () => {
    const world = createWorld(918);
    world.buildings.push(
      civicBuilding("school", 0),
      civicBuilding("hospital", 1),
      civicBuilding("restaurant", 2),
      civicBuilding("park", 3),
    );
    const home = world.buildings.find((building) => building.kind === "home")!;
    const newcomers = createResidents(world, home, 30);
    world.residents.push(...newcomers);

    expect(
      newcomers.some((resident) => resident.occupation === "student"),
    ).toBe(true);
    expect(
      newcomers.some((resident) => resident.occupation === "teacher"),
    ).toBe(true);
    const counts = jobCounts(world);
    for (const [buildingId, assigned] of counts) {
      const building = world.buildings.find((item) => item.id === buildingId)!;
      expect(assigned).toBeLessThanOrEqual(assignmentCapacity(building));
    }
  });

  it("uses local time for school, hospital, meals, care and park demand without inventing people", () => {
    const world = createWorld(1701);
    world.buildings.push(
      civicBuilding("school", 0),
      civicBuilding("hospital", 1),
      civicBuilding("restaurant", 2),
      civicBuilding("park", 3),
    );
    const school = world.buildings.find(
      (building) => building.kind === "school",
    )!;
    const hospital = world.buildings.find(
      (building) => building.kind === "hospital",
    )!;
    const student = world.residents[0]!;
    student.occupation = "student";
    student.workId = school.id;
    student.atBuildingId = school.id;
    student.nextDeparture = 0;
    student.purpose = "study";
    world.time = 3600; // 08:00 local
    planNextActivity(world, student);
    expect(student.nextDestinationId).toBe(student.homeId);
    expect(student.nextDeparture).toBeGreaterThanOrEqual(7.5 * 3600);

    const medic = world.residents[1]!;
    medic.occupation = "medic";
    medic.workId = hospital.id;
    medic.atBuildingId = hospital.id;
    medic.nextDeparture = world.time;
    medic.purpose = "work";
    planNextActivity(world, medic);
    expect(medic.nextDestinationId).toBe(medic.homeId);
    expect(medic.nextDeparture).toBeGreaterThan(world.time + 7 * 3600);

    world.time = 5 * 3600; // 12:00 local
    const beforeIds = world.residents.map((resident) => resident.id);
    const beforeTrips = world.residents.map((resident) => resident.trips);
    for (const resident of world.residents.slice(2)) {
      resident.atBuildingId = resident.homeId;
      resident.nextDestinationId = resident.homeId;
      resident.nextDeparture = world.time;
      resident.purpose = "home";
      resident.journey = null;
      planNextActivity(world, resident);
    }
    const purposes = new Set(
      world.residents.map((resident) => resident.purpose),
    );
    expect(purposes.has("meal")).toBe(true);
    expect(purposes.has("care") || purposes.has("leisure")).toBe(true);
    expect(world.residents.map((resident) => resident.id)).toEqual(beforeIds);
    expect(world.residents.map((resident) => resident.trips)).toEqual(
      beforeTrips,
    );
  });

  it("keeps ordinary residents home overnight and staggers the next morning", () => {
    const world = createWorld(99);
    world.time = 17 * 3600; // midnight local
    for (const resident of world.residents) {
      resident.atBuildingId = resident.homeId;
      resident.nextDeparture = world.time;
      resident.nextDestinationId = resident.homeId;
      resident.purpose = "home";
      planNextActivity(world, resident);
    }
    expect(
      world.residents.every((resident) => resident.purpose === "home"),
    ).toBe(true);
    expect(
      world.residents.every(
        (resident) => resident.nextDestinationId === resident.homeId,
      ),
    ).toBe(true);
    expect(
      world.residents.every((resident) => resident.nextDeparture > world.time),
    ).toBe(true);
    expect(
      new Set(world.residents.map((resident) => resident.nextDeparture)).size,
    ).toBeGreaterThan(8);
  });

  it("reconsiders an idle daytime home within an hour, but not every tick", () => {
    const world = createWorld(101);
    world.buildings = world.buildings.filter(
      (building) => building.kind === "home" || building.kind === "office",
    );
    world.time = 3 * 3600; // 10:00 local, after the work-start window
    const resident = world.residents[0]!;
    resident.atBuildingId = resident.homeId;
    resident.nextDestinationId = resident.homeId;
    resident.nextDeparture = world.time;
    resident.purpose = "home";
    resident.favorites = [];

    planNextActivity(world, resident);
    const reconsiderAt = resident.nextDeparture;
    expect(resident.nextDestinationId).toBe(resident.homeId);
    expect(reconsiderAt).toBeGreaterThanOrEqual(world.time + 30 * 60);
    expect(reconsiderAt).toBeLessThanOrEqual(world.time + 60 * 60);
    planNextActivity(world, resident);
    expect(resident.nextDeparture).toBe(reconsiderAt);
  });

  it("keeps the compatibility mode comparison tied to distance and current fare", () => {
    const world = createWorld(102);
    const resident = world.residents[0]!;
    resident.fareSensitivity = 10;
    world.economy.farePerKm = 60;
    expect(chooseTravelMode(world, resident, 600, 100, 1)).toBe("walk");
    world.economy.farePerKm = 2;
    expect(chooseTravelMode(world, resident, 600, 100, 1)).toBe("pod");
  });
});
