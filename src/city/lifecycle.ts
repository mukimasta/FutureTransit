import { MAX_BUILDINGS, MAX_RESIDENTS } from "../shared/constants";
import {
  activeCapacity,
  assignmentCapacity,
  availableJobSlots,
  buildingCapacity,
} from "../shared/development";
import { id, random } from "../shared/math";
import { createResidents } from "../population";
import type {
  Building,
  BuildingDevelopment,
  BuildingKind,
  Notice,
  World,
} from "../shared/types";
import { planGrowthLayout } from "./layout";

const GROWTH_INTERVAL_MIN = 3600;
const GROWTH_INTERVAL_RANGE = 1200;
const GROWTH_WARNING_SECONDS = 600;
const DEVELOPMENT_INTERVAL_MIN = 5400;
const DEVELOPMENT_INTERVAL_RANGE = 3600;

const lifecycleWake = new WeakMap<World, number>();

const BUILDING_NAMES: Record<BuildingKind, readonly [string, string][]> = {
  home: [
    ["栖云居", "Cloud Court"],
    ["晚风里", "Evening Homes"],
    ["青木居", "Juniper House"],
    ["澄光里", "Clearview Homes"],
    ["河湾住区", "Riverbend Homes"],
    ["山影公寓", "Hillshade Apartments"],
  ],
  office: [
    ["远景事务所", "Horizon Works"],
    ["北窗工坊", "North Window"],
    ["林间事务所", "Grove Studio"],
    ["星港办公室", "Starport Offices"],
    ["新桥中心", "Newbridge Center"],
    ["南岸工场", "Southbank Works"],
  ],
  shop: [
    ["微光商店", "Little Lantern"],
    ["晴日市集", "Sunlit Market"],
    ["巷口杂货", "Lane Goods"],
    ["纸月商店", "Paper Moon"],
    ["桥边市集", "Bridge Market"],
    ["南街商场", "South Street Shops"],
  ],
  school: [
    ["青岚学园", "Blue Hill School"],
    ["河湾学校", "Riverbend School"],
    ["新桥书院", "Newbridge Academy"],
    ["星野学园", "Starfield School"],
  ],
  hospital: [
    ["安澜医院", "Harbor Hospital"],
    ["青木诊疗中心", "Juniper Medical Center"],
    ["新桥医院", "Newbridge Hospital"],
    ["南岸健康中心", "Southbank Health Center"],
  ],
  restaurant: [
    ["小满餐厅", "Little Harvest"],
    ["晴川食堂", "Clearwater Kitchen"],
    ["晚风餐馆", "Evening Table"],
    ["桥边饭店", "Bridge Café"],
  ],
  park: [
    ["青风公园", "Green Breeze Park"],
    ["河湾公园", "Riverbend Park"],
    ["星野花园", "Starfield Garden"],
    ["南岸绿地", "Southbank Green"],
  ],
};

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

function nextGrowthAt(world: World): number {
  return (
    world.time +
    GROWTH_INTERVAL_MIN +
    Math.floor(random(world) * (GROWTH_INTERVAL_RANGE + 1))
  );
}

function nextDevelopmentAt(world: World): number {
  return (
    world.time +
    DEVELOPMENT_INTERVAL_MIN +
    Math.floor(random(world) * (DEVELOPMENT_INTERVAL_RANGE + 1))
  );
}

function baseCapacity(building: Pick<Building, "kind" | "w" | "h">) {
  const area = building.w * building.h;
  switch (building.kind) {
    case "office":
      return Math.max(96, area * 5);
    case "school":
      return Math.max(72, area * 4);
    case "hospital":
      return Math.max(60, area * 4);
    case "restaurant":
      return Math.max(28, area * 2);
    case "park":
      return Math.max(40, area * 3);
    case "shop":
      return Math.max(24, area * 2);
    case "home":
      return Math.max(36, area * 3);
  }
}

function roleFor(
  kind: BuildingKind,
  district: number,
): BuildingDevelopment["role"] {
  if (kind === "office" && (district <= 2 || district % 3 === 0))
    return "employment";
  if (kind === "shop" && (district <= 2 || district % 4 === 0))
    return "commercial";
  if (kind === "restaurant" && (district <= 2 || district % 4 === 0))
    return "commercial";
  return "local";
}

