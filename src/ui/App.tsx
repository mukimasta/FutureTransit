import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Download,
  Eye,
  FileUp,
  Footprints,
  Gauge,
  Languages,
  LocateFixed,
  Map as MapIcon,
  MousePointer2,
  ParkingCircle,
  Pause,
  Play,
  Plus,
  Route,
  Save,
  Settings2,
  Trash2,
  Undo2,
  Users,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import { useSimulation } from "../app/bridge";
import { trackResources, findTrackPath, validateTrackDraft } from "../network";
import { corridorTracks, trackRange } from "../network/selection";
import { previewPoints } from "../network/preview";
import {
  readGuideDismissed,
  rememberGuideDismissed,
  readIntroSeen,
  rememberIntroSeen,
} from "./preferences";
import { Introduction } from "./Introduction";
import {
  parkingGroups,
  parkingPurchaseShortage,
  parkingShortage,
} from "../simulation/fleet";
import { buildingFlow, type FlowMode } from "../insights";
import { distance } from "../shared/math";
import {
  parseWorld,
  serializeWorld,
  loadLocal,
  saveLocal,
} from "../persistence";
import { MapView } from "../rendering/MapView";
import {
  PARKING_COST,
  PLATFORM_COST,
  POD_COST,
  TRACK_UPGRADE_COST,
  MAX_PODS,
} from "../shared/constants";
import { buildingDevelopmentStats } from "../shared/development";
import {
  berthOccupant,
  cityStats,
  formatClock,
  formatDuration,
} from "../shared/selectors";
import type {
  Berth,
  Building,
  Language,
  Point,
  Resident,
  Selection,
  SelectionModifiers,
  Side,
  Tool,
  World,
} from "../shared/types";
import {
  kindName,
  purposeName,
  sideName,
  statusName,
  text,
  waitReasonName,
} from "./i18n";

