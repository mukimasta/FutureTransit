/** Module contract. Simulation owns truth; UI/rendering consume serializable snapshots. */
export type Language = 'zh' | 'en';
export type Localized = { zh: string; en: string };
export type NodeKind = 'residential' | 'office' | 'university' | 'leisure' | 'junction';
export interface CityNode {
  id: string;
  name: Localized;
  x: number;
  y: number;
  kind: NodeKind;
  district: 'north' | 'central' | 'campus';
  population: number;
}
export type PortSide = 'north' | 'east' | 'south' | 'west';
export interface TrackPoint {
  x: number;
  y: number;
  nodeId?: string;
  edgeId?: string;
}
export interface NodeView extends CityNode {
  portBuilt: boolean;
  portX: number;
  portY: number;
  queue: number;
  served: number;
  portLevel: number;
  connected: boolean;
  growth: number;
}
export interface EdgeView {
  id: string;
  from: string;
  to: string;
  length: number;
  cost: number;
  travelTime: number;
  level: number;
  utilization: number;
  trips: number;
}
export type PodStatus = 'idle' | 'waiting' | 'empty' | 'occupied';
export interface PodView {
  id: number;
  x: number;
  y: number;
  angle: number;
  status: PodStatus;
  at: string;
  destination?: string;
}
export interface Metrics {
  served: number;
  waiting: number;
  abandoned: number;
  totalDemand: number;
  marketShare: number;
  averageWait: number;
  p95Wait: number;
  revenue: number;
  expenses: number;
  emptyTrips: number;
  satisfaction: number;
  connectedBuildings: number;
}
export interface Mission {
  id: string;
  title: Localized;
  description: Localized;
  progress: number;
  target: number;
  reward: number;
  completed: boolean;
}
export interface Notice {
  id: number;
  time: number;
  title: Localized;
  text: Localized;
  tone: 'info' | 'success' | 'warning';
}
export interface HistoryPoint {
  time: number;
  served: number;
  waiting: number;
  share: number;
}
export interface DemandFlow {
  from: string;
  to: string;
  demand: number;
  waiting: number;
}
export interface CityEvent {
  active: boolean;
  remaining: number;
  nextIn: number;
  title: Localized;
  description: Localized;
}
export interface Snapshot {
  version: 1;
  revision: number;
  simTime: number;
  running: boolean;
  speed: 1 | 3 | 8;
  cash: number;
  fare: number;
  serviceOpen: boolean;
  nodes: NodeView[];
  edges: EdgeView[];
  pods: PodView[];
  metrics: Metrics;
  missions: Mission[];
  notices: Notice[];
  history: HistoryPoint[];
  cityEvent: CityEvent;
  demandFlows: DemandFlow[];
}
export type Command =
  | { type: 'addPort'; nodeId: string; side: PortSide }
  | { type: 'addJunction'; x: number; y: number }
  | { type: 'drawTrack'; points: TrackPoint[] }
  | { type: 'removeEdge'; edgeId: string }
  | { type: 'build'; from: string; to: string }
  | { type: 'upgradePort'; nodeId: string }
  | { type: 'upgradeEdge'; edgeId: string }
  | { type: 'buyPods'; nodeId: string; count: number }
  | { type: 'setFare'; value: number }
  | { type: 'setRunning'; value: boolean }
  | { type: 'setSpeed'; value: 1 | 3 | 8 }
  | { type: 'openService' }
  | { type: 'closeService' }
  | { type: 'startEvent' };
export interface CommandResult {
  ok: boolean;
  message?: Localized;
}
export type WorkerRequest =
  | { type: 'command'; id: number; command: Command }
  | { type: 'save'; id: number }
  | { type: 'load'; id: number; data: string }
  | { type: 'reset'; id: number }
  | { type: 'init' };
export type WorkerResponse =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'result'; id: number; result: CommandResult }
  | { type: 'saved'; id: number; data: string }
  | { type: 'error'; id?: number; message: Localized };
export type MapTool = 'select' | 'build' | 'junction';
export type Overlay = 'network' | 'demand' | 'traffic';
export interface MapState {
  snapshot: Snapshot;
  language: Language;
  tool: MapTool;
  overlay: Overlay;
  selectedNode: string | null;
  selectedEdge: string | null;
  buildFrom: string | null;
  draft?: TrackPoint[];
}
export interface MapCallbacks {
  onNodeClick(id: string): void;
  onEdgeClick(id: string, point?: { x: number; y: number }): void;
  onBackgroundClick(point?: { x: number; y: number }): void;
  onHoverNode?(id: string | null): void;
}
export interface MapRenderer {
  update(state: MapState): void;
  resize(): void;
  resetCamera(): void;
  zoomBy(factor: number): void;
  destroy(): void;
}