function developmentFor(
  world: World,
  building: Pick<Building, "kind" | "w" | "h">,
  district: number,
  layout: BuildingDevelopment["layout"],
): BuildingDevelopment {
  return {
    capacity: Math.min(MAX_RESIDENTS, baseCapacity(building)),
    stage: 1,
    nextAt: nextDevelopmentAt(world),
    district,
    layout,
    role: roleFor(building.kind, district),
    shift: (district * 2700 + Math.floor(random(world) * 1200)) % (3 * 3600),
  };
}

function nameFor(world: World, kind: BuildingKind): [string, string] {
  const index = world.buildings.filter(
    (building) => building.kind === kind,
  ).length;
  const chosen = BUILDING_NAMES[kind][index % BUILDING_NAMES[kind].length]!;
  if (world.buildings.some((building) => building.name === chosen[0]))
    return [`${chosen[0]}·${index + 1}`, `${chosen[1]} ${index + 1}`];
  return [...chosen];
}

function assignedCount(world: World, building: Building): number {
  if (building.kind === "home")
    return world.residents.filter((resident) => resident.homeId === building.id)
      .length;
  if (building.kind === "office")
    return world.residents.filter((resident) => resident.workId === building.id)
      .length;
  if (
    building.kind === "school" ||
    building.kind === "hospital" ||
    building.kind === "shop" ||
    building.kind === "restaurant"
  )
    return world.residents.filter((resident) => resident.workId === building.id)
      .length;
  return 0;
}

function updateLifecycleWake(world: World): void {
  const next = world.buildings.reduce(
    (earliest, building) =>
      building.development && building.development.stage < 3
        ? Math.min(earliest, building.development.nextAt)
        : earliest,
    Number.POSITIVE_INFINITY,
  );
  lifecycleWake.set(world, next);
}

/**
 * Adds v2 development state to old saves without moving or reassigning any
 * entity. Legacy finite-wave completion becomes a future continuous event.
 */
export function initializeCityGrowth(world: World): void {
  const legacy = world.growth.model !== 2;
  const missingDevelopment = world.buildings.some(
    (building) => !building.development,
  );
  world.growth.complete = false;
  if (!legacy && !missingDevelopment) {
    if (!lifecycleWake.has(world)) updateLifecycleWake(world);
    return;
  }
  let addedDevelopment = false;
  const bornTimes = [
    ...new Set(world.buildings.map((building) => building.bornAt)),
  ].sort((a, b) => a - b);
  let officeIndex = 0;
  let shopIndex = 0;
  world.buildings.forEach((building, index) => {
    if (!building.development) {
      addedDevelopment = true;
      const assigned = assignedCount(world, building);
      const district = Math.max(0, bornTimes.indexOf(building.bornAt));
      const layout = district % 4 === 0 ? "ordered" : "organic";
      const capacity = Math.max(baseCapacity(building), assigned * 2, assigned);
      const role =
        building.kind === "office"
          ? building.id === "b-office" || officeIndex++ % 4 === 0
            ? "employment"
            : "local"
          : building.kind === "shop" || building.kind === "restaurant"
            ? building.id === "b-shop" || shopIndex++ % 4 === 0
              ? "commercial"
              : "local"
            : "local";
      building.development = {
        capacity: Math.min(MAX_RESIDENTS, capacity),
        stage: 1,
        nextAt:
          world.time +
          DEVELOPMENT_INTERVAL_MIN +
          ((index * 977 + world.seed) % (DEVELOPMENT_INTERVAL_RANGE + 1)),
        district,
        layout,
        role,
        shift: (district * 2700 + index * 643) % (3 * 3600),
      };
    }
  });

  world.growth.model = 2;
  world.growth.nextKind ??= "expansion";
  if (legacy) {
    world.growth.announced = false;
    // Always leave enough time for the 600-second advance warning.
    world.growth.nextAt =
      world.time + GROWTH_WARNING_SECONDS + 300 + (world.seed % 301);
    delete world.growth.limited;
  }
  if (legacy || addedDevelopment || !lifecycleWake.has(world))
    updateLifecycleWake(world);
}

