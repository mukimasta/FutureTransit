/** Local, reversible state for drawing a track before it is sent to the game. */
import { planTrack, type PlanningResult } from '../network';
import type { Snapshot, TrackPoint } from '../shared/types';

export type DraftStatus =
  | { kind: 'idle' }
  | { kind: 'collecting' }
  | { kind: 'valid'; plan: Extract<PlanningResult, { ok: true }> }
  | { kind: 'invalid'; message: { zh: string; en: string } };

export function pointForNode(snapshot: Snapshot, nodeId: string): TrackPoint | null {
  const node = snapshot.nodes.find((item) => item.id === nodeId);
  if (!node || (node.kind !== 'junction' && !node.portBuilt)) return null;
  return { x: node.portX, y: node.portY, nodeId };
}

export function draftStatus(snapshot: Snapshot, draft: TrackPoint[]): DraftStatus {
  if (!draft.length) return { kind: 'idle' };
  if (draft.length < 2) return { kind: 'collecting' };
  const plan = planTrack(snapshot.nodes, snapshot.edges, draft);
  return plan.ok ? { kind: 'valid', plan } : { kind: 'invalid', message: plan.message };
}

/** A save/load/reset may make a snapped target disappear. Never retain that intent. */
export function hasCurrentTopology(snapshot: Snapshot, draft: TrackPoint[]) {
  const nodes = new Set(snapshot.nodes.map((node) => node.id));
  const edges = new Set(snapshot.edges.map((edge) => edge.id));
  return draft.every(
    (point) =>
      (!point.nodeId || nodes.has(point.nodeId)) && (!point.edgeId || edges.has(point.edgeId)),
  );
}
