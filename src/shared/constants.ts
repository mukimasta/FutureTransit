// All travel time, fares, running costs and track upkeep use this physical scale.
export const CELL_METERS = 40;
export const WALK_METERS_PER_SECOND = 1.3;
export const POD_METERS_PER_SECOND = 8;
// One city minute takes two real seconds at 1x. Physics still
// advances in one-second steps and rendering interpolates between snapshots.
export const TIME_SCALE = 30;
export const BOARD_SECONDS = 9;
export const ALIGHT_SECONDS = 6;
export const NODE_SECONDS = 1;
export const CLEARANCE_SECONDS = 0.5;
export const TRACK_COST = 12;
export const TRACK_UPGRADE_COST = 10;
export const PLATFORM_COST = 140;
export const PARKING_COST = 55;
export const POD_COST = 240;
// Technical guardrails, not a four-wave victory/ending condition.
export const MAX_PODS = 160;
export const MAX_RESIDENTS = 1200;
export const MAX_BUILDINGS = 120;
export const MAX_MAP_SIZE = 256;
export const RESIDENT_COLORS = [
  "#347b74",
  "#c07753",
  "#7570a7",
  "#618fbb",
  "#a18445",
  "#b16884",
];
