/** Game currency, physical km and city seconds. No changes to movement speed. */
export const INITIAL_CASH = 2600;
export const DEFAULT_FARE_PER_KM = 18;
export const MIN_FARE_PER_KM = 2;
export const MAX_FARE_PER_KM = 60;
export const GOVERNMENT_GRANTS = 3;
export const GOVERNMENT_GRANT_AMOUNT = 1200;
export const LOAN_AMOUNT = 5000;
export const LOAN_TERM_DAYS = 5;
// Compressed game financing, not a real-world daily APR: five instalments cost
// 300 interest on 5,000 principal when paid on time (6% over the whole term).
export const LOAN_DAILY_RATE = 0.02;
export const CITY_DAY_SECONDS = 86400;
export const TRACK_UPKEEP_PER_LANE_KM_DAY = 240;
export const PLATFORM_UPKEEP_PER_DAY = 48;
export const PARKING_UPKEEP_PER_DAY = 12;
export const POD_UPKEEP_PER_DAY = 120;
export const POD_RUNNING_PER_KM = 2.4;
export const LEDGER_LIMIT = 300;
export const LEDGER_CATEGORIES = [
  "opening",
  "fare",
  "grant",
  "loan",
  "repayment",
  "interest",
  "track-build",
  "platform-build",
  "parking-build",
  "pod-buy",
  "refund",
  "track-upkeep",
  "platform-upkeep",
  "parking-upkeep",
  "pod-upkeep",
  "loaded-running",
  "empty-running",
] as const;