export function initialBuildings(): Building[] {
  return [
    {
      id: "b-home",
      name: "晨光里",
      nameEn: "Morning Court",
      kind: "home",
      x: 12,
      y: 18,
      w: 4,
      h: 4,
      bornAt: 0,
      development: {
        capacity: 48,
        stage: 1,
        nextAt: 6300,
        district: 0,
        layout: "ordered",
        role: "local",
        shift: 0,
      },
    },
    {
      id: "b-office",
      name: "远景事务所",
      nameEn: "Horizon Works",
      kind: "office",
      x: 40,
      y: 10,
      w: 5,
      h: 4,
      bornAt: 0,
      development: {
        capacity: 96,
        stage: 1,
        nextAt: 7200,
        district: 0,
        layout: "ordered",
        role: "employment",
        shift: 900,
      },
    },
    {
      id: "b-shop",
      name: "微光商店",
      nameEn: "Little Lantern",
      kind: "shop",
      x: 39,
      y: 29,
      w: 4,
      h: 4,
      bornAt: 0,
      development: {
        capacity: 32,
        stage: 1,
        nextAt: 8100,
        district: 0,
        layout: "ordered",
        role: "commercial",
        shift: 1800,
      },
    },
  ];
}

function admitToHome(world: World, home: Building): number {
  const target = activeCapacity(home);
  const assigned = assignedCount(world, home);
  const count = Math.min(
    Math.max(0, target - assigned),
    availableJobSlots(world),
    Math.max(0, MAX_RESIDENTS - world.residents.length),
  );
  if (count > 0) world.residents.push(...createResidents(world, home, count));
  return count;
}

function postponeDisabledGrowth(world: World): void {
  if (world.time >= world.growth.nextAt) {
    world.growth.nextAt = nextGrowthAt(world);
    world.growth.announced = false;
  }
  const wake = lifecycleWake.get(world) ?? Number.NEGATIVE_INFINITY;
  if (world.time < wake) return;
  for (const building of world.buildings)
    if (
      building.development &&
      building.development.stage < 3 &&
      building.development.nextAt <= world.time
    )
      building.development.nextAt = nextDevelopmentAt(world);
  updateLifecycleWake(world);
}

function advanceOneBuilding(world: World): boolean {
  const wake = lifecycleWake.get(world) ?? Number.NEGATIVE_INFINITY;
  if (world.time < wake) return false;
  const building = world.buildings
    .filter(
      (candidate) =>
        candidate.development &&
        candidate.development.stage < 3 &&
        candidate.development.nextAt <= world.time,
    )
    .sort(
      (a, b) =>
        a.development!.nextAt - b.development!.nextAt ||
        a.id.localeCompare(b.id),
    )[0];
  if (!building?.development) {
    updateLifecycleWake(world);
    return false;
  }

  if (building.kind === "home") {
    const filled = admitToHome(world, building);
    const assigned = assignedCount(world, building);
    if (assigned < activeCapacity(building)) {
      building.development.nextAt = nextDevelopmentAt(world);
      if (world.residents.length >= MAX_RESIDENTS)
        world.growth.limited = "population";
      updateLifecycleWake(world);
      if (filled > 0)
        notice(
          world,
          `${building.name} 第 ${building.development.stage} 阶段补充入住 ${filled} 人。`,
          `${building.nameEn} added ${filled} residents at stage ${building.development.stage}.`,
          "success",
        );
      return filled > 0;
    }
    const nextFraction = building.development.stage === 1 ? 0.75 : 1;
    const nextTarget = Math.floor(buildingCapacity(building) * nextFraction);
    const required = Math.max(0, nextTarget - assigned);
    if (
      required > availableJobSlots(world) ||
      required > MAX_RESIDENTS - world.residents.length
    ) {
      building.development.nextAt = nextDevelopmentAt(world);
      if (required > MAX_RESIDENTS - world.residents.length)
        world.growth.limited = "population";
      updateLifecycleWake(world);
      return false;
    }
  }

  const before = activeCapacity(building);
  building.development.stage = (building.development.stage + 1) as 2 | 3;
  const opened = Math.max(0, activeCapacity(building) - before);
  const residents = building.kind === "home" ? admitToHome(world, building) : 0;
  building.development.nextAt =
    building.development.stage < 3 ? nextDevelopmentAt(world) : 0;
  updateLifecycleWake(world);

  const change =
    building.kind === "home"
      ? `新增 ${residents} 位居民`
      : building.kind === "office"
        ? `开放 ${opened} 个岗位`
        : `新增 ${opened} 个营业单元`;
  const changeEn =
    building.kind === "home"
      ? `${residents} new residents`
      : building.kind === "office"
        ? `${opened} new jobs`
        : `${opened} new activity places`;
  notice(
    world,
    `${building.name} 进入第 ${building.development.stage} 阶段，${change}。`,
    `${building.nameEn} reached stage ${building.development.stage}: ${changeEn}.`,
    "success",
  );
  return true;
}

