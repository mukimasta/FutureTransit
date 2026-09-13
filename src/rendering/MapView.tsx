import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { buildingDoor, nodeKey, tracePolyline } from "../network";
import { trafficColor } from "../insights/traffic";
import { RenderClock } from "../shared/render-clock";
import { podPosition, residentPosition } from "../shared/selectors";
import type {
  Berth,
  Building,
  Point,
  Selection,
  ServicePlan,
  Track,
} from "../shared/types";
import type { MapAction, MapViewProps } from "./types";
import { separateLabels } from "./labels";
import { residentFocusPoint } from "./focus";

interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BUILDING_COLORS = {
  home: { fill: "#dce9dd", edge: "#86a88b" },
  office: { fill: "#dce8ef", edge: "#829fac" },
  shop: { fill: "#eadfcf", edge: "#ad9272" },
  school: { fill: "#e4e1f0", edge: "#9790b5" },
  hospital: { fill: "#e7eeee", edge: "#7f9fa0" },
  restaurant: { fill: "#eee0d6", edge: "#bd927a" },
  park: { fill: "#dce8d5", edge: "#8ea98a" },
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const sameSelection = (
  a: Selection | undefined,
  kind: NonNullable<Selection>["kind"],
  id: string,
) => a?.kind === kind && a.id === id;
const number = (value: number) => Number(value.toFixed(3));
const MapUnitsContext = createContext(1);

function MapActionButton({
  point,
  label,
  title,
  tone = "build",
  minWidth = 62,
  onAction,
}: {
  point: Point;
  label: string;
  title: string;
  tone?: "build" | "parking" | "danger";
  minWidth?: number;
  onAction: () => void;
}) {
  const units = useContext(MapUnitsContext);
  const width = Math.max(
    minWidth,
    22 +
      [...label].reduce(
        (sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 13 : 7),
        0,
      ),
  );
  return (
    <g
      className={`map-action ${tone}`}
      data-map-action={title}
      role="button"
      tabIndex={0}
      aria-label={title}
      transform={`translate(${point.x} ${point.y}) scale(${units})`}
      onClick={(event) => {
        event.stopPropagation();
        onAction();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        onAction();
      }}
    >
      <rect x={-width / 2} y="-18" width={width} height="36" rx="9" />
      <text y="0" textAnchor="middle" dominantBaseline="central">
        {label}
      </text>
      <title>{title}</title>
    </g>
  );
}

function baseView(width: number, height: number): ViewRect {
  return { x: -1.5, y: -1.5, width: width + 3, height: height + 3 };
}

function constrainView(view: ViewRect, base: ViewRect): ViewRect {
  const width = clamp(view.width, Math.min(14, base.width / 5), base.width);
  const height = clamp(
    view.height,
    (Math.min(14, base.width / 5) * base.height) / base.width,
    base.height,
  );
  return {
    x: clamp(view.x, base.x, base.x + base.width - width),
    y: clamp(view.y, base.y, base.y + base.height - height),
    width,
    height,
  };
}

function roundedPath(points: readonly Point[], radius = 0.28): string {
  if (!points.length) return "";
  if (points.length === 1)
    return `M ${number(points[0].x)} ${number(points[0].y)}`;
  let path = `M ${number(points[0].x)} ${number(points[0].y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incoming = Math.hypot(previous.x - current.x, previous.y - current.y);
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y);
    if (!incoming || !outgoing) continue;
    const corner = Math.min(radius, incoming * 0.32, outgoing * 0.32);
    const before = {
      x: current.x + ((previous.x - current.x) / incoming) * corner,
      y: current.y + ((previous.y - current.y) / incoming) * corner,
    };
    const after = {
      x: current.x + ((next.x - current.x) / outgoing) * corner,
      y: current.y + ((next.y - current.y) / outgoing) * corner,
    };
    path += ` L ${number(before.x)} ${number(before.y)} Q ${number(current.x)} ${number(current.y)} ${number(after.x)} ${number(after.y)}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${number(last.x)} ${number(last.y)}`;
}

/** Joins degree-two track nodes into quiet, rounded visual routes. */
function trackChains(tracks: readonly Track[]): Point[][] {
  const adjacency = new Map<string, { track: Track; other: Point }[]>();
  const points = new Map<string, Point>();
  for (const track of tracks) {
    const a = nodeKey(track.a);
    const b = nodeKey(track.b);
    points.set(a, track.a);
    points.set(b, track.b);
    adjacency.set(a, [...(adjacency.get(a) ?? []), { track, other: track.b }]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), { track, other: track.a }]);
  }

  const used = new Set<string>();
  const chains: Point[][] = [];
  const walk = (start: Point, first: Track): Point[] => {
    const chain: Point[] = [{ ...start }];
    let current = start;
    let edge = first;
    while (!used.has(edge.id)) {
      used.add(edge.id);
      const next = nodeKey(edge.a) === nodeKey(current) ? edge.b : edge.a;
      chain.push({ ...next });
      const choices = adjacency.get(nodeKey(next)) ?? [];
      if (choices.length !== 2) break;
      const following = choices.find(
        (candidate) => !used.has(candidate.track.id),
      );
      if (!following) break;
      current = next;
      edge = following.track;
    }
    return chain;
  };

  for (const [key, edges] of adjacency) {
    if (edges.length === 2) continue;
    for (const { track } of edges)
      if (!used.has(track.id)) chains.push(walk(points.get(key)!, track));
  }
  for (const track of tracks)
    if (!used.has(track.id)) chains.push(walk(track.a, track));
  return chains;
}

function planPath(plan: ServicePlan | null): Point[] {
  if (!plan?.segments.length) return [];
  return [plan.segments[0].from, ...plan.segments.map((segment) => segment.to)];
}

function buildingRect(building: Building) {
  return {
    x: building.x - 0.4,
    y: building.y - 0.4,
    width: building.w - 0.2,
    height: building.h - 0.2,
  };
}

/**
 * A waiting Resident's dot is a pure function of the world snapshot, so it is
 * only rebuilt when one of these values actually moves. Rush hour parks
 * hundreds of Residents in queues, and re-deriving every one of them sixty
 * times a second is what makes the map stop responding.
 */
const ResidentMarker = memo(function ResidentMarker({
  id,
  name,
  color,
  x,
  y,
  selected,
  focused,
  crosshair,
  onPick,
  onKey,
}: {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  selected: boolean;
  focused: boolean;
  crosshair: boolean;
  onPick: (
    event: React.MouseEvent<SVGElement>,
    next: NonNullable<Selection>,
  ) => void;
  onKey: (
    event: ReactKeyboardEvent<SVGGElement>,
    next: NonNullable<Selection>,
  ) => void;
}) {
  return (
    <g
      data-map-entity="resident"
      data-resident-id={id}
      role="button"
      tabIndex={0}
      aria-label={name}
      style={{ cursor: crosshair ? "crosshair" : "pointer" }}
      onClick={(event) => onPick(event, { kind: "resident", id })}
      onKeyDown={(event) => onKey(event, { kind: "resident", id })}
    >
      {(selected || focused) && (
        <circle
          cx={x}
          cy={y}
          r="0.42"
          fill="none"
          stroke={selected ? "#d7873f" : "#d19b58"}
          strokeWidth="0.12"
        />
      )}
      <circle
        cx={x}
        cy={y}
        r="0.2"
        fill={color}
        stroke="#fffdf7"
        strokeWidth="0.07"
      />
    </g>
  );
});

function shortName(name: string, language: MapViewProps["language"]): string {
  const limit = language === "zh" ? 6 : 15;
  return name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
}

function useDisplayTime(world: MapViewProps["world"]): number {
  const [clock] = useState(
    () =>
      new RenderClock(world.time, world.paused, world.speed, performance.now()),
  );
  const [time, setTime] = useState(world.time);
  const timelineRestarted = world.time < clock.authoritativeTime;

  useEffect(() => {
    setTime(
      clock.sync(world.time, world.paused, world.speed, performance.now()),
    );
  }, [clock, world.paused, world.speed, world.time]);

  useEffect(() => {
    let frame = 0;
    const draw = (now: number) => {
      setTime(clock.sample(now));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [clock]);

  // A lower authoritative time identifies reset/import synchronously, before
  // the effect has a chance to replace the presentation clock.
  return world.paused || timelineRestarted ? world.time : time;
}

export function MapView({
  world,
  selection,
  onSelect,
  tool,
  draft,
  onMapPoint,
  onEmptyPoint,
  context,
  placing,
  placement,
  onPlacePoint,
  onMapAction,
  onHoverPoint,
  candidateDraft,
  candidateInvalid,
  onFinishDraft,
  layer,
  trafficCounts,
  trafficMax,
  language,
  focusTarget,
  selectedTrackIds = [],
  buildingFlow: flows,
  resetViewToken,
}: MapViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    clientX: number;
    clientY: number;
    view: ViewRect;
    moved: boolean;
  } | null>(null);
  const ignoreClick = useRef(false);
  const followSuspended = useRef(false);
  const base = useMemo(
    () => baseView(world.width, world.height),
    [world.height, world.width],
  );
  const [view, setView] = useState<ViewRect>(base);
  const previousBase = useRef(base);
  const [svgWidth, setSvgWidth] = useState(800);
  const [svgHeight, setSvgHeight] = useState(600);
  const layingTrack = tool === "edit" && draft.length > 0;
  const mapUnits = Math.max(
    view.width / Math.max(1, svgWidth),
    view.height / Math.max(1, svgHeight),
  );
  const indoors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const resident of world.residents)
      if (resident.atBuildingId)
        counts.set(
          resident.atBuildingId,
          (counts.get(resident.atBuildingId) ?? 0) + 1,
        );
    return counts;
  }, [world.residents]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => {
      const bounds = svg.getBoundingClientRect();
      setSvgWidth(bounds.width);
      setSvgHeight(bounds.height);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const flowFont = Math.max(0.46, (view.width / Math.max(300, svgWidth)) * 9);
  const flowLabels = useMemo(
    () =>
      separateLabels(
        (flows?.rows ?? []).flatMap((row) => {
          const b = world.buildings.find((b) => b.id === row.destinationId);
          if (!b) return [];
          const label =
            flows?.mode === "work"
              ? language === "zh"
                ? `工作 · ${row.workers} 人`
                : `Work · ${row.workers}`
              : `${language === "zh" ? "步" : "Walk"} ${row.walk} · Pod ${row.pod}${row.planned ? ` · ${language === "zh" ? "待" : "Plan"} ${row.planned}` : ""}`;
          const height = flowFont * 1.7,
            width = Math.max(5, label.length * flowFont * 0.67 + 0.6),
            x = b.x + (b.w - 1) / 2,
            y = b.y - 0.65 - height / 2;
          return [
            { id: b.id, x, y, width, height, anchorY: b.y - 0.4, label, row },
          ];
        }),
      ),
    [flows, world.buildings, language, flowFont],
  );
  const displayTime = useDisplayTime(world);

  useEffect(() => {
    const old = previousBase.current;
    setView((current) => {
      const overview =
        Math.abs(current.width - old.width) < 0.01 &&
        Math.abs(current.height - old.height) < 0.01;
      return overview ? base : constrainView(current, base);
    });
    previousBase.current = base;
  }, [base]);
  useEffect(() => {
    followSuspended.current = true;
    setView(base);
  }, [resetViewToken]);

  const focusKey = focusTarget ? `${focusTarget.kind}:${focusTarget.id}` : "";
  useEffect(() => {
    if (!focusTarget) return;
    followSuspended.current = false;
    let point: Point | null = null;
    if (focusTarget.kind === "building") {
      const building = world.buildings.find(
        (item) => item.id === focusTarget.id,
      );
      if (building)
        point = {
          x: building.x + (building.w - 1) / 2,
          y: building.y + (building.h - 1) / 2,
        };
    } else if (focusTarget.kind === "berth") {
      point =
        world.berths.find((item) => item.id === focusTarget.id)?.point ?? null;
    } else if (focusTarget.kind === "track") {
      const track = world.tracks.find((item) => item.id === focusTarget.id);
      if (track)
        point = {
          x: (track.a.x + track.b.x) / 2,
          y: (track.a.y + track.b.y) / 2,
        };
    } else if (focusTarget.kind === "pod") {
      const pod = world.pods.find((item) => item.id === focusTarget.id);
      if (pod) point = podPosition(world, pod);
    } else {
      const resident = world.residents.find(
        (item) => item.id === focusTarget.id,
      );
      if (resident) point = residentFocusPoint(world, resident);
    }
    if (!point) return;
    const width = Math.min(30, base.width / 2.25);
    const height = (width * base.height) / base.width;
    setView(
      constrainView(
        { x: point.x - width / 2, y: point.y - height / 2, width, height },
        base,
      ),
    );
  }, [focusKey]);

  useEffect(() => {
    if (
      !focusTarget ||
      followSuspended.current ||
      !["pod", "resident"].includes(focusTarget.kind)
    )
      return;
    const pod = world.pods.find((p) => p.id === focusTarget.id);
    const resident = world.residents.find((r) => r.id === focusTarget.id);
    const point = pod
      ? podPosition(world, pod, displayTime)
      : resident
        ? residentFocusPoint(world, resident, displayTime)
        : null;
    if (point)
      setView((previous) =>
        constrainView(
          {
            ...previous,
            x: point.x - previous.width / 2,
            y: point.y - previous.height / 2,
          },
          base,
        ),
      );
  }, [displayTime, focusKey]);

  const screenPoint = (clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  };

  const snappedPoint = (event: {
    clientX: number;
    clientY: number;
  }): Point | null => {
    const point = screenPoint(event.clientX, event.clientY);
    if (!point) return null;
    return {
      x: clamp(Math.round(point.x), 0, world.width - 1),
      y: clamp(Math.round(point.y), 0, world.height - 1),
    };
  };

  const selectEntity = (
    event: ReactPointerEvent<SVGElement> | React.MouseEvent<SVGElement>,
    next: NonNullable<Selection>,
    mapPoint?: Point,
  ) => {
    event.stopPropagation();
    if (ignoreClick.current) {
      ignoreClick.current = false;
      return;
    }
    if (placing) {
      const point = snappedPoint(event);
      if (point) onPlacePoint(point);
      return;
    }
    if (layingTrack) {
      const point = mapPoint ?? snappedPoint(event);
      if (point) onMapPoint(point);
      return;
    }
    onSelect(
      next,
      {
        additive: event.metaKey || event.ctrlKey,
        range: event.shiftKey,
        single: event.altKey,
      },
      mapPoint ?? snappedPoint(event) ?? undefined,
    );
  };

  // Marker memoization needs handler identities that survive a frame; the
  // behaviour still comes from the current render's closure.
  const selectEntityRef = useRef(selectEntity);
  selectEntityRef.current = selectEntity;
  const pickEntity = useCallback(
    (event: React.MouseEvent<SVGElement>, next: NonNullable<Selection>) =>
      selectEntityRef.current(event, next),
    [],
  );

  const selectEntityByKeyboard = (
    event: ReactKeyboardEvent<SVGGElement>,
    next: NonNullable<Selection>,
    mapPoint?: Point,
  ) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (placing) return;
    if (layingTrack) {
      if (draft.length > 1 && event.key === "Enter") {
        onFinishDraft();
        return;
      }
      if (mapPoint) onMapPoint(mapPoint);
      return;
    }
    onSelect(
      next,
      {
        additive: event.metaKey || event.ctrlKey,
        range: event.shiftKey,
        single: event.altKey,
      },
      mapPoint,
    );
  };
  const keyEntityRef = useRef(selectEntityByKeyboard);
  keyEntityRef.current = selectEntityByKeyboard;
  const keyEntity = useCallback(
    (event: ReactKeyboardEvent<SVGGElement>, next: NonNullable<Selection>) =>
      keyEntityRef.current(event, next),
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      event.button !== 0 ||
      (tool === "edit" &&
        (event.target as Element).closest(
          "[data-map-entity], [data-map-action]",
        ))
    )
      return;
    drag.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      view,
      moved: false,
    };
    // In view mode, a short click still reaches the facility. Capture only
    // once it becomes a drag, otherwise the SVG would swallow selection.
    if (!(event.target as Element).closest("[data-map-entity]"))
      event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (placing && !drag.current?.moved) {
      onHoverPoint(snappedPoint(event));
    } else if (layingTrack && !drag.current?.moved) {
      const berthId = (event.target as Element)
        .closest("[data-berth-id]")
        ?.getAttribute("data-berth-id");
      const point =
        world.berths.find((berth) => berth.id === berthId)?.access ??
        snappedPoint(event);
      onHoverPoint(point);
    }
    if (!drag.current) return;
    const dx = event.clientX - drag.current.clientX;
    const dy = event.clientY - drag.current.clientY;
    if (Math.hypot(dx, dy) < 3 && !drag.current.moved) return;
    drag.current.moved = true;
    if (!event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.setPointerCapture(event.pointerId);
    followSuspended.current = true;
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = Math.max(
      drag.current.view.width / Math.max(1, bounds.width),
      drag.current.view.height / Math.max(1, bounds.height),
    );
    setView(
      constrainView(
        {
          ...drag.current.view,
          x: drag.current.view.x - dx * scale,
          y: drag.current.view.y - dy * scale,
        },
        base,
      ),
    );
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    ignoreClick.current = drag.current.moved;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onCanvasClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (ignoreClick.current) {
      ignoreClick.current = false;
      return;
    }
    if (tool === "view") {
      onSelect(null);
      return;
    }
    if (placing) {
      const point = snappedPoint(event);
      if (point) onPlacePoint(point);
      return;
    }
    if (layingTrack) {
      const point = snappedPoint(event);
      if (point) onMapPoint(point);
    } else {
      const point = snappedPoint(event);
      if (point) onEmptyPoint(point);
    }
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    followSuspended.current = true;
    const anchor = screenPoint(event.clientX, event.clientY);
    if (!anchor) return;
    const factor = Math.exp(event.deltaY * 0.0012);
    const nextWidth = clamp(
      view.width * factor,
      Math.min(14, base.width / 5),
      base.width,
    );
    const ratio = nextWidth / view.width;
    const nextHeight = view.height * ratio;
    setView(
      constrainView(
        {
          x: anchor.x - (anchor.x - view.x) * ratio,
          y: anchor.y - (anchor.y - view.y) * ratio,
          width: nextWidth,
          height: nextHeight,
        },
        base,
      ),
    );
  };

  const chains = useMemo(
    () => trackChains(world.tracks.filter((t) => (t.lanes ?? 1) === 1)),
    [world.tracks],
  );
  const dualChains = useMemo(
    () => trackChains(world.tracks.filter((t) => t.lanes === 2)),
    [world.tracks],
  );
  const tripleChains = useMemo(
    () => trackChains(world.tracks.filter((t) => t.lanes === 3)),
    [world.tracks],
  );
  const degrees = useMemo(() => {
    const result = new Map<string, { point: Point; degree: number }>();
    for (const track of world.tracks) {
      for (const point of [track.a, track.b]) {
        const key = nodeKey(point);
        result.set(key, { point, degree: (result.get(key)?.degree ?? 0) + 1 });
      }
    }
    return result;
  }, [world.tracks]);
  const residentsById = useMemo(
    () => new Map(world.residents.map((resident) => [resident.id, resident])),
    [world.residents],
  );
  // The Resident being followed and the building they stand in, resolved once
  // instead of once per building on every animation frame.
  const trackedEntity =
    focusTarget?.kind === "resident"
      ? residentsById.get(focusTarget.id)
      : undefined;
  const trackedBuildingId = trackedEntity?.atBuildingId;

  const highlightPath = (target: Selection | undefined): Point[] => {
    if (!target) return [];
    if (target.kind === "pod")
      return planPath(
        world.pods.find((item) => item.id === target.id)?.plan ?? null,
      );
    if (target.kind === "resident") {
      const resident = world.residents.find((item) => item.id === target.id);
      if (!resident?.journey) return [];
      const pod = resident.journey.podId
        ? world.pods.find((item) => item.id === resident.journey?.podId)
        : undefined;
      return pod?.plan
        ? planPath(pod.plan)
        : (resident.journey.walk?.path ?? []);
    }
    if (target.kind === "track") {
      const track = world.tracks.find((item) => item.id === target.id);
      return track ? [track.a, track.b] : [];
    }
    if (target.kind === "berth") {
      const berth = world.berths.find((item) => item.id === target.id);
      return berth ? [berth.point, berth.access] : [];
    }
    return [];
  };

  // Buildings only move with the world snapshot, never with the animation
  // clock, so the layer is rebuilt ten times a second rather than sixty.
  const buildingLayer = useMemo(
    () => (
      <g aria-label={language === "zh" ? "建筑" : "Buildings"}>
        {world.buildings.map((building) => {
          const rect = buildingRect(building);
          const colors = BUILDING_COLORS[building.kind];
          const selected = sameSelection(selection, "building", building.id);
          const trackedResident =
            trackedBuildingId === building.id ? trackedEntity : undefined;
          const focused =
            sameSelection(focusTarget, "building", building.id) ||
            !!trackedResident;
          const count = indoors.get(building.id) ?? 0;
          const development = building.development;
          const name = shortName(
            language === "zh" ? building.name : building.nameEn,
            language,
          );
          const centerX = building.x + (building.w - 1) / 2;
          const centerY = building.y + (building.h - 1) / 2;
          return (
            <g
              key={building.id}
              data-map-entity="building"
              data-building-id={building.id}
              data-development-stage={development?.stage}
              data-building-role={development?.role}
              data-tracked-resident={trackedResident?.id}
              role="button"
              tabIndex={0}
              aria-label={`${language === "zh" ? building.name : building.nameEn}, ${count}`}
              style={{ cursor: layingTrack ? "crosshair" : "pointer" }}
              onClick={(event) =>
                pickEntity(event, { kind: "building", id: building.id })
              }
              onKeyDown={(event) =>
                keyEntity(event, {
                  kind: "building",
                  id: building.id,
                })
              }
            >
              {(selected || focused) && (
                <rect
                  {...rect}
                  x={rect.x - 0.16}
                  y={rect.y - 0.16}
                  width={rect.width + 0.32}
                  height={rect.height + 0.32}
                  rx="0.5"
                  fill="none"
                  stroke={selected ? "#d7873f" : "#d19b58"}
                  strokeWidth={selected ? 0.2 : 0.12}
                  opacity={selected ? 1 : 0.65}
                />
              )}
              {building.kind === "park" ? (
                <g filter="url(#map-soft-shadow)" pointerEvents="none">
                  <rect
                    {...rect}
                    rx="1.05"
                    fill={colors.fill}
                    stroke={colors.edge}
                    strokeWidth="0.11"
                  />
                  {[-0.48, 0, 0.48].map((offset) => (
                    <circle
                      key={offset}
                      cx={centerX + offset}
                      cy={centerY - 0.18 + (offset === 0 ? 0.16 : 0)}
                      r="0.2"
                      fill="#a9c49e"
                      opacity="0.78"
                    />
                  ))}
                </g>
              ) : (
                <rect
                  {...rect}
                  rx="0.42"
                  fill={colors.fill}
                  stroke={colors.edge}
                  strokeWidth="0.11"
                  filter="url(#map-soft-shadow)"
                />
              )}
              {trackedResident && (
                <text
                  x={centerX}
                  y={rect.y - 0.5}
                  textAnchor="middle"
                  fill="#a97038"
                  fontSize=".58"
                  pointerEvents="none"
                >
                  {trackedResident.name} ·{" "}
                  {language === "zh" ? "楼内" : "inside"}
                </text>
              )}
              <circle
                cx={buildingDoor(building).x}
                cy={buildingDoor(building).y}
                r="0.11"
                fill={colors.edge}
                opacity="0.85"
                pointerEvents="none"
              />
              <text
                x={centerX}
                y={centerY - 0.08}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#3f4845"
                fontSize="0.76"
                fontWeight="650"
                letterSpacing="-0.015"
                pointerEvents="none"
              >
                {name}
              </text>
              <text
                x={centerX}
                y={centerY + 0.83}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#68716d"
                fontSize="0.56"
                pointerEvents="none"
              >
                {language === "zh" ? `${count} 人` : `${count} here`}
              </text>
              {development && (
                <g pointerEvents="none" aria-hidden="true">
                  {development.role !== "local" && (
                    <text
                      x={centerX}
                      y={building.y + 0.42}
                      textAnchor="middle"
                      fill={
                        development.role === "employment"
                          ? "#4b748d"
                          : "#99733b"
                      }
                      fontSize=".37"
                      fontWeight="650"
                    >
                      {development.role === "employment"
                        ? language === "zh"
                          ? "就业中心"
                          : "JOB CENTER"
                        : language === "zh"
                          ? "商业中心"
                          : "RETAIL CENTER"}
                    </text>
                  )}
                  {[1, 2, 3].map((stage) => (
                    <rect
                      key={stage}
                      x={centerX - 0.7 + (stage - 1) * 0.5}
                      y={building.y + building.h - 0.58}
                      width=".4"
                      height=".1"
                      rx=".04"
                      fill={
                        stage <= development.stage ? colors.edge : "#c9d0c8"
                      }
                    />
                  ))}
                </g>
              )}
            </g>
          );
        })}
      </g>
    ),
    [
      focusTarget,
      indoors,
      keyEntity,
      language,
      layingTrack,
      pickEntity,
      selection,
      trackedBuildingId,
      trackedEntity,
      world.buildings,
    ],
  );

  const focusPath = highlightPath(focusTarget);
  const selectedPath = highlightPath(selection);
  const draftPath = tracePolyline(draft);
  const candidatePath =
    candidateDraft.length > draft.length
      ? tracePolyline(candidateDraft.slice(Math.max(0, draft.length - 1)))
      : [];
  const pendingTrackIds = new Set(
    world.pendingEdits
      .filter(
        (edit) => edit.type === "remove-track" || edit.type === "upgrade-track",
      )
      .map((edit) => edit.id),
  );
  const selectedBuilding =
    selection?.kind === "building"
      ? world.buildings.find((item) => item.id === selection.id)
      : undefined;
  const selectedBerth =
    selection?.kind === "berth"
      ? world.berths.find((item) => item.id === selection.id)
      : undefined;
  const selectedParkingPod =
    selectedBerth?.kind === "parking"
      ? world.pods.find((pod) => pod.berthId === selectedBerth.id)
      : undefined;
  // Keep all three actions together, at a constant screen size and inside the map.
  const menuPoint = {
    x: clamp(
      context?.point.x ?? 0,
      view.x + 140 * mapUnits,
      view.x + view.width - 140 * mapUnits,
    ),
    y: clamp(
      (selectedBuilding
        ? buildingRect(selectedBuilding).y
        : (context?.point.y ?? 0)) -
        52 * mapUnits,
      view.y + 24 * mapUnits,
      view.y + view.height - 70 * mapUnits,
    ),
  };

  return (
    <svg
      ref={svgRef}
      data-map-mode={tool}
      data-testid="city-map"
      aria-label={
        language === "zh" ? "未来交通城市地图" : "Future Transit city map"
      }
      role="application"
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        minHeight: 360,
        background: "#f5f4ef",
        touchAction: "none",
        cursor: layingTrack || placing ? "crosshair" : "grab",
        userSelect: "none",
      }}
      onClick={onCanvasClick}
      onDoubleClick={(event) => {
        event.preventDefault();
        onFinishDraft();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => onHoverPoint(null)}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onWheel={onWheel}
    >
      <title>
        {language === "zh" ? "清湾交通网络" : "Bayhaven transit network"}
      </title>
      <defs>
        <pattern
          id="map-dot-grid"
          width="1"
          height="1"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="0" cy="0" r="0.055" fill="#b8b4aa" opacity="0.6" />
        </pattern>
        <filter
          id="map-soft-shadow"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
        >
          <feDropShadow
            dx="0"
            dy="0.12"
            stdDeviation="0.16"
            floodColor="#504c43"
            floodOpacity="0.16"
          />
        </filter>
      </defs>

      <rect
        x={-4}
        y={-4}
        width={world.width + 8}
        height={world.height + 8}
        fill="#f5f4ef"
      />
      {tool === "edit" && (
        <rect
          x={0}
          y={0}
          width={world.width - 1}
          height={world.height - 1}
          fill="url(#map-dot-grid)"
          pointerEvents="none"
        />
      )}

      <g aria-label={language === "zh" ? "轨道" : "Tracks"}>
        {tripleChains.map((chain, index) => (
          <g key={`triple-${index}`} pointerEvents="none">
            <path
              d={roundedPath(chain)}
              fill="none"
              stroke="#827e72"
              strokeWidth=".69"
              strokeLinecap="round"
            />
            <path
              d={roundedPath(chain)}
              fill="none"
              stroke="#f5f4ef"
              strokeWidth=".43"
              strokeLinecap="round"
            />
            <path
              d={roundedPath(chain)}
              fill="none"
              stroke="#827e72"
              strokeWidth=".13"
              strokeLinecap="round"
            />
          </g>
        ))}
        {dualChains.map((chain, index) => (
          <g key={`dual-${index}`} pointerEvents="none">
            <path
              d={roundedPath(chain)}
              fill="none"
              stroke="#827e72"
              strokeWidth="0.43"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={roundedPath(chain)}
              fill="none"
              stroke="#f5f4ef"
              strokeWidth="0.17"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}
        {chains.map((chain, index) => (
          <path
            key={`chain-${index}`}
            d={roundedPath(chain)}
            fill="none"
            stroke="#9b9488"
            strokeWidth="0.18"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        ))}
        {(layer === "flow" ? world.tracks : []).map((track) => (
          <line
            key={`active-${track.id}`}
            x1={track.a.x}
            y1={track.a.y}
            x2={track.b.x}
            y2={track.b.y}
            stroke={trafficColor(trafficCounts[track.id] ?? 0, trafficMax)}
            strokeWidth="0.24"
            strokeLinecap="round"
            pointerEvents="none"
            opacity="0.9"
          />
        ))}
        {world.tracks.map((track) => (
          <g
            key={track.id}
            data-map-entity="track"
            data-track-id={track.id}
            data-lanes={track.lanes ?? 1}
            role="button"
            tabIndex={0}
            aria-label={`${language === "zh" ? "轨道" : "Track"} ${track.id} · ${track.lanes ?? 1} ${language === "zh" ? "车道 · 双向共享" : "shared lanes"}`}
            opacity={pendingTrackIds.has(track.id) ? 0.5 : 1}
            style={{
              cursor: layingTrack ? "crosshair" : "pointer",
              outline: "none",
              WebkitTapHighlightColor: "transparent",
            }}
            onClick={(event) =>
              selectEntity(event, { kind: "track", id: track.id })
            }
            onKeyDown={(event) => {
              selectEntityByKeyboard(
                event,
                { kind: "track", id: track.id },
                track.a,
              );
            }}
          >
            <rect
              x={Math.min(track.a.x, track.b.x) - 0.3}
              y={Math.min(track.a.y, track.b.y) - 0.3}
              width={Math.abs(track.b.x - track.a.x) + 0.6}
              height={Math.abs(track.b.y - track.a.y) + 0.6}
              fill="transparent"
              stroke="none"
            />
            <line
              className="track-focus-line"
              x1={track.a.x}
              y1={track.a.y}
              x2={track.b.x}
              y2={track.b.y}
              stroke="transparent"
              strokeWidth=".16"
              pointerEvents="none"
            />
          </g>
        ))}
        {[...degrees.values()]
          .filter((item) => item.degree > 2)
          .map(({ point }) => (
            <circle
              key={`junction-${nodeKey(point)}`}
              cx={point.x}
              cy={point.y}
              r="0.13"
              fill="#f5f4ef"
              stroke="#8d867a"
              strokeWidth="0.1"
              pointerEvents="none"
            />
          ))}
      </g>

      {!!focusPath.length && (
        <path
          d={roundedPath(focusPath, 0.22)}
          fill="none"
          stroke="#d19b58"
          strokeWidth="0.48"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.38"
          pointerEvents="none"
        />
      )}
      {!!selectedPath.length && selection?.kind !== "track" && (
        <path
          d={roundedPath(selectedPath, 0.22)}
          fill="none"
          stroke="#d7873f"
          strokeWidth="0.34"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="0.5 0.28"
          pointerEvents="none"
        />
      )}
      <g
        pointerEvents="none"
        aria-label={language === "zh" ? "所选路段" : "Selected corridor"}
        opacity=".5"
      >
        {trackChains(
          world.tracks.filter((t) => selectedTrackIds.includes(t.id)),
        ).map((chain, i) => (
          <path
            key={i}
            d={roundedPath(chain)}
            fill="none"
            stroke="#d7873f"
            strokeWidth=".44"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {selectedTrackIds.map((id) => (
          <g key={id} data-selected-track={id} />
        ))}
      </g>
      {flows && (
        <g
          pointerEvents="none"
          aria-label={
            language === "zh" ? "建筑去向分布" : "Building destination flows"
          }
        >
          {flows.rows.map((row) => {
            const from = world.buildings.find((b) => b.id === flows.originId),
              to = world.buildings.find((b) => b.id === row.destinationId);
            if (!from || !to) return null;
            const a = {
                x: from.x + (from.w - 1) / 2,
                y: from.y + (from.h - 1) / 2,
              },
              b = { x: to.x + (to.w - 1) / 2, y: to.y + (to.h - 1) / 2 };
            const types =
              flows.mode === "work"
                ? [
                    {
                      n: row.workers,
                      color: "#6387a0",
                      dash: "0.5 0.22",
                      offset: 0,
                    },
                  ]
                : [
                    {
                      n: row.planned,
                      color: "#aaa79c",
                      dash: "0.18 0.28",
                      offset: 0,
                    },
                    {
                      n: row.walk,
                      color: "#bb8b52",
                      dash: "0.35 0.25",
                      offset: -1,
                    },
                    {
                      n: row.pod,
                      color: "#368b80",
                      dash: undefined,
                      offset: 1,
                    },
                  ];
            return (
              <g key={row.destinationId}>
                {types
                  .filter((t) => t.n > 0)
                  .map((t, i) => (
                    <path
                      key={i}
                      d={`M${a.x},${a.y} Q${(a.x + b.x) / 2 + t.offset * 2},${(a.y + b.y) / 2 - t.offset * 2} ${b.x},${b.y}`}
                      fill="none"
                      stroke={t.color}
                      strokeWidth={0.09 + Math.sqrt(t.n) * 0.025}
                      strokeDasharray={t.dash}
                      opacity="0.66"
                    />
                  ))}
              </g>
            );
          })}
        </g>
      )}

      {buildingLayer}

      <g aria-label={language === "zh" ? "泊位" : "Berths"}>
        {world.berths.map((berth: Berth) => {
          const selected = sameSelection(selection, "berth", berth.id);
          const focused = sameSelection(focusTarget, "berth", berth.id);
          return (
            <g
              key={berth.id}
              data-map-entity="berth"
              data-berth-id={berth.id}
              role="button"
              tabIndex={0}
              aria-label={
                language === "zh"
                  ? `${berth.kind === "platform" ? "站台" : "停车位"} ${berth.id}`
                  : `${berth.kind} ${berth.id}`
              }
              style={{ cursor: layingTrack ? "crosshair" : "pointer" }}
              onClick={(event) =>
                selectEntity(
                  event,
                  { kind: "berth", id: berth.id },
                  berth.access,
                )
              }
              onKeyDown={(event) =>
                selectEntityByKeyboard(
                  event,
                  { kind: "berth", id: berth.id },
                  berth.access,
                )
              }
            >
              <line
                x1={berth.point.x}
                y1={berth.point.y}
                x2={berth.access.x}
                y2={berth.access.y}
                stroke={selected ? "#d7873f" : "#aaa397"}
                strokeWidth={selected ? 0.25 : 0.12}
                strokeLinecap="round"
              />
              <circle
                cx={berth.access.x}
                cy={berth.access.y}
                r="0.11"
                fill="#f5f4ef"
                stroke="#8e887d"
                strokeWidth="0.09"
              />
              {(selected || focused) && (
                <circle
                  cx={berth.point.x}
                  cy={berth.point.y}
                  r="0.42"
                  fill="none"
                  stroke={selected ? "#d7873f" : "#d19b58"}
                  strokeWidth="0.12"
                />
              )}
              {berth.kind === "platform" ? (
                <circle
                  cx={berth.point.x}
                  cy={berth.point.y}
                  r="0.25"
                  fill="#f5f4ef"
                  stroke="#39736e"
                  strokeWidth="0.13"
                />
              ) : (
                <rect
                  x={berth.point.x - 0.2}
                  y={berth.point.y - 0.2}
                  width="0.4"
                  height="0.4"
                  rx="0.08"
                  fill="#f5f4ef"
                  stroke="#80796e"
                  strokeWidth="0.1"
                />
              )}
            </g>
          );
        })}
      </g>

      {!!draftPath.length && (
        <g pointerEvents="none">
          <path
            d={roundedPath(draftPath)}
            fill="none"
            stroke="#d7873f"
            strokeWidth="0.24"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="0.6 0.32"
          />
          {draft.map((point, index) => (
            <circle
              key={`${point.x}-${point.y}-${index}`}
              cx={point.x}
              cy={point.y}
              r={index === draft.length - 1 ? 0.24 : 0.16}
              fill="#f5f4ef"
              stroke="#d7873f"
              strokeWidth="0.11"
            />
          ))}
        </g>
      )}

      {layingTrack && candidatePath.length > 1 && (
        <g
          pointerEvents="none"
          data-track-preview="true"
          data-valid={!candidateInvalid}
        >
          <path
            d={roundedPath(candidatePath)}
            fill="none"
            stroke={candidateInvalid ? "#bc574a" : "#3b9387"}
            strokeWidth=".28"
            strokeDasharray=".4 .22"
            strokeLinecap="round"
          />
          <circle
            cx={candidatePath.at(-1)!.x}
            cy={candidatePath.at(-1)!.y}
            r=".28"
            fill="#f5f4ef"
            stroke={candidateInvalid ? "#bc574a" : "#3b9387"}
            strokeWidth=".1"
          />
        </g>
      )}

      <g aria-label={language === "zh" ? "居民" : "Residents"}>
        {world.residents.map((resident) => {
          // A passenger is represented by the colored dot inside their Pod.
          if (
            resident.status === "inside" ||
            ["boarding", "riding", "alighting"].includes(resident.status)
          )
            return null;
          const position = residentPosition(world, resident, displayTime);
          if (!position) return null;
          return (
            <ResidentMarker
              key={resident.id}
              id={resident.id}
              name={resident.name}
              color={resident.color}
              x={position.x}
              y={position.y}
              selected={sameSelection(selection, "resident", resident.id)}
              focused={sameSelection(focusTarget, "resident", resident.id)}
              crosshair={layingTrack}
              onPick={pickEntity}
              onKey={keyEntity}
            />
          );
        })}
      </g>

      <g aria-label="Pods">
        {world.pods.map((pod) => {
          const position = podPosition(world, pod, displayTime);
          const carried = pod.plan?.residentId
            ? residentsById.get(pod.plan.residentId)
            : undefined;
          const passenger =
            carried &&
            ["boarding", "riding", "alighting"].includes(carried.status)
              ? carried
              : undefined;
          const selected = sameSelection(selection, "pod", pod.id);
          const focused = sameSelection(focusTarget, "pod", pod.id);
          return (
            <g
              key={pod.id}
              data-map-entity="pod"
              data-pod-id={pod.id}
              role="button"
              tabIndex={0}
              aria-label={`Pod ${pod.id}`}
              transform={`translate(${number(position.x)} ${number(position.y)})`}
              style={{ cursor: layingTrack ? "crosshair" : "pointer" }}
              onClick={(event) =>
                selectEntity(event, { kind: "pod", id: pod.id })
              }
              onKeyDown={(event) =>
                selectEntityByKeyboard(event, { kind: "pod", id: pod.id })
              }
            >
              {(selected || focused) && (
                <rect
                  x="-0.43"
                  y="-0.43"
                  width="0.86"
                  height="0.86"
                  rx="0.23"
                  fill="none"
                  stroke={selected ? "#d7873f" : "#d19b58"}
                  strokeWidth="0.12"
                />
              )}
              <rect
                x="-0.3"
                y="-0.3"
                width="0.6"
                height="0.6"
                rx="0.15"
                fill="#155f5c"
                stroke="#fffdf7"
                strokeWidth="0.07"
                filter="url(#map-soft-shadow)"
              />
              {passenger && (
                <circle
                  cx="0"
                  cy="0"
                  r="0.105"
                  fill={passenger.color}
                  stroke="#fffdf7"
                  strokeWidth="0.035"
                  data-passenger-id={passenger.id}
                />
              )}
            </g>
          );
        })}
      </g>

      {tool === "edit" && placing && placement && (
        <g
          pointerEvents="none"
          data-berth-preview={placement.kind}
          data-placement-valid={placement.valid}
          stroke={placement.valid ? "#2f8270" : "#b9574e"}
          fill="#fffdf8"
          strokeWidth="0.12"
        >
          <line
            x1={placement.point.x}
            y1={placement.point.y}
            x2={placement.access.x}
            y2={placement.access.y}
            strokeWidth="0.16"
            strokeDasharray="0.16 0.1"
          />
          {placement.kind === "parking" ? (
            <rect
              x={placement.point.x - 0.32}
              y={placement.point.y - 0.32}
              width="0.64"
              height="0.64"
              rx="0.06"
            />
          ) : (
            <circle cx={placement.point.x} cy={placement.point.y} r="0.32" />
          )}
          <circle
            cx={placement.access.x}
            cy={placement.access.y}
            r="0.12"
            fill={placement.valid ? "#2f8270" : "#b9574e"}
          />
        </g>
      )}
      {tool === "edit" && context && !placing && draft.length === 0 && (
        <MapUnitsContext.Provider value={mapUnits}>
          <g
            className="map-actions"
            aria-label={language === "zh" ? "地图操作" : "Map actions"}
          >
            <circle
              cx={context.point.x}
              cy={context.point.y}
              r="0.22"
              fill="#fffdf8"
              stroke="#2f8270"
              strokeWidth="0.08"
              pointerEvents="none"
            />
            <MapActionButton
              point={{ x: menuPoint.x - 92 * mapUnits, y: menuPoint.y }}
              minWidth={84}
              label={language === "zh" ? "铺轨" : "Track"}
              title={language === "zh" ? "从此处铺轨" : "Start track here"}
              onAction={() =>
                onMapAction({ type: "choose-build", kind: "track" })
              }
            />
            <MapActionButton
              point={menuPoint}
              minWidth={84}
              label={language === "zh" ? "停车位" : "Parking"}
              title={
                language === "zh" ? "在此处建停车位" : "Build parking here"
              }
              tone="parking"
              onAction={() =>
                onMapAction({ type: "choose-build", kind: "parking" })
              }
            />
            <MapActionButton
              point={{ x: menuPoint.x + 92 * mapUnits, y: menuPoint.y }}
              minWidth={84}
              label={language === "zh" ? "站点" : "Station"}
              title={language === "zh" ? "在此处建站点" : "Build station here"}
              onAction={() =>
                onMapAction({ type: "choose-build", kind: "platform" })
              }
            />
            {selectedBerth?.kind === "platform" && (
              <MapActionButton
                point={{ x: menuPoint.x, y: menuPoint.y + 44 * mapUnits }}
                label={language === "zh" ? "移除" : "Remove"}
                title={language === "zh" ? "移除平台" : "Remove platform"}
                tone="danger"
                onAction={() =>
                  onMapAction({ type: "remove-berth", id: selectedBerth.id })
                }
              />
            )}
            {selectedBerth?.kind === "parking" && (
              <>
                {!selectedParkingPod?.plan && (
                  <MapActionButton
                    point={{
                      x: menuPoint.x - 46 * mapUnits,
                      y: menuPoint.y + 44 * mapUnits,
                    }}
                    minWidth={84}
                    label={
                      selectedParkingPod
                        ? language === "zh"
                          ? "售 Pod"
                          : "Sell Pod"
                        : "+Pod"
                    }
                    title={
                      selectedParkingPod
                        ? language === "zh"
                          ? "回售停放的 Pod"
                          : "Sell parked Pod"
                        : language === "zh"
                          ? "购买 Pod"
                          : "Buy Pod"
                    }
                    tone="parking"
                    onAction={() =>
                      selectedParkingPod
                        ? onMapAction({
                            type: "sell-pod",
                            id: selectedParkingPod.id,
                          })
                        : onMapAction({
                            type: "buy-pod",
                            berthId: selectedBerth.id,
                          })
                    }
                  />
                )}
                <MapActionButton
                  point={{
                    x: menuPoint.x + 46 * mapUnits,
                    y: menuPoint.y + 44 * mapUnits,
                  }}
                  minWidth={84}
                  label={language === "zh" ? "移除" : "Remove"}
                  title={language === "zh" ? "移除停车位" : "Remove parking"}
                  tone="danger"
                  onAction={() =>
                    onMapAction({ type: "remove-berth", id: selectedBerth.id })
                  }
                />
              </>
            )}
          </g>
        </MapUnitsContext.Provider>
      )}
      {flows && (
        <g pointerEvents="none">
          {flowLabels.map(
            ({ id, x, y, width, height, anchorY, label, row }) => (
              <g
                key={id}
                data-flow-destination={id}
                data-walk-count={row.walk}
                data-pod-count={row.pod}
                data-planned-count={row.planned}
                data-worker-count={row.workers}
              >
                <line
                  x1={x}
                  y1={y + height / 2}
                  x2={x}
                  y2={anchorY}
                  stroke="#b8b8a8"
                  strokeWidth=".07"
                />
                <rect
                  x={x - width / 2}
                  y={y - height / 2}
                  width={width}
                  height={height}
                  rx=".3"
                  fill="#fffdf7"
                  stroke="#b8b8a8"
                  strokeWidth=".07"
                />
                <text
                  x={x}
                  y={y + flowFont * 0.32}
                  textAnchor="middle"
                  fill="#366d66"
                  fontSize={flowFont}
                  fontWeight="600"
                >
                  {label}
                </text>
              </g>
            ),
          )}
        </g>
      )}
    </svg>
  );
}

export default MapView;
