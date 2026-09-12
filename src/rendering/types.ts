import type {
  Language,
  Point,
  Selection,
  SelectionModifiers,
  Tool,
  World,
} from "../shared/types";
import type { BuildingFlow } from "../insights";
export interface MapViewProps {
  world: World;
  selection: Selection;
  onSelect: (selection: Selection, modifiers?: SelectionModifiers) => void;
  tool: Tool;
  draft: Point[];
  onMapPoint: (point: Point) => void;
  onHoverPoint: (point: Point | null) => void;
  candidateDraft: Point[];
  candidateInvalid: boolean;
  onFinishDraft: () => void;
  layer: "life" | "flow";
  language: Language;
  focusTarget?: Selection;
  selectedTrackIds?: string[];
  buildingFlow?: BuildingFlow;
  resetViewToken?: number;
}
