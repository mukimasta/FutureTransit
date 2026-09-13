import type {
  Language,
  Point,
  Selection,
  SelectionModifiers,
  Tool,
  World,
} from "../shared/types";
import type { BuildingFlow } from "../insights";
import type { BuildKind, EditorContext, PlacementPreview } from "../ui/editor";

export type MapAction =
  | { type: "choose-build"; kind: BuildKind }
  | { type: "remove-berth"; id: string }
  | { type: "buy-pod"; berthId: string }
  | { type: "sell-pod"; id: string };

export interface MapViewProps {
  world: World;
  selection: Selection;
  onSelect: (
    selection: Selection,
    modifiers?: SelectionModifiers,
    point?: Point,
  ) => void;
  tool: Tool;
  draft: Point[];
  onMapPoint: (point: Point) => void;
  onEmptyPoint: (point: Point) => void;
  context: EditorContext | null;
  placing: boolean;
  placement: PlacementPreview | null;
  onPlacePoint: (point: Point) => void;
  onMapAction: (action: MapAction) => void;
  onHoverPoint: (point: Point | null) => void;
  candidateDraft: Point[];
  candidateInvalid: boolean;
  onFinishDraft: () => void;
  layer: "life" | "flow";
  trafficCounts: Record<string, number>;
  trafficMax: number;
  language: Language;
  focusTarget?: Selection;
  selectedTrackIds?: string[];
  buildingFlow?: BuildingFlow;
  resetViewToken?: number;
}
