export interface Point {
  x: number;
  y: number;
}
export type Language = "zh" | "en";
export type BuildingKind =
  | "home"
  | "office"
  | "shop"
  | "school"
  | "hospital"
  | "restaurant"
  | "park";
export type Side = "north" | "east" | "south" | "west";
export interface BuildingDevelopment {
  /** Residents at home, jobs at offices, operating units at shops. */
  capacity: number;
  stage: 1 | 2 | 3;
  nextAt: number;
  district: number;
  layout: "organic" | "ordered";
  role: "local" | "employment" | "commercial";
  /** Offset of the office's recurring shift, in city seconds. */
  shift: number;
}
export interface Building {
  id: string;
  name: string;
  nameEn: string;
  kind: BuildingKind;
  x: number;
  y: number;
  w: number;
  h: number;
  bornAt: number;
  development?: BuildingDevelopment;
}
export interface Berth {
  id: string;
  /** Only attached passenger platforms have a building owner. */
  buildingId?: string;
  kind: "platform" | "parking";
  point: Point;
  access: Point;
  side: Side;
  paid: number;
}
export interface Track {
  id: string;
  a: Point;
  b: Point;
  paid: number;
  lanes?: 1 | 2 | 3;
}
export interface Walk {
  path: Point[];
  start: number;
  end: number;
}
export type Purpose =
  | "work"
  | "shop"
  | "visit"
  | "home"
  | "study"
  | "care"
  | "meal"
  | "leisure";
export type Occupation = "worker" | "student" | "teacher" | "medic" | "service";
export interface TravelDecision {
  at: number;
  destinationId?: string;
  mode: "walk" | "pod";
  walkSeconds: number;
  podSeconds?: number;
  waitSeconds?: number;
  rideSeconds?: number;
  distanceKm?: number;
  fare?: number;
  farePerKm: number;
  /** Stable personal preference plus one seeded draw per departure. */
  preferenceSeconds: number;
  reason:
    | "faster"
    | "short-walk"
    | "price"
    | "wait"
    | "preference"
    | "no-platform"
    | "disconnected"
    | "no-pod"
    | "wait-abandoned";
}
export type WaitReason =
  | "no-platform"
  | "disconnected"
  | "no-pod"
  | "platform-busy"
  | "track-busy"
  | "parking-full"
  | "awaiting-pickup";
export interface Journey {
  originId: string;
  destinationId: string;
  startedAt: number;
  walkBaseline: number;
  purpose: Purpose;
  mode: "walk" | "pod";
  stage: "direct" | "access" | "queue" | "onboard" | "egress";
  walk?: Walk;
  /** Egress route fixed when dispatch commits, just like an active walking path. */
  egressPath?: Point[];
  pickupId?: string;
  dropoffId?: string;
  podId?: string;
  eta?: number;
  waitReason?: WaitReason;
  waited?: number;
  /** Rate for this trip; no quote, surcharge or empty approach charge. */
  farePerKm?: number;
  distanceKm?: number;
}
export interface Resident {
  id: string;
  name: string;
  color: string;
  homeId: string;
  workId: string;
  favorites: string[];
  atBuildingId: string | null;
  nextDeparture: number;
  nextDestinationId: string;
  purpose: Purpose;
  status:
    | "inside"
    | "walking"
    | "waiting"
    | "boarding"
    | "riding"
    | "alighting";
  journey: Journey | null;
  fareSensitivity: number;
  trips: number;
  occupation?: Occupation;
  podPreference?: number;
  decision?: TravelDecision;
}
export interface Reservation {
  resource: string;
  start: number;
  end: number;
  ownerId: string;
}
export interface MotionSegment {
  from: Point;
  to: Point;
  start: number;
  end: number;
  kind: "move" | "node" | "boarding" | "alighting";
  stage: "empty" | "loaded" | "relocate";
  resources: string[];
}
export interface ServicePlan {
  id: string;
  podId: string;
  residentId: string | null;
  originBerthId: string;
  finalBerthId: string;
  pickupId?: string;
  dropoffId?: string;
  requestedAt: number;
  departure: number;
  pickupStart?: number;
  pickupEnd?: number;
  dropoffStart?: number;
  dropoffEnd?: number;
  end: number;
  /** One physical segment behind and ahead; absent means a legacy plan. */
  safetyBuffer?: 1;
  segments: MotionSegment[];
  reservations: Reservation[];
}
export interface Pod {
  id: string;
  berthId: string | null;
  parkedSince: number;
  plan: ServicePlan | null;
  trips: number;
  paid: number;
}
export interface TripRecord {
  residentId: string;
  originId: string;
  destinationId: string;
  mode: "walk" | "pod";
  startedAt: number;
  endedAt: number;
  walkBaseline: number;
  waited: number;
  distanceKm?: number;
  farePerKm?: number;
  fare?: number;
}
export type LedgerCategory =
  | "opening"
  | "fare"
  | "grant"
  | "loan"
  | "repayment"
  | "interest"
  | "track-build"
  | "platform-build"
  | "parking-build"
  | "pod-buy"
  | "refund"
  | "track-upkeep"
  | "platform-upkeep"
  | "parking-upkeep"
  | "pod-upkeep"
  | "loaded-running"
  | "empty-running";