function buildOneEvent(world: World): void {
  if (world.buildings.length >= MAX_BUILDINGS) {
    world.growth.limited = "buildings";
    world.growth.announced = false;
    world.growth.nextAt = nextGrowthAt(world);
    return;
  }
  const event = world.growth.nextKind ?? "expansion";
  const plan = planGrowthLayout(
    world,
    event,
    MAX_BUILDINGS - world.buildings.length,
  );
  if (!plan) {
    world.growth.limited = "space";
    world.growth.nextKind = "expansion";
    world.growth.announced = false;
    world.growth.nextAt = nextGrowthAt(world);
    notice(
      world,
      "本轮选址受现有建筑、交通设施或步行通道限制，城市稍后重试。",
      "Existing buildings, transport, or walking routes blocked this site; the city will retry later.",
      "warning",
    );
    return;
  }

  world.width = plan.width;
  world.height = plan.height;
  let newResidents = 0;
  let newJobs = 0;
  const additions: Building[] = [];
  for (const footprint of plan.footprints) {
    const [name, nameEn] = nameFor(world, footprint.kind);
    const building: Building = {
      id: id(world, "b-"),
      name,
      nameEn,
      ...footprint,
      bornAt: world.time,
      development: developmentFor(
        world,
        footprint,
        footprint.district,
        footprint.layout,
      ),
    };
    additions.push(building);
    world.buildings.push(building);
  }
  for (const building of additions) {
    newJobs += assignmentCapacity(building);
    if (building.kind === "home") newResidents += admitToHome(world, building);
  }

  world.networkVersion += 1;
  world.growth.wave += 1;
  world.growth.nextKind = event === "expansion" ? "infill" : "expansion";
  world.growth.announced = false;
  world.growth.nextAt = nextGrowthAt(world);
  world.growth.complete = false;
  world.growth.limited =
    world.buildings.length >= MAX_BUILDINGS
      ? "buildings"
      : world.residents.length >= MAX_RESIDENTS
        ? "population"
        : undefined;
  updateLifecycleWake(world);

  const names = additions
    .slice(0, 2)
    .map((building) => building.name)
    .join("、");
  const districtLabel =
    additions.length > 2 ? `${names}等 ${additions.length} 栋建筑` : names;
  notice(
    world,
    `${districtLabel} 启用第 1 阶段：新增 ${newResidents} 位居民、开放 ${newJobs} 个岗位。`,
    `${additions.length} buildings opened at stage 1: ${newResidents} residents and ${newJobs} jobs.`,
    "success",
  );
}

/** Advances at most one external build event, plus one due building stage. */
export function updateGrowth(world: World): void {
  initializeCityGrowth(world);
  if (!world.growth.enabled) {
    postponeDisabledGrowth(world);
    return;
  }

  advanceOneBuilding(world);
  if (
    !world.growth.announced &&
    world.time >= world.growth.nextAt - GROWTH_WARNING_SECONDS
  ) {
    world.growth.announced = true;
    const expansion = (world.growth.nextKind ?? "expansion") === "expansion";
    notice(
      world,
      expansion
        ? "城市边缘已划定新街区，约十分钟后动工。"
        : "旧城区正在确认一处填充开发，约十分钟后动工。",
      expansion
        ? "A new edge district is marked out; construction starts in about ten city minutes."
        : "An old-city infill site is being cleared; construction starts in about ten city minutes.",
      "warning",
    );
  }
  if (world.time >= world.growth.nextAt) buildOneEvent(world);
}