const SIDES: Side[] = ["north", "east", "south", "west"];

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function SectionTitle({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <h3 className="section-title">
      <span>{children}</span>
      {count !== undefined && <em>{count}</em>}
    </h3>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="empty-line">{children}</p>;
}

function buildingName(
  world: World,
  id: string | null | undefined,
  language: Language,
) {
  const building = id
    ? world.buildings.find((item) => item.id === id)
    : undefined;
  return building ? (language === "zh" ? building.name : building.nameEn) : "—";
}

function shortId(id: string) {
  const number = id.match(/(\d+)$/)?.[1];
  return number ? `#${number.padStart(2, "0")}` : id;
}

function entityExists(world: World, selection: NonNullable<Selection>) {
  if (selection.kind === "building")
    return world.buildings.some((item) => item.id === selection.id);
  if (selection.kind === "resident")
    return world.residents.some((item) => item.id === selection.id);
  if (selection.kind === "pod")
    return world.pods.some((item) => item.id === selection.id);
  if (selection.kind === "berth")
    return world.berths.some((item) => item.id === selection.id);
  return world.tracks.some((item) => item.id === selection.id);
}

function ResidentButton({
  resident,
  world,
  language,
  onClick,
}: {
  resident: Resident;
  world: World;
  language: Language;
  onClick: () => void;
}) {
  const destination =
    resident.journey?.destinationId ?? resident.nextDestinationId;
  return (
    <button className="entity-row" type="button" onClick={onClick}>
      <i style={{ background: resident.color }} />
      <span>
        <strong>{resident.name}</strong>
        <small>
          {statusName(resident.status, language)} ·{" "}
          {buildingName(world, destination, language)}
        </small>
      </span>
      <ChevronRight size={14} />
    </button>
  );
}

function ToolButton({
  active,
  label,
  shortcut,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  shortcut: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`tool-button${active ? " is-active" : ""}`}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${label} (${shortcut})`}
    >
      {icon}
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  );
}

export default function App() {
  const { world, send, replaceWorld, lastResult } = useSimulation();
  const [language, setLanguage] = useState<Language>("zh");
  const [tool, setTool] = useState<Tool>("select");
  const [layer, setLayer] = useState<"life" | "flow">("life");
  const [selection, setSelection] = useState<Selection>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [residentRosterOpen, setResidentRosterOpen] = useState(false);
  const [podRosterOpen, setPodRosterOpen] = useState(false);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [flowMode, setFlowMode] = useState<FlowMode>("demand");
  const [mapResetToken, setMapResetToken] = useState(0);
  const [focusTarget, setFocusTarget] = useState<Selection | undefined>();
  const [draft, setDraft] = useState<Point[]>([]);
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [side, setSide] = useState<Side>("east");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(() => !readIntroSeen());
  const [guideOpen, setGuideOpen] = useState(true);
  const [guideDismissed, setGuideDismissed] = useState(readGuideDismissed);
  const [guideReplay, setGuideReplay] = useState(false);
  const [didFollowResident, setDidFollowResident] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const pendingDraft = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const dismissGuide = () => {
    setGuideDismissed(true);
    setGuideReplay(false);
    rememberGuideDismissed(true);
  };

  const draftReview = useMemo(
    () => (world ? validateTrackDraft(world, draft) : null),
    [draft, world],
  );
  const candidateDraft = useMemo(
    () => previewPoints(draft, tool === "track" ? hoverPoint : null),
    [draft, hoverPoint, tool],
  );
  const candidateReview = useMemo(
    () => (world ? validateTrackDraft(world, candidateDraft) : null),
    [world, candidateDraft],
  );
  const onHoverPoint = (point: Point | null) =>
    setHoverPoint((previous) =>
      previous?.x === point?.x && previous?.y === point?.y ? previous : point,
    );
  const stats = useMemo(() => (world ? cityStats(world) : null), [world]);
  const availableGrant =
    (world?.economy.pendingGrant ?? 0) +
    (world?.economy.pendingGrowthGrant ?? 0);
  const parkingMissing = useMemo(
    () => (world ? parkingShortage(world) : 0),
    [world],
  );
  const removableTracks = useMemo(
    () =>
      world?.tracks.filter(
        (track) =>
          selectedTrackIds.includes(track.id) &&
          !world.pendingEdits.some((edit) => edit.id === track.id),
      ) ?? [],
    [world, selectedTrackIds],
  );
  const removalRefund = removableTracks.reduce(
    (sum, track) => sum + track.paid,
    0,
  );
  const pendingSelectedCount =
    world?.pendingEdits.filter((edit) => selectedTrackIds.includes(edit.id))
      .length ?? 0;
  const removeSelectedTracks = () => {
    if (removableTracks.length)
      send({
        type: "remove-tracks",
        ids: removableTracks.map((track) => track.id),
      });
  };
  const flows = useMemo(
    () =>
      world && selection?.kind === "building"
        ? buildingFlow(
            world,
            selection.id,
            flowMode === "work" &&
              world.buildings.find((b) => b.id === selection.id)?.kind !==
                "home"
              ? "demand"
              : flowMode,
          )
        : undefined,
    [world, selection, flowMode],
  );
  useEffect(() => {
    if (world && world.metrics.served > 0 && !guideReplay && !guideDismissed)
      dismissGuide();
  }, [world?.metrics.served, guideReplay, guideDismissed]);
  useEffect(() => setHoverPoint(null), [tool]);
  useEffect(() => {
    setLocalMessage(null);
  }, [lastResult]);
  useEffect(() => {
    setNoticeVisible(true);
    const timer = window.setTimeout(
      () => setNoticeVisible(false),
      lastResult?.ok === false ? 12000 : 6000,
    );
    return () => clearTimeout(timer);
  }, [lastResult, localMessage]);

  useEffect(() => {
    if (!world) return;
    const remaining = selectedTrackIds.filter((id) =>
      world.tracks.some((track) => track.id === id),
    );
    if (remaining.length !== selectedTrackIds.length)
      setSelectedTrackIds(remaining);
    if (selection && !entityExists(world, selection))
      setSelection(
        selection.kind === "track" && remaining.length
          ? { kind: "track", id: remaining[0] }
          : null,
      );
  }, [selection, selectedTrackIds, world]);

  useEffect(() => {
    if (!world || selection?.kind !== "berth") return;
    const berth = world.berths.find((item) => item.id === selection.id);
    if (berth) setSide(berth.side);
    // Reset only when the selected berth changes. Frequent world snapshots must
    // not overwrite the player's pending side choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.kind, selection?.id]);

  useEffect(() => {
    if (!lastResult || !pendingDraft.current) return;
    pendingDraft.current = false;
    if (lastResult.ok) setDraft([]);
  }, [lastResult]);

  const finishDraft = () => {
    if (
      !world ||
      draft.length < 2 ||
      !draftReview ||
      draftReview.error ||
      pendingDraft.current
    )
      return;
    pendingDraft.current = true;
    send({ type: "build-track", points: draft });
  };
  const activateRemoval = () => {
    setTool("remove");
    setInspectorHidden(true);
    setOverviewOpen(false);
    setFocusTarget(undefined);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (introOpen) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
      )
        return;
      if (event.key === "Escape") {
        if (draft.length) setDraft([]);
        else {
          setSelection(null);
          setSelectedTrackIds([]);
          setFocusTarget(undefined);
          setOverviewOpen(false);
          setInspectorHidden(false);
          setSettingsOpen(false);
        }
      } else if (event.key === "Backspace" && draft.length) {
        event.preventDefault();
        setDraft((points) => points.slice(0, -1));
      } else if (event.key === "Enter" && tool === "track") {
        event.preventDefault();
        finishDraft();
      } else if (event.key.toLowerCase() === "t") {
        setTool("track");
      } else if (event.key.toLowerCase() === "x") {
        activateRemoval();
      } else if (event.key.toLowerCase() === "v") {
        setTool("select");
      } else if (event.code === "Space" && world) {
        event.preventDefault();
        send({ type: "pause", value: !world.paused });
      } else if (event.key.toLowerCase() === "h") {
        setFocusTarget(undefined);
        setMapResetToken((t) => t + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!world || !stats) {
    return (
      <main className="loading-screen">
        <span className="loading-mark">
          <Route size={22} />
        </span>
        <p>FUTURE / TRANSIT</p>
        <small>城市正在醒来 · Waking the city</small>
      </main>
    );
  }

  const tx = (zh: string, en: string) => text(language, zh, en);
  const focus = (next: NonNullable<Selection>) => {
    setTool("select");
    setOverviewOpen(false);
    setInspectorHidden(false);
    setSelection(next);
    setFocusTarget(undefined);
    window.requestAnimationFrame(() => setFocusTarget(next));
  };
  const onSelect = (next: Selection, modifiers: SelectionModifiers = {}) => {
    setFocusTarget(undefined);
    setOverviewOpen(false);
    if (!modifiers.additive && !modifiers.range)
      setInspectorHidden(tool === "remove");
    if (!next) {
      if (tool !== "track") {
        setSelection(null);
        setSelectedTrackIds([]);
      }
      return;
    }
    if (next.kind === "track" && tool !== "track") {
      const corridor = modifiers.single
        ? [next.id]
        : corridorTracks(world, next.id);
      if (modifiers.range && selection?.kind === "track") {
        const range = trackRange(world, selection.id, next.id);
        if (!range.length) {
          setLocalMessage(
            tx(
              "两个路段不连通；用 Command/Ctrl 添加独立路段。",
              "Sections are disconnected; use Command/Ctrl to add another corridor.",
            ),
          );
          return;
        }
        setSelectedTrackIds((previous) => [
          ...new Set([...previous, ...range]),
        ]);
      } else if (modifiers.additive)
        setSelectedTrackIds((previous) =>
          corridor.every((id) => previous.includes(id))
            ? previous.filter((id) => !corridor.includes(id))
            : [...new Set([...previous, ...corridor])],
        );
      else setSelectedTrackIds(corridor);
    } else setSelectedTrackIds([]);
    setSelection(next);
    if (tool === "remove" && next.kind === "berth")
      send({ type: "remove-berth", id: next.id });
  };
  const onMapPoint = (point: Point) => {
    if (tool !== "track") return;
    setHoverPoint(null);
    setDraft((points) => {
      const last = points.at(-1);
      return last?.x === point.x && last.y === point.y
        ? points
        : [...points, point];
    });
  };

  const homePlatform = world.berths.find(
    (berth) =>
      berth.kind === "platform" &&
      world.buildings.find((building) => building.id === berth.buildingId)
        ?.kind === "home",
  );
  const office = world.buildings.find((building) => building.kind === "office");
  const officePlatform = world.berths.find(
    (berth) => berth.kind === "platform" && berth.buildingId === office?.id,
  );
  const guideConnected = !!(
    homePlatform &&
    officePlatform &&
    findTrackPath(world, homePlatform.point, officePlatform.point)
  );
  const guideDone = [!!officePlatform, guideConnected, didFollowResident];

  const selectGuideStep = (index: number) => {
    if (index === 0 && office) focus({ kind: "building", id: office.id });
    if (index === 1) {
      setTool("track");
      setDraft(homePlatform ? [homePlatform.access] : []);
      setSelection(null);
      setFocusTarget(undefined);
      setMapResetToken((t) => t + 1);
    }
    if (index === 2) {
      if (world.paused) send({ type: "pause", value: false });
      const resident = world.residents[0];
      if (resident) focus({ kind: "resident", id: resident.id });
      setDidFollowResident(true);
    }
  };

  const newCity = () => {
    const confirmed = window.confirm(
      tx(
        "新城市会替换当前进度。要继续吗？",
        "A new city replaces the current progress. Continue?",
      ),
    );
    if (!confirmed) return;
    setSelection(null);
    setDraft([]);
    setSettingsOpen(false);
    setDidFollowResident(false);
    setGuideReplay(false);
    setGuideOpen(true);
    setInspectorHidden(false);
    setMapResetToken((t) => t + 1);
    send({ type: "reset" });
  };

  const exportWorld = () => {
    const blob = new Blob([serializeWorld(world)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `future-transit-${world.seed}-${formatClock(world.time).replace(":", "")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setLocalMessage(
      tx(
        "已请求下载，请确认浏览器中的保存结果。",
        "Download requested; check your browser for the saved file.",
      ),
    );
  };

  const importWorld = async (file: File | undefined) => {
    if (!file) return;
    try {
      const next = parseWorld(await file.text());
      replaceWorld(next);
      setSelection(null);
      setDraft([]);
      setSettingsOpen(false);
      setLocalMessage(
        tx(
          "存档已验证并载入；城市保持暂停。",
          "Save verified and loaded; the city remains paused.",
        ),
      );
    } catch (error) {
      setLocalMessage(
        `${tx("无法载入：", "Could not load: ")}${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const renderInspector = () => {
    if (selection && !entityExists(world, selection))
      return <EmptyLine>{tx("改造已完成。", "Edit complete.")}</EmptyLine>;
    if (!selection) {
      return (
        <>
          <div className="inspector-heading">
            <span className="eyebrow">{tx("城市概览", "CITY OVERVIEW")}</span>
            <h2>{tx("清湾", "Bayhaven")}</h2>
            <p>
              {tx(
                "一座正在学习如何移动的城市。",
                "A city learning how to move.",
              )}
            </p>
          </div>
          <div className="mini-grid">
            <div>
              <Users size={15} />
              <strong>{stats.population}</strong>
              <span>{tx("居民", "residents")}</span>
            </div>
            <div>
              <Building2 size={15} />
              <strong>{stats.buildings}</strong>
              <span>{tx("建筑", "buildings")}</span>
            </div>
            <div>
              <Route size={15} />
              <strong>{world.tracks.length}</strong>
              <span>{tx("轨道段", "track cells")}</span>
            </div>
            <div>
              <Zap size={15} />
              <strong>{stats.pods}</strong>
              <span>Pods</span>
            </div>
          </div>
          <div className="development-card">
            <strong>{tx("城市持续生长", "An evolving city")}</strong>
            <p>
              {!world.growth.enabled
                ? tx(
                    "扩建与入驻已暂缓，现有出行继续。",
                    "Construction and move-ins paused; existing trips continue.",
                  )
                : world.growth.limited
                  ? tx(
                      "新增规模暂受空间或性能容量限制，现有生活继续。",
                      "New growth is limited by space or technical capacity; city life continues.",
                    )
                  : tx(
                      `下一轮${world.growth.nextKind === "infill" ? "旧城填充" : "片区扩展"} · ${formatDuration(world.growth.nextAt - world.time, language)}后`,
                      `Next ${world.growth.nextKind === "infill" ? "infill" : "district expansion"} in ${formatDuration(world.growth.nextAt - world.time, language)}`,
                    )}
            </p>
            <small>
              {tx(
                "新楼 → 逐批入驻 → 就业与商业聚集",
                "New buildings → gradual occupancy → job and retail centers",
              )}
            </small>
          </div>
          <details
            className="roster"
            onToggle={(event) =>
              setResidentRosterOpen(event.currentTarget.open)
            }
          >
            <summary>
              {tx("居民名册", "Resident directory")} · {world.residents.length}
            </summary>
            <div className="entity-list tall">
              {residentRosterOpen &&
                world.residents.map((resident) => (
                  <ResidentButton
                    key={resident.id}
                    resident={resident}
                    world={world}
                    language={language}
                    onClick={() => focus({ kind: "resident", id: resident.id })}
                  />
                ))}
            </div>
          </details>
          <details
            className="roster"
            onToggle={(event) => setPodRosterOpen(event.currentTarget.open)}
          >
            <summary>
              {tx("车队名单", "Fleet directory")} · {world.pods.length}
            </summary>
            <div className="entity-list">
              {podRosterOpen &&
                world.pods.map((pod) => (
                  <button
                    className="entity-row"
                    type="button"
                    key={pod.id}
                    onClick={() => focus({ kind: "pod", id: pod.id })}
                  >
                    Pod {shortId(pod.id)} ·{" "}
                    {pod.plan ? tx("执行行程", "Active") : tx("停泊", "Parked")}
                  </button>
                ))}
            </div>
          </details>
          <p className={parkingMissing ? "pending-note" : "flow-legend"}>
            {parkingMissing
              ? tx(
                  `停车缺口 ${parkingMissing}：请补可达停车位。现有 Pod 保留，但不可继续超额购车。`,
                  `Parking shortage ${parkingMissing}: add connected parking. Existing Pods are preserved; extra purchases are blocked.`,
                )
              : tx(
                  "停车规则：每辆 Pod 一个专用位，每个运营路网另留一个周转位。",
                  "Parking: one space per Pod plus one spare per operating network.",
                )}
          </p>
          <div className="details">
            <DetailRow label={tx("已完成 Pod 接送", "Pod trips completed")}>
              {stats.served}
            </DetailRow>
            <DetailRow label={tx("平均候车", "Average wait")}>
              {formatDuration(stats.averageWait, language)}
            </DetailRow>
            <DetailRow label={tx("累计节约时间", "Total time saved")}>
              {stats.savedMinutes} {tx("分钟", "min")}
            </DetailRow>
          </div>
          <SectionTitle>{tx("城市消息", "City notes")}</SectionTitle>
          <div className="notice-list">
            {[...world.notices]
              .reverse()
              .slice(0, 5)
              .map((notice) => (
                <div className={`notice ${notice.kind}`} key={notice.id}>
                  <CircleDot size={12} />
                  <span>
                    {language === "zh" ? notice.text : notice.textEn}
                    <small>{formatClock(notice.time)}</small>
                  </span>
                </div>
              ))}
            {!world.notices.length && (
              <EmptyLine>
                {tx("这里会记录城市变化。", "City changes will appear here.")}
              </EmptyLine>
            )}
          </div>
        </>
      );
    }

    if (selection.kind === "building") {
      const building = world.buildings.find(
        (item) => item.id === selection.id,
      )!;
      const inside = world.residents
        .filter((resident) => resident.atBuildingId === building.id)
        .sort((a, b) => a.nextDeparture - b.nextDeparture);
      const berthIds = new Set(
        world.berths
          .filter((berth) => berth.buildingId === building.id)
          .map((berth) => berth.id),
      );
      const waiting = world.residents.filter(
        (resident) =>
          resident.status === "waiting" &&
          !!resident.journey?.pickupId &&
          berthIds.has(resident.journey.pickupId),
      );
      const development = buildingDevelopmentStats(world, building);
      return (
        <>
          <div className="inspector-heading entity-heading">
            <span className="eyebrow">
              {kindName(building.kind, language)} · {shortId(building.id)}
            </span>
            <h2>{language === "zh" ? building.name : building.nameEn}</h2>
            <p>
              {inside.length} {tx("人在楼内", "people inside")} ·{" "}
              {waiting.length} {tx("人候车", "waiting")}
            </p>
          </div>
          <div className="development-card">
            <strong>
              {development.role === "employment"
                ? tx("就业中心", "Employment center")
                : development.role === "commercial"
                  ? tx("商业中心", "Commercial center")
                  : tx("街区生活", "Neighborhood life")}
            </strong>
            <div className="details">
              <DetailRow
                label={
                  building.kind === "home"
                    ? tx("住户 / 可容纳", "Residents / capacity")
                    : building.kind === "office"
                      ? tx("任职 / 已开放岗位", "Workers / open jobs")
                      : tx("营业率", "Operating capacity")
                }
              >
                {building.kind === "shop"
                  ? `${Math.round((development.active / development.capacity) * 100)}%`
                  : `${development.assigned} / ${building.kind === "home" ? development.capacity : development.active}`}
              </DetailRow>
              {building.kind === "office" && (
                <DetailRow
                  label={tx("全部入驻后岗位", "Fully commissioned jobs")}
                >
                  {development.capacity}
                </DetailRow>
              )}
              <DetailRow label={tx("街区布局", "District layout")}>
                {building.development?.layout === "ordered"
                  ? tx("规整组团", "Ordered block")
                  : tx("自然聚集", "Organic cluster")}
              </DetailRow>
            </div>
            <div
              className="development-progress"
              aria-label={tx("入驻阶段", "Development stage")}
            >
              {[1, 2, 3].map((stage) => (
                <i
                  key={stage}
                  className={stage <= development.stage ? "active" : ""}
                />
              ))}
            </div>
            <p>
              {development.stage < 3
                ? !world.growth.enabled
                  ? tx("下一批入驻已暂缓。", "Next occupancy phase paused.")
                  : tx(
                      `下一批${building.kind === "home" ? "住户" : building.kind === "office" ? "企业" : "商铺"} · ${formatDuration(development.nextAt - world.time, language)}后`,
                      `Next occupancy phase in ${formatDuration(development.nextAt - world.time, language)}`,
                    )
                : tx(
                    "已完成入驻；人流仍随城市目的地变化。",
                    "Fully occupied; trips still evolve with the city.",
                  )}
            </p>
            {development.role !== "local" && (
              <small>
                {tx(
                  "吸引其他片区的真实居民，注意平台与共享主干容量。",
                  "Draws real residents across districts; watch platforms and shared trunks.",
                )}
              </small>
            )}
          </div>
          <SectionTitle>{tx("他们去哪里", "Where people go")}</SectionTitle>
          <div className="flow-tabs">
            <button
              type="button"
              className={flows?.mode === "demand" ? "is-active" : ""}
              onClick={() => setFlowMode("demand")}
            >
              {tx("当前去向", "Intentions")}
            </button>
            <button
              type="button"
              className={flows?.mode === "history" ? "is-active" : ""}
              onClick={() => setFlowMode("history")}
            >
              {tx("实际出行", "Actual trips")}
            </button>
            {building.kind === "home" && (
              <button
                type="button"
                className={flows?.mode === "work" ? "is-active" : ""}
                onClick={() => setFlowMode("work")}
              >
                {tx("工作地点", "Workplaces")}
              </button>
            )}
          </div>
          <p className="flow-legend">
            {flows?.mode === "history"
              ? tx(
                  "最近记录 · 最多 30 分钟；统计已完成旅程。",
                  "Recent records · up to 30 min; completed journeys.",
                )
              : flows?.mode === "work"
                ? tx(
                    "所有住户的工作地点，不受当前位置影响。",
                    "All residents’ workplaces, regardless of current location.",
                  )
                : tx(
                    "待 = 尚未选方式；步 = 步行；Pod = 已选择乘车。",
                    "Plan = undecided; Walk / Pod = chosen mode.",
                  )}
          </p>
          <div className="flow-destinations">
            {flows?.rows.map((row) => (
              <details key={row.destinationId}>
                <summary>
                  <span>
                    {buildingName(world, row.destinationId, language)}
                  </span>
                  <strong>
                    {flows.mode === "work" ? (
                      tx(`${row.workers} 人`, `${row.workers} people`)
                    ) : (
                      <>
                        <i className="flow-walk">
                          {tx("步", "Walk")} {row.walk}
                        </i>
                        <i className="flow-pod">Pod {row.pod}</i>
                        {row.planned > 0 && (
                          <i>
                            {tx("待", "Plan")} {row.planned}
                          </i>
                        )}
                      </>
                    )}
                  </strong>
                </summary>
                <div className="entity-list">
                  {row.residentIds.map((id) => {
                    const r = world.residents.find((r) => r.id === id);
                    return r ? (
                      <ResidentButton
                        key={id}
                        resident={r}
                        world={world}
                        language={language}
                        onClick={() => focus({ kind: "resident", id })}
                      />
                    ) : null;
                  })}
                </div>
              </details>
            ))}
            {!flows?.rows.length && (
              <EmptyLine>
                {tx(
                  "这个范围内还没有出行记录。",
                  "No trips recorded in this view yet.",
                )}
              </EmptyLine>
            )}
          </div>
          <SectionTitle>{tx("新增泊位", "Add a berth")}</SectionTitle>
          <div
            className="side-picker"
            aria-label={tx("选择建筑方向", "Choose building side")}
          >
            {SIDES.map((item) => (
              <button
                className={side === item ? "is-active" : ""}
                type="button"
                key={item}
                onClick={() => setSide(item)}
              >
                {sideName(item, language)}
              </button>
            ))}
          </div>
          <div className="button-pair">
            <button
              className="primary-action"
              type="button"
              onClick={() =>
                send({
                  type: "add-berth",
                  buildingId: building.id,
                  kind: "platform",
                  side,
                })
              }
            >
              <Plus size={15} />
              {tx(`平台 ${PLATFORM_COST}`, `Platform ${PLATFORM_COST}`)}
            </button>
            <button
              type="button"
              onClick={() =>
                send({
                  type: "add-berth",
                  buildingId: building.id,
                  kind: "parking",
                  side,
                })
              }
            >
              <ParkingCircle size={15} />
              {tx(`停车 ${PARKING_COST}`, `Parking ${PARKING_COST}`)}
            </button>
          </div>
          <SectionTitle>{tx("建筑泊位", "Building berths")}</SectionTitle>
          <div className="entity-list">
            {world.berths
              .filter((b) => b.buildingId === building.id)
              .map((b) => (
                <button
                  className="entity-row"
                  type="button"
                  key={b.id}
                  onClick={() => focus({ kind: "berth", id: b.id })}
                >
                  {b.kind === "platform"
                    ? tx("平台", "Platform")
                    : tx("停车位", "Parking")}{" "}
                  {shortId(b.id)} · {sideName(b.side, language)}{" "}
                  {berthOccupant(world, b.id) ? " · Pod" : ""}
                </button>
              ))}
          </div>
          <SectionTitle count={waiting.length}>
            {tx("候车与目的地", "Waiting & destinations")}
          </SectionTitle>
          <div className="entity-list">
            {waiting.map((resident) => (
              <ResidentButton
                key={resident.id}
                resident={resident}
                world={world}
                language={language}
                onClick={() => focus({ kind: "resident", id: resident.id })}
              />
            ))}
            {!waiting.length && (
              <EmptyLine>
                {tx("现在没有人在这里候车。", "No one is waiting here now.")}
              </EmptyLine>
            )}
          </div>
          <SectionTitle count={inside.length}>
            {tx("楼内名单", "People inside")}
          </SectionTitle>
          <div className="entity-list tall">
            {inside.map((resident) => (
              <ResidentButton
                key={resident.id}
                resident={resident}
                world={world}
                language={language}
                onClick={() => focus({ kind: "resident", id: resident.id })}
              />
            ))}
            {!inside.length && (
              <EmptyLine>{tx("楼内暂时无人。", "No one is inside.")}</EmptyLine>
            )}
          </div>
        </>
      );
    }

    if (selection.kind === "berth") {
      const berth = world.berths.find((item) => item.id === selection.id)!;
      const building = world.buildings.find(
        (item) => item.id === berth.buildingId,
      )!;
      const occupant = berthOccupant(world, berth.id);
      const queue = world.residents.filter(
        (resident) =>
          resident.status === "waiting" &&
          resident.journey?.pickupId === berth.id,
      );
      const pending = world.pendingEdits.find((edit) => edit.id === berth.id);
      const purchaseShortage = parkingPurchaseShortage(world, berth.id);
      const parkingGroup = parkingGroups(world).find((group) =>
        group.berthIds.includes(berth.id),
      );
      return (
        <>
          <div className="inspector-heading entity-heading">
            <span className="eyebrow">
              {berth.kind === "platform"
                ? tx("平台", "PLATFORM")
                : tx("停车位", "PARKING")}{" "}
              · {shortId(berth.id)}
            </span>
            <h2>{language === "zh" ? building.name : building.nameEn}</h2>
            <p>
              {sideName(berth.side, language)} {tx("侧", "side")} ·{" "}
              {occupant
                ? `${tx("占用", "occupied")} ${shortId(occupant.id)}`
                : tx("空闲", "available")}
            </p>
          </div>
          {pending && (
            <div className="pending-note">
              <Activity size={14} />
              {tx(
                "改造已排队，恢复后安全排空。",
                "Edit queued; resume to clear it safely.",
              )}
            </div>
          )}
          <SectionTitle count={queue.length}>
            {tx("候车队列", "Passenger queue")}
          </SectionTitle>
          <div className="entity-list">
            {queue.map((resident) => (
              <ResidentButton
                key={resident.id}
                resident={resident}
                world={world}
                language={language}
                onClick={() => focus({ kind: "resident", id: resident.id })}
              />
            ))}
            {!queue.length && (
              <EmptyLine>{tx("队列为空。", "The queue is empty.")}</EmptyLine>
            )}
          </div>
          <SectionTitle>{tx("泊位操作", "Berth actions")}</SectionTitle>
          {berth.kind === "parking" && (
            <p className="flow-legend">
              {tx(
                `本路网 ${parkingGroup?.parking ?? 0} 个停车位 / ${parkingGroup?.podIds.length ?? 0} 辆 Pod；保留 1 个周转位。`,
                `This network: ${parkingGroup?.parking ?? 0} parking / ${parkingGroup?.podIds.length ?? 0} Pods; keep one spare.`,
              )}
            </p>
          )}
          {!occupant && berth.kind === "parking" && (
            <button
              className="wide-action primary-action"
              type="button"
              disabled={
                purchaseShortage > 0 ||
                !!pending ||
                world.pods.length >= MAX_PODS ||
                world.economy.cash < POD_COST ||
                world.pods.some((p) => p.plan?.finalBerthId === berth.id)
              }
              onClick={() => send({ type: "buy-pod", berthId: berth.id })}
            >
              <Plus size={15} />
              {tx(`购入 Pod · ${POD_COST}`, `Buy Pod · ${POD_COST}`)}
            </button>
          )}
          {!occupant && berth.kind === "parking" && purchaseShortage > 0 && (
            <p className="flow-legend">
              {tx(
                `购车前还需 ${purchaseShortage} 个可达停车位。`,
                `Add ${purchaseShortage} connected parking spaces before buying.`,
              )}
            </p>
          )}
          {berth.kind === "platform" && (
            <p className="flow-legend">
              {tx(
                "平台仅供上下客；购车请选专用停车位。",
                "Platforms are for passengers. Select dedicated parking to buy a Pod.",
              )}
            </p>
          )}
          <div className="side-picker compact">
            {SIDES.map((item) => (
              <button
                className={side === item ? "is-active" : ""}
                type="button"
                key={item}
                onClick={() => setSide(item)}
              >
                {sideName(item, language)}
              </button>
            ))}
          </div>
          <button
            className="wide-action"
            type="button"
            onClick={() => send({ type: "move-berth", id: berth.id, side })}
          >
            <Route size={15} />
            {tx("改到所选入口", "Move to selected side")}
          </button>
          <button
            className="wide-action danger"
            type="button"
            onClick={() => send({ type: "remove-berth", id: berth.id })}
          >
            <Trash2 size={15} />
            {tx("移除泊位", "Remove berth")}
          </button>
        </>
      );
    }

    if (selection.kind === "resident") {
      const resident = world.residents.find(
        (item) => item.id === selection.id,
      )!;
      const destination =
        resident.journey?.destinationId ?? resident.nextDestinationId;
      const previousTrip = [...world.metrics.recentTrips]
        .reverse()
        .find((t) => t.residentId === resident.id);
      return (
        <>
          <div className="inspector-heading entity-heading resident-heading">
            <i style={{ background: resident.color }} />
            <span className="eyebrow">
              {tx("居民", "RESIDENT")} · {shortId(resident.id)}
            </span>
            <h2>{resident.name}</h2>
            <p>
              {statusName(resident.status, language)}
              {resident.journey
                ? ` · ${purposeName(resident.journey.purpose, language)}`
                : ""}
            </p>
          </div>
          <div className="details">
            <DetailRow label={tx("家", "Home")}>
              {buildingName(world, resident.homeId, language)}
            </DetailRow>
            <DetailRow label={tx("工作", "Work")}>
              {buildingName(world, resident.workId, language)}
            </DetailRow>
            <DetailRow
              label={
                resident.journey
                  ? tx("出发于", "Departed")
                  : tx("下次出发", "Next departure")
              }
            >
              {formatClock(
                resident.journey?.startedAt ?? resident.nextDeparture,
              )}
            </DetailRow>
            <DetailRow label={tx("当前位置", "Current")}>
              {resident.atBuildingId
                ? buildingName(world, resident.atBuildingId, language)
                : statusName(resident.status, language)}
            </DetailRow>
            <DetailRow label={tx("目标", "Destination")}>
              {buildingName(world, destination, language)}
            </DetailRow>
            <DetailRow label={tx("方式", "Mode")}>
              {resident.journey
                ? resident.journey.mode === "pod"
                  ? "Pod"
                  : tx("步行", "Walk")
                : "—"}
            </DetailRow>
            <DetailRow label="ETA">
              {resident.journey?.eta !== undefined
                ? formatDuration(resident.journey.eta - world.time, language)
                : "—"}
            </DetailRow>
            <DetailRow label={tx("预计纯步行", "Expected walk")}>
              {resident.journey
                ? formatDuration(resident.journey.walkBaseline, language)
                : "—"}
            </DetailRow>
            {resident.journey?.waitReason && (
              <DetailRow label={tx("等待原因", "Wait reason")}>
                {waitReasonName(resident.journey.waitReason, language)}
              </DetailRow>
            )}
          </div>
          {previousTrip && (
            <div className="details">
              <DetailRow label={tx("上次门到门", "Last door-to-door")}>
                {previousTrip.mode === "pod" ? "Pod" : tx("步行", "Walk")} ·{" "}
                {formatDuration(
                  previousTrip.endedAt - previousTrip.startedAt,
                  language,
                )}
              </DetailRow>
              <DetailRow label={tx("同程纯步行", "Same trip on foot")}>
                {formatDuration(previousTrip.walkBaseline, language)}
              </DetailRow>
            </div>
          )}
          {resident.journey?.podId && (
            <button
              className="wide-action primary-action"
              type="button"
              onClick={() =>
                focus({ kind: "pod", id: resident.journey!.podId! })
              }
            >
              <LocateFixed size={15} />
              {tx(
                `跳到 Pod ${shortId(resident.journey.podId)}`,
                `Jump to Pod ${shortId(resident.journey.podId)}`,
              )}
            </button>
          )}
          <button
            className="wide-action"
            type="button"
            onClick={() => {
              setFocusTarget(undefined);
              window.requestAnimationFrame(() => setFocusTarget(selection));
              setDidFollowResident(true);
            }}
          >
            <Eye size={15} />
            {tx("在地图上追踪", "Follow on map")}
          </button>
        </>
      );
    }

    if (selection.kind === "pod") {
      const pod = world.pods.find((item) => item.id === selection.id)!;
      const passenger =
        pod.plan?.residentId && world.time < pod.plan.dropoffEnd!
          ? world.residents.find((item) => item.id === pod.plan?.residentId)
          : undefined;
      const segment = pod.plan?.segments.find(
        (s) => s.start <= world.time && s.end > world.time,
      );
      const podStatus = !pod.plan
        ? tx("停泊", "Parked")
        : world.time < pod.plan.departure
          ? tx("等待预约时隙", "Waiting for slot")
          : segment?.kind === "boarding"
            ? tx("乘客上车", "Boarding")
            : segment?.kind === "alighting"
              ? tx("乘客下车", "Alighting")
              : segment?.stage === "loaded"
                ? tx("载客运行", "In service")
                : passenger
                  ? tx("空车接近", "Empty to pickup")
                  : tx("空车调位", "Repositioning");
      return (
        <>
          <div className="inspector-heading entity-heading">
            <span className="eyebrow">POD · {shortId(pod.id)}</span>
            <h2>{podStatus}</h2>
            <p>
              {passenger
                ? `${tx("乘客", "Passenger")} · ${passenger.name}`
                : tx("当前无乘客", "No passenger aboard")}
            </p>
          </div>
          <div className="details">
            <DetailRow label={tx("行程", "Trips")}>{pod.trips}</DetailRow>
            <DetailRow label={tx("当前位置", "Position")}>
              {pod.berthId ? shortId(pod.berthId) : tx("轨道中", "On track")}
            </DetailRow>
            <DetailRow label="ETA">
              {pod.plan
                ? formatDuration(pod.plan.end - world.time, language)
                : "—"}
            </DetailRow>
            <DetailRow label={tx("最终泊位", "Final berth")}>
              {pod.plan
                ? shortId(pod.plan.finalBerthId)
                : pod.berthId
                  ? shortId(pod.berthId)
                  : "—"}
            </DetailRow>
          </div>
          {passenger && (
            <button
              className="wide-action primary-action"
              type="button"
              onClick={() => focus({ kind: "resident", id: passenger.id })}
            >
              <Users size={15} />
              {tx(
                `查看乘客 ${passenger.name}`,
                `View passenger ${passenger.name}`,
              )}
            </button>
          )}
          <button
            className="wide-action"
            type="button"
            onClick={() => {
              setFocusTarget(undefined);
              window.requestAnimationFrame(() => setFocusTarget(selection));
            }}
          >
            <LocateFixed size={15} />
            {tx("追踪这辆 Pod", "Follow this Pod")}
          </button>
          <button
            className="wide-action danger"
            type="button"
            disabled={!!pod.plan}
            onClick={() => send({ type: "sell-pod", id: pod.id })}
          >
            <Trash2 size={15} />
            {tx("回售 Pod · 85%", "Return Pod · 85%")}
          </button>
        </>
      );
    }

    const track = world.tracks.find((item) => item.id === selection.id)!;
    const resources = trackResources(world, track);
    const picked = world.tracks.filter((t) => selectedTrackIds.includes(t.id));
    const matching = world.reservations.filter(
      (item) =>
        item.end > world.time - 300 &&
        item.start < world.time + 300 &&
        resources.includes(item.resource),
    );
    const active = matching.some(
      (item) => item.start <= world.time && item.end > world.time,
    );
    const recentSeconds = matching.reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          Math.min(world.time, item.end) -
            Math.max(world.time - 300, item.start),
        ),
      0,
    );
    const pending = world.pendingEdits.some(
      (edit) => edit.type === "remove-track" && edit.id === track.id,
    );
    return (
      <>
        <div className="inspector-heading entity-heading">
          <span className="eyebrow">
            {tx("轨道", "TRACK")} · {shortId(track.id)}
          </span>
          <h2>
            {active
              ? tx("正在占用", "Occupied now")
              : tx("区间空闲", "Section clear")}
          </h2>
          <p>
            ({track.a.x}, {track.a.y}) → ({track.b.x}, {track.b.y})
          </p>
        </div>
        <SectionTitle>{tx("整段改造", "Corridor editing")}</SectionTitle>
        <p className="flow-legend">
          {tx(
            `已选 ${picked.length} 个小段 · 车道双向共享`,
            `Selected ${picked.length} cells · all lanes shared both ways`,
          )}
        </p>
        {([2, 3] as const).map((lanes) => {
          const upgradable = picked.filter(
            (t) =>
              (t.lanes ?? 1) < lanes &&
              !world.pendingEdits.some((edit) => edit.id === t.id),
          );
          const upgradeCost = upgradable.reduce(
            (sum, t) =>
              sum +
              distance(t.a, t.b) *
                TRACK_UPGRADE_COST *
                (lanes - (t.lanes ?? 1)),
            0,
          );
          return (
            <button
              key={lanes}
              className="wide-action primary-action"
              type="button"
              disabled={!upgradable.length || world.economy.cash < upgradeCost}
              onClick={() =>
                send({
                  type: "upgrade-tracks",
                  lanes,
                  ids: upgradable.map((t) => t.id),
                })
              }
            >
              {tx(
                `升级所选为 ${lanes} 车道 · ${Math.round(upgradeCost)}`,
                `Upgrade selection to ${lanes} lanes · ${Math.round(upgradeCost)}`,
              )}
            </button>
          );
        })}
        <p className="flow-legend">
          {tx(
            "所有车道均可双向使用；每条同一时刻只容一辆 Pod。系统分配空闲车道，交叉口仍需协调。",
            "Every lane is shared both ways, one Pod at a time. Dispatch assigns free lanes; crossings remain coordinated.",
          )}
        </p>
        <p className="flow-legend">
          {tx(
            "点击选整段 · ⌘/Ctrl 多选 · Shift 连选 · Alt 单格",
            "Click corridor · ⌘/Ctrl add · Shift range · Alt single cell",
          )}
        </p>
        {pending && (
          <div className="pending-note">
            <Activity size={14} />
            {tx(
              "等待既有行程排空后拆除。",
              "Waiting for existing journeys to clear.",
            )}
          </div>
        )}
        <div className="details">
          <DetailRow label={tx("近 5 分钟占用", "Last 5 min occupied")}>
            {formatDuration(recentSeconds, language)}
          </DetailRow>
          <DetailRow label={tx("前后 5 分钟预约", "±5 min reservations")}>
            {matching.length}
          </DetailRow>
          <DetailRow label={tx("建设价值", "Build value")}>
            {Math.round(track.paid)}
          </DetailRow>
        </div>
        <button
          className="wide-action danger"
          type="button"
          disabled={!removableTracks.length}
          onClick={removeSelectedTracks}
        >
          <Trash2 size={15} />
          {tx(
            `拆除所选 ${removableTracks.length} 段 · 退 ${Math.round(removalRefund)}`,
            `Remove ${removableTracks.length} selected · refund ${Math.round(removalRefund)}`,
          )}
        </button>
      </>
    );
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          title={tx("城市概览与名册", "City overview and directory")}
          onClick={() => {
            setSelection(null);
            setOverviewOpen(true);
            setInspectorHidden(false);
            setFocusTarget(undefined);
          }}
        >
          <Route size={17} />
          <span>
            FUTURE <b>/</b> TRANSIT
          </span>
        </button>
        <div className="time-cluster">
          <span
            className="sim-time"
            title={tx(
              "每 30 秒现实时间推进 10 分钟（1×）；车辆连续运行",
              "10 city minutes per 30 real seconds at 1x; continuous traffic",
            )}
          >
            <small>
              {tx(
                `第 ${Math.floor((world.time + 7 * 3600) / 86400) + 1} 天`,
                `Day ${Math.floor((world.time + 7 * 3600) / 86400) + 1}`,
              )}
            </small>{" "}
            {formatClock(world.time, 10)}
          </span>
          <span className={`run-state ${world.paused ? "paused" : ""}`}>
            {world.paused ? tx("已暂停", "Paused") : tx("运行中", "Running")}
          </span>
        </div>
        <div className="time-controls">
          <button
            className="round-button"
            type="button"
            onClick={() => send({ type: "pause", value: !world.paused })}
            title={world.paused ? tx("继续", "Resume") : tx("暂停", "Pause")}
          >
            {world.paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          {([1, 2, 4] as const).map((speed) => (
            <button
              className={`speed-button${world.speed === speed ? " is-active" : ""}`}
              type="button"
              key={speed}
              onClick={() => send({ type: "speed", value: speed })}
            >
              {speed}×
            </button>
          ))}
        </div>
        <div className="top-actions">
          <button
            className="language-button"
            type="button"
            onClick={() =>
              setLanguage((current) => (current === "zh" ? "en" : "zh"))
            }
          >
            <Languages size={14} />
            {language === "zh" ? "EN" : "中文"}
          </button>
          <button
            className={`round-button${settingsOpen ? " is-active" : ""}`}
            type="button"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
            title={tx("设置", "Settings")}
          >
            <Settings2 size={16} />
          </button>
        </div>
        {settingsOpen && (
          <aside className="settings-card">
            <div className="popover-title">
              <span>
                <Settings2 size={14} />
                {tx("城市设置", "City settings")}
              </span>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <label className="switch-row">
              <span>
                <strong>{tx("城市增长", "City growth")}</strong>
                <small>
                  {tx(
                    "暂停新增建筑与后续入驻",
                    "Pause new buildings and occupancy phases",
                  )}
                </small>
              </span>
              <input
                type="checkbox"
                checked={world.growth.enabled}
                onChange={(event) =>
                  send({ type: "growth", value: event.target.checked })
                }
              />
            </label>
            <p className="empty-line">
              {tx(
                "余额低于 3,000 时，每 30 分钟城市时间开放领取 280（最多保留一期）；新街区补助 900 可累积。所有补助需手动领取。维护最多使用票款的 20%。",
                "Below 3,000 cash: claim 280 every 30 city minutes (one pending installment). District grants of 900 accumulate. All grants must be claimed manually. Upkeep uses at most 20% of fares.",
              )}
            </p>
            <button
              className="wide-action"
              type="button"
              disabled={availableGrant <= 0}
              onClick={() => send({ type: "claim-grant" })}
            >
              {availableGrant > 0
                ? tx(
                    `领取补助 +${availableGrant}`,
                    `Claim grant +${availableGrant}`,
                  )
                : tx("暂无待领取补助", "No grant ready")}
            </button>
            {world.pendingEdits.length > 0 && (
              <button
                className="wide-action"
                type="button"
                onClick={() => send({ type: "cancel-edits" })}
              >
                {tx(
                  `取消待执行改造 · ${world.pendingEdits.length}`,
                  `Cancel pending edits · ${world.pendingEdits.length}`,
                )}
              </button>
            )}
            <button
              className="wide-action"
              type="button"
              onClick={() => {
                send({ type: "pause", value: true });
                setIntroOpen(true);
                setSettingsOpen(false);
              }}
            >
              {tx("这是什么游戏？", "What is FutureTransit?")}
            </button>
            <button
              className="wide-action"
              type="button"
              onClick={() => {
                setGuideDismissed(false);
                setGuideReplay(true);
                setGuideOpen(true);
                setSettingsOpen(false);
              }}
            >
              {tx("查看新手引导", "Show beginner guide")}
            </button>
            <div className="settings-actions">
              <button
                type="button"
                onClick={() => {
                  const saved = saveLocal(world);
                  setLocalMessage(
                    saved
                      ? tx("已保存到本机。", "Saved locally.")
                      : tx(
                          "本机存储不可用，请导出 JSON 备份。",
                          "Local storage unavailable. Export JSON instead.",
                        ),
                  );
                }}
              >
                <Save size={14} />
                {tx("本机保存", "Save local")}
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    const saved = loadLocal();
                    if (!saved)
                      setLocalMessage(
                        tx("没有找到本机存档。", "No local save found."),
                      );
                    else {
                      replaceWorld(saved);
                      setLocalMessage(
                        tx("已载入本机存档。", "Local save loaded."),
                      );
                    }
                  } catch (error) {
                    setLocalMessage(String(error));
                  }
                }}
              >
                <Undo2 size={14} />
                {tx("本机读取", "Load local")}
              </button>
              <button type="button" onClick={exportWorld}>
                <Download size={14} />
                {tx("导出 JSON", "Export JSON")}
              </button>
              <button type="button" onClick={() => importRef.current?.click()}>
                <FileUp size={14} />
                {tx("导入存档", "Import save")}
              </button>
            </div>
            <input
              ref={importRef}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              onChange={(event) => void importWorld(event.target.files?.[0])}
            />
            <button className="new-city" type="button" onClick={newCity}>
              {tx("新建城市…", "New city…")}
            </button>
            {localMessage && <p className="settings-message">{localMessage}</p>}
          </aside>
        )}
      </header>

      <section
        className={`workspace${inspectorHidden ? " inspector-collapsed" : ""}`}
      >
        <nav className="tool-rail" aria-label={tx("地图工具", "Map tools")}>
          <ToolButton
            active={tool === "select"}
            label={tx("查看", "View")}
            shortcut="V"
            icon={<MousePointer2 size={18} />}
            onClick={() => setTool("select")}
          />
          <ToolButton
            active={tool === "track"}
            label={tx("铺轨", "Track")}
            shortcut="T"
            icon={<Route size={18} />}
            onClick={() => setTool("track")}
          />
          <ToolButton
            active={tool === "remove"}
            label={tx("拆除", "Remove")}
            shortcut="X"
            icon={<Trash2 size={18} />}
            onClick={activateRemoval}
          />
          <span className="rail-spacer" />
          <button
            className="layer-button"
            type="button"
            title={tx("查看全城 (H)", "Fit city (H)")}
            onClick={() => {
              setFocusTarget(undefined);
              setMapResetToken((t) => t + 1);
            }}
          >
            <MapIcon size={18} />
            <span>{tx("全城", "Fit")}</span>
          </button>
          <button
            className={`layer-button${layer === "flow" ? " is-active" : ""}`}
            type="button"
            onClick={() =>
              setLayer((current) => (current === "life" ? "flow" : "life"))
            }
            title={tx("切换生活/流量图层", "Toggle life/flow layer")}
          >
            <Activity size={18} />
            <span>
              {layer === "life" ? tx("生活", "Life") : tx("流量", "Flow")}
            </span>
          </button>
        </nav>

        <section className="map-stage">
          <MapView
            world={world}
            selection={selection}
            onSelect={onSelect}
            tool={tool}
            draft={tool === "track" ? draft : []}
            onMapPoint={onMapPoint}
            onHoverPoint={onHoverPoint}
            candidateDraft={tool === "track" ? candidateDraft : []}
            candidateInvalid={
              !!candidateReview?.error ||
              (candidateReview?.cost ?? 0) > world.economy.cash
            }
            onFinishDraft={finishDraft}
            layer={layer}
            language={language}
            focusTarget={focusTarget}
            selectedTrackIds={
              selection?.kind === "track" ? selectedTrackIds : []
            }
            buildingFlow={flows}
            resetViewToken={mapResetToken}
          />
          {inspectorHidden && (
            <button
              className="inspection-reopen"
              type="button"
              onClick={() => setInspectorHidden(false)}
            >
              {tx("显示检查器", "Show inspector")} →
            </button>
          )}

          {!guideDismissed && (
            <aside className={`guide-card${guideOpen ? "" : " collapsed"}`}>
              <button
                className="guide-title"
                type="button"
                onClick={() => setGuideOpen((open) => !open)}
              >
                <span>
                  <MapIcon size={14} />
                  {tx("第一次接送", "FIRST SERVICE")}
                </span>
                {guideOpen ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
              </button>
              <button
                className="guide-dismiss"
                type="button"
                aria-label={tx("关闭新手引导", "Dismiss beginner guide")}
                onClick={dismissGuide}
              >
                <X size={13} />
              </button>
              {guideOpen && (
                <div className="guide-body">
                  {[
                    [
                      tx("给办公楼加一个平台", "Add a platform to the office"),
                      tx("选择一侧，平台费用 140", "Choose a side · costs 140"),
                    ],
                    [
                      tx("从住宅外侧接入轨道", "Connect from the home yard"),
                      tx(
                        "用 T 铺轨，Enter 确认",
                        "Press T to draw · Enter to build",
                      ),
                    ],
                    [
                      tx(
                        "恢复并追踪第一位居民",
                        "Resume and follow the first resident",
                      ),
                      tx(
                        "看 Pod 完成真实接送",
                        "Watch a Pod complete the trip",
                      ),
                    ],
                  ].map(([title, note], index) => (
                    <button
                      type="button"
                      className={`guide-step${guideDone[index] ? " done" : ""}`}
                      key={title}
                      onClick={() => selectGuideStep(index)}
                    >
                      <span className="step-index">
                        {guideDone[index] ? <Check size={12} /> : index + 1}
                      </span>
                      <span>
                        <strong>{title}</strong>
                        <small>{note}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          )}

          {tool === "remove" && (
            <div className="draft-card demolition-card">
              <span className="draft-icon">
                <Trash2 size={16} />
              </span>
              <div>
                <strong>
                  {tx(
                    `待拆 ${removableTracks.length} 段 · 退款 ${Math.round(removalRefund)}`,
                    `${removableTracks.length} selected · refund ${Math.round(removalRefund)}`,
                  )}
                </strong>
                <small>
                  {tx(
                    "点击选整段 · ⌘/Ctrl 多选 · Shift 连选",
                    "Click corridor · ⌘/Ctrl add · Shift range",
                  )}
                </small>
                <small>
                  {pendingSelectedCount
                    ? tx(
                        `${pendingSelectedCount} 段等待改造完成；恢复运行后排空。`,
                        `${pendingSelectedCount} pending; resume to clear existing traffic.`,
                      )
                    : tx(
                        "确认后拆除；在途车辆先排空。Esc 取消选择。",
                        "Confirm to remove; active traffic clears first. Esc clears selection.",
                      )}
                </small>
              </div>
              <button
                type="button"
                disabled={!removableTracks.length}
                onClick={removeSelectedTracks}
              >
                {tx("确认拆除", "Confirm removal")}
              </button>
            </div>
          )}
          {tool === "track" && (
            <div
              className={`draft-card${candidateReview?.error && candidateDraft.length > 1 ? " has-error" : ""}`}
            >
              <span className="draft-icon">
                <Route size={16} />
              </span>
              <div>
                <strong>
                  {candidateDraft.length < 2
                    ? tx(
                        "点击地图添加轨道点",
                        "Click the map to add track points",
                      )
                    : candidateReview?.error
                      ? language === "zh"
                        ? candidateReview.error
                        : candidateReview.errorEn
                      : tx(
                          `${candidateDraft.length > draft.length ? "预览 " : ""}${candidateReview?.edges.length ?? 0} 段 · ${Math.round(candidateReview?.cost ?? 0)}`,
                          `${candidateDraft.length > draft.length ? "Preview " : ""}${candidateReview?.edges.length ?? 0} cells · ${Math.round(candidateReview?.cost ?? 0)}`,
                        )}
                </strong>
                <small>
                  {tx(
                    "移动预览 · 点击固定 · Enter 建造 · Esc 取消",
                    "Move to preview · Click to pin · Enter build · Esc cancel",
                  )}
                </small>
              </div>
              <button
                type="button"
                disabled={draft.length < 2 || !!draftReview?.error}
                onClick={finishDraft}
              >
                {tx("确认", "Build")}
              </button>
            </div>
          )}

          {noticeVisible && (lastResult || localMessage) && (
            <div
              className={`result-toast ${!localMessage && lastResult?.ok === false ? "error" : ""}`}
              role="status"
            >
              {localMessage ??
                (lastResult
                  ? language === "zh"
                    ? lastResult.message
                    : lastResult.messageEn
                  : "")}
            </div>
          )}
        </section>

        <aside
          className={`inspector${overviewOpen ? " is-open" : ""}${inspectorHidden ? " is-hidden" : ""}`}
        >
          <div className="inspector-top">
            <span>{tx("检查器", "INSPECTOR")}</span>
            {(selection || overviewOpen) && (
              <button
                type="button"
                onClick={() => setInspectorHidden(true)}
                title={tx(
                  "收起面板，保留地图标记",
                  "Hide panel, keep map markers",
                )}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <div className="inspector-content">{renderInspector()}</div>
        </aside>
      </section>

      <footer className="statusbar">
        <div className="legend">
          <span>
            <i className="legend-person" />
            {tx("居民", "Resident")}
          </span>
          <span>
            <i className="legend-pod" />
            Pod
          </span>
          <span>
            <i className="legend-platform" />
            {tx("平台", "Platform")}
          </span>
          <span>
            <i className="legend-track" />
            {tx("轨道", "Track")}
          </span>
        </div>
        <div className="status-metrics">
          <span>
            <WalletCards size={14} />
            <small>{tx("预算", "Budget")}</small>
            <strong>{Math.floor(world.economy.cash)}</strong>
          </span>
          {availableGrant > 0 && (
            <button
              className="grant-claim"
              type="button"
              onClick={() => send({ type: "claim-grant" })}
            >
              {tx("领取补助", "Claim grant")} +{availableGrant}
            </button>
          )}
          <span>
            <Gauge size={14} />
            <small>{tx("服务占比", "Service")}</small>
            <strong>{Math.round(stats.serviceShare * 100)}%</strong>
          </span>
          <span>
            <Users size={14} />
            <small>{tx("候车", "Waiting")}</small>
            <strong>{stats.waiting}</strong>
          </span>
          <span>
            <Footprints size={14} />
            <small>{tx("已步行", "Walked")}</small>
            <strong>{stats.walked}</strong>
          </span>
        </div>
      </footer>
      {introOpen && (
        <Introduction
          language={language}
          onLanguageChange={() =>
            setLanguage((current) => (current === "zh" ? "en" : "zh"))
          }
          onDismiss={() => {
            rememberIntroSeen();
            setIntroOpen(false);
          }}
        />
      )}
    </main>
  );
}