export interface LedgerEntry {
  at: number;
  category: LedgerCategory;
  /** Signed cash movement, credits positive and debits negative. */
  amount: number;
}
export type UpkeepCategory =
  | "track-upkeep"
  | "platform-upkeep"
  | "parking-upkeep"
  | "pod-upkeep";
export interface Loan {
  principal: number;
  remaining: number;
  installment: number;
  nextPaymentAt: number;
  arrears: number;
}
export interface Economy {
  cash: number;
  income: number;
  maintenance: number;
  subsidy: number;
  spent: number;
  nextGrantAt: number;
  lastMaintenanceAt: number;
  /** Earned but not yet claimed. Optional for existing v1 saves. */
  pendingGrant?: number;
  pendingGrowthGrant?: number;
  model?: 2;
  farePerKm?: number;
  grantsClaimed?: number;
  ledger?: LedgerEntry[];
  totals?: Partial<Record<LedgerCategory, number>>;
  loan?: Loan | null;
  /** Operating distance costs accrued since last minute's bill. */
  runningAccrued?: { loaded: number; empty: number };
  upkeepAccrued?: Partial<Record<UpkeepCategory, number>>;
  distanceKm?: { loaded: number; empty: number };
}
export interface Metrics {
  trackTraffic?: {
    since: number;
    totals: Record<string, number>;
    buckets: { minute: number; counts: Record<string, number> }[];
  };
  served: number;
  walked: number;
  savedSeconds: number;
  totalWait: number;
  recentTrips: TripRecord[];
}
export interface Growth {
  wave: number;
  nextAt: number;
  announced: boolean;
  enabled: boolean;
  complete: boolean;
  /** Legacy finite-wave saves omit this and are upgraded without losing entities. */
  model?: 2;
  nextKind?: "expansion" | "infill";
  limited?: "space" | "population" | "buildings";
}
export interface Notice {
  id: number;
  time: number;
  text: string;
  textEn: string;
  kind: "info" | "success" | "warning";
}
export type PendingEdit =
  | { type: "remove-track"; id: string }
  | { type: "remove-berth"; id: string }
  | { type: "move-berth"; id: string; side: Side }
  | {
      type: "upgrade-track";
      id: string;
      paid: number;
      targetLanes?: 2 | 3;
    };
export interface World {
  /** Version 2 preserves running reservations across additive construction. */
  resourceModel?: 2;
  /** Existing through lanes remain continuous when a branch joins them. */
  throughCorridors?: { point: Point; from: Point; to: Point }[];
  version: 2;
  seed: number;
  rng: number;
  time: number;
  paused: boolean;
  speed: 1 | 2 | 4 | 8;
  width: number;
  height: number;
  nextId: number;
  networkVersion: number;
  buildings: Building[];
  berths: Berth[];
  tracks: Track[];
  residents: Resident[];
  pods: Pod[];
  reservations: Reservation[];
  economy: Economy;
  metrics: Metrics;
  growth: Growth;
  notices: Notice[];
  pendingEdits: PendingEdit[];
}
export type Command =
  | { type: "claim-grant" }
  | { type: "set-fare"; value: number }
  | { type: "take-loan" }
  | { type: "repay-loan" }
  | { type: "pause"; value: boolean }
  | { type: "toggle-pause" }
  | { type: "speed"; value: 1 | 2 | 4 | 8 }
  | { type: "build-track"; points: Point[] }
  | { type: "add-platform"; buildingId?: string; point?: Point; side: Side }
  | { type: "add-parking"; point: Point; side: Side }
  | { type: "add-parking"; nearPlatformId: string; side: Side }
  | { type: "add-berth"; buildingId: string; kind: Berth["kind"]; side: Side }
  | { type: "remove-track"; id: string }
  | { type: "remove-tracks"; ids: string[] }
  | { type: "upgrade-tracks"; ids: string[]; lanes?: 2 | 3 }
  | { type: "remove-berth"; id: string }
  | { type: "move-berth"; id: string; side: Side }
  | { type: "buy-pod"; berthId: string }
  | { type: "sell-pod"; id: string }
  | { type: "growth"; value: boolean }
  | { type: "cancel-edits" }
  | { type: "reset"; seed?: number };
export interface CommandResult {
  ok: boolean;
  message: string;
  messageEn: string;
}
export type Selection = {
  kind: "building" | "resident" | "pod" | "berth" | "track";
  id: string;
} | null;
export interface SelectionModifiers {
  additive?: boolean;
  range?: boolean;
  single?: boolean;
}
export type Tool = "view" | "edit";
export interface TrackDraft {
  edges: Track[];
  cost: number;
  error?: string;
  errorEn?: string;
}
export type PlanResult =
  | { ok: true; plan: ServicePlan }
  | { ok: false; reason: WaitReason };
export type WorkerInput =
  | { type: "command"; command: Command }
  | { type: "load"; world: World }
  | { type: "snapshot" };
export type WorkerOutput =
  | { type: "world"; world: World }
  | { type: "result"; result: CommandResult }
  | { type: "error"; message: string };
