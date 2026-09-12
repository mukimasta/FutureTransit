import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banknote,
  Bot,
  Building2,
  Check,
  ChevronDown,
  CircleHelp,
  Coins,
  Gauge,
  Landmark,
  Languages,
  LoaderCircle,
  MapPin,
  Minus,
  MousePointer2,
  Network,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  TrainFront,
  Upload,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { createMapRenderer } from '../rendering';
import { CITY_NODES, ECONOMY } from '../scenarios/city';
import { draftStatus, hasCurrentTopology, pointForNode } from '../interaction';
import type {
  Command,
  CommandResult,
  EdgeView,
  Language,
  Localized,
  MapCallbacks,
  MapRenderer,
  MapState,
  MapTool,
  Mission,
  NodeView,
  Overlay,
  PortSide,
  Snapshot,
  TrackPoint,
} from '../shared/types';
import './app.css';

export interface AppProps {
  snapshot: Snapshot;
  onCommand: (command: Command) => Promise<CommandResult>;
  onSave: () => Promise<void>;
  onLoad: (file: File) => Promise<void>;
  onReset: () => Promise<void>;
}

type Toast = { id: number; tone: 'success' | 'error' | 'info'; text: string };
type Copy = Record<string, Localized>;

const copy: Copy = {
  select: { zh: '选择', en: 'Select' },
  build: { zh: '绘轨', en: 'Draw track' },
  junction: { zh: '枢纽', en: 'Junction' },
  addEntrance: { zh: '添加接入口', en: 'Add entrance' },
  entrance: { zh: '接入口', en: 'Entrance' },
  network: { zh: '网络', en: 'Network' },
  demand: { zh: '需求', en: 'Demand' },
  traffic: { zh: '交通', en: 'Traffic' },
  operation: { zh: '运营状态', en: 'Operations' },
  fare: { zh: '票价', en: 'Fare' },
  fleet: { zh: '车队', en: 'Fleet' },
  buyOne: { zh: '购买 1 辆', en: 'Buy 1 pod' },
  buyThree: { zh: '购买 3 辆', en: 'Buy 3 pods' },
  selected: { zh: '选中地点', en: 'Selected place' },
  selectedLine: { zh: '选中线路', en: 'Selected link' },
  noSelection: { zh: '在地图上选择楼宇或轨道', en: 'Select a building or track on the map' },
  queue: { zh: '候车', en: 'Queue' },
  served: { zh: '已服务', en: 'Served' },
  port: { zh: '停靠等级', en: 'Port level' },
  upgrade: { zh: '升级', en: 'Upgrade' },
  length: { zh: '长度', en: 'Length' },
  travel: { zh: '行程', en: 'Travel' },
  utilization: { zh: '利用率', en: 'Utilization' },
  trips: { zh: '行程数', en: 'Trips' },
  mission: { zh: '当前任务', en: 'Active mission' },
  reward: { zh: '奖励', en: 'Reward' },
  events: { zh: '城市动态', en: 'City notes' },
  openService: { zh: '开放服务', en: 'Open service' },
  serviceOpen: { zh: '服务已开放', en: 'Service open' },
  serviceClosed: { zh: '尚未开放服务', en: 'Service not open' },
  startEvent: { zh: '启动活动', en: 'Start event' },
  eventActive: { zh: '活动进行中', en: 'Event active' },
  eventLater: { zh: '活动稍后可用', en: 'Event available later' },
  pauseOrders: { zh: '暂停接单', en: 'Pause new orders' },
  resumeService: { zh: '恢复服务', en: 'Resume service' },
  welcomeTitle: { zh: '开始你的第一条线', en: 'Start your first route' },
  welcomeBody: { zh: '每栋楼宇都可以接入。', en: 'Every building can have an entrance.' },
  firstRoute: {
    zh: '点楼宇添加接入口，再在地图任意位置绘制轨道。',
    en: 'Click a building to add an entrance, then draw track anywhere.',
  },
  gotIt: { zh: '知道了', en: 'Got it' },
  restoreGuide: { zh: '显示起步提示', en: 'Show starter guide' },
  buildStart: { zh: '点地图开始绘轨', en: 'Click the map to start drawing' },
  buildNext: { zh: '继续点击添加拐点，Esc 取消', en: 'Click to add waypoints, Esc cancels' },
  buildPreview: { zh: '建造预览', en: 'Build preview' },
  cost: { zh: '造价', en: 'Cost' },
  bridge: { zh: '含跨河桥', en: 'Includes bridge' },
  recent: { zh: '近期动态', en: 'Recent activity' },
  help: { zh: '操作提示', en: 'Controls' },
  helpBody: {
    zh: '绘轨：点击楼宇、线路或空地。Enter 提交，Backspace 撤销一点，Esc 取消。',
    en: 'Draw: click a building, track, or ground. Enter commits, Backspace removes, Esc cancels.',
  },
  save: { zh: '保存', en: 'Save' },
  load: { zh: '读取', en: 'Load' },
  reset: { zh: '重开', en: 'Reset' },
  resetAsk: { zh: '删除当前本地进度？', en: 'Delete this local run?' },
  cancel: { zh: '取消', en: 'Cancel' },
  confirmReset: { zh: '确认重开', en: 'Reset run' },
  rendererLoading: { zh: '正在绘制城市地图…', en: 'Drawing city map…' },
  rendererError: { zh: '地图暂时无法载入', en: 'Map could not load' },
  stationDirectory: { zh: '楼宇目录', en: 'Buildings' },
  chooseFromList: { zh: '选择楼宇', en: 'Choose a building' },
  controls: { zh: '控制面板', en: 'Controls panel' },
  hideControls: { zh: '收起控制面板', en: 'Hide controls panel' },
  noMission: { zh: '暂无任务', en: 'No active mission' },
  unavailable: { zh: '当前不可用', en: 'Unavailable now' },
  buildNeedsCash: { zh: '资金不足，无法建造此线路', en: 'Not enough cash for this link' },
  saveDone: { zh: '进度已保存', en: 'Progress saved' },
  loadDone: { zh: '存档已读取', en: 'Save loaded' },
  resetDone: { zh: '已开始新的城市', en: 'New city started' },
  actionFailed: { zh: '操作未完成，请重试', en: 'Action could not be completed' },
  noRouteToOpen: { zh: '先铺设至少一段轨道', en: 'Lay at least one track first' },
  loading: { zh: '处理中…', en: 'Working…' },
  cash: { zh: '资金', en: 'Cash' },
  share: { zh: '出行份额', en: 'Mode share' },
  waiting: { zh: '候车人数', en: 'Waiting' },
  fit: { zh: '适配地图', en: 'Fit map' },
  zoomIn: { zh: '放大', en: 'Zoom in' },
  zoomOut: { zh: '缩小', en: 'Zoom out' },
  speed: { zh: '速度', en: 'Speed' },
  cityTime: { zh: '城市时间', en: 'City time' },
  play: { zh: '开始模拟', en: 'Play simulation' },
  pause: { zh: '暂停模拟', en: 'Pause simulation' },
  wait: { zh: '平均等待', en: 'Avg. wait' },
  satisfaction: { zh: '满意度', en: 'Satisfaction' },
  income: { zh: '收入', en: 'Revenue' },
  expense: { zh: '支出', en: 'Expenses' },
  seconds: { zh: '秒', en: 'sec' },
  routeSeconds: { zh: '秒', en: 'sec' },
  fleetPrompt: {
    zh: '请选择一栋非枢纽楼宇作为车队基地',
    en: 'Select a non-junction building as a fleet base',
  },
  bottleneckQueue: {
    zh: '候车积压：购买接驳舱或升级接入口。',
    en: 'Queue building: buy pods or upgrade an entrance.',
  },
  bottleneckEdge: {
    zh: '线路繁忙：升级高利用率线路。',
    en: 'Busy link: upgrade a high-utilization link.',
  },
  networkSteady: { zh: '网络运行平稳。', en: 'Network is running smoothly.' },
  eventIn: { zh: '下次活动', en: 'Next event' },
  eventLeft: { zh: '剩余时间', en: 'Time remaining' },
  missionComplete: { zh: '所有任务已完成', en: 'All missions complete' },
  missionCompleteBody: {
    zh: '青湾市已具备持续扩展的基础。',
    en: 'Bayhaven is ready for continued expansion.',
  },
  station: { zh: '楼宇', en: 'Building' },
  connected: { zh: '已连接', en: 'Connected' },
  disconnected: { zh: '未连接', en: 'Not connected' },
  draftCost: { zh: '预计', en: 'Estimate' },
  draftInvalid: { zh: '无法铺设', en: 'Cannot lay' },
  draftReady: { zh: '提交轨道', en: 'Commit track' },
  draftCancel: { zh: '取消绘轨', en: 'Cancel drawing' },
  removeTrack: { zh: '拆除轨道', en: 'Remove track' },
  side: { zh: '方向', en: 'Side' },
};

function byLanguage(value: Localized | undefined, language: Language, fallback = '') {
  return value?.[language] ?? fallback;
}
function money(value: number, language: Language) {
  return new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}
function clock(simTime: number) {
  const minutes = 450 + Math.floor(simTime / 60);
  return `${String(Math.floor((minutes / 60) % 24)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function percent(value: number) {
  return `${Math.round(value * (value <= 1 ? 100 : 1))}%`;
}

export default function App({ snapshot, onCommand, onSave, onLoad, onReset }: AppProps) {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem('future-transit-language');
      return saved === 'en' || saved === 'zh' ? saved : 'zh';
    } catch {
      return 'zh';
    }
  });
  const [tool, setTool] = useState<MapTool>('select');
  const [overlay, setOverlay] = useState<Overlay>('network');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [buildFrom, setBuildFrom] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrackPoint[]>([]);
  const [portSide, setPortSide] = useState<PortSide>('south');
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [guideVisible, setGuideVisible] = useState(true);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ tool, buildFrom, selectedNode, selectedEdge, draft });
  stateRef.current = { tool, buildFrom, selectedNode, selectedEdge, draft };
  const tr = useCallback((key: keyof typeof copy) => byLanguage(copy[key], language), [language]);

  const pushToast = useCallback(
    (tone: Toast['tone'], message?: Localized | string) => {
      const text =
        typeof message === 'string' ? message : byLanguage(message, language, tr('actionFailed'));
      const id = Date.now() + Math.random();
      setToasts((items) => [...items, { id, tone, text }]);
      window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3800);
    },
    [language, tr],
  );

  const invoke = useCallback(
    async (command: Command, key: string = command.type) => {
      setBusy(key);
      try {
        const result = await onCommand(command);
        if (!result.ok) {
          pushToast('error', result.message ?? copy.actionFailed);
          return false;
        }
        if (result.message) pushToast('success', result.message);
        return true;
      } catch {
        pushToast('error', copy.actionFailed);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [onCommand, pushToast],
  );

  const commitDraft = useCallback(
    async (points: TrackPoint[]) => {
      if (points.length < 2) return;
      const result = draftStatus(snapshot, points);
      if (result.kind === 'invalid') {
        pushToast('error', result.message);
        return;
      }
      if (result.kind !== 'valid') return;
      if (await invoke({ type: 'drawTrack', points }, 'drawTrack')) {
        setDraft([]);
        setBuildFrom(null);
        setSelectedEdge(null);
      }
    },
    [invoke, pushToast, snapshot],
  );

  const onNodeClick = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const target = snapshot.nodes.find((item) => item.id === id);
      if (current.tool !== 'build') {
        setSelectedNode(id);
        setSelectedEdge(null);
        return;
      }
      if (!target?.portBuilt) {
        setSelectedNode(id);
        setSelectedEdge(null);
        return;
      }
      const point = pointForNode(snapshot, id);
      if (!point) return;
      if (!current.draft.length) {
        setDraft([point]);
        setBuildFrom(id);
        setSelectedNode(id);
        setSelectedEdge(null);
        return;
      }
      if (current.draft.at(-1)?.nodeId === id) return;
      const next = [...current.draft, point];
      setDraft(next);
      setBuildFrom(id);
      setSelectedNode(id);
      setSelectedEdge(null);
      void commitDraft(next);
    },
    [commitDraft, snapshot],
  );
  const onEdgeClick = useCallback((id: string, point?: { x: number; y: number }) => {
    const current = stateRef.current;
    if (current.tool !== 'build' || !point) {
      setSelectedEdge(id);
      setSelectedNode(null);
      return;
    }
    const next = [...current.draft, { ...point, edgeId: id }];
    setDraft(next);
    setBuildFrom(null);
    setSelectedEdge(null);
  }, []);
  const onBackgroundClick = useCallback((point?: { x: number; y: number }) => {
    const current = stateRef.current;
    if (current.tool === 'build' && point) {
      setDraft([...current.draft, { ...point }]);
      setBuildFrom(null);
      setSelectedNode(null);
      setSelectedEdge(null);
      return;
    }
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);
  const callbacksRef = useRef<MapCallbacks>({
    onNodeClick,
    onEdgeClick,
    onBackgroundClick,
    onHoverNode: setHoverNode,
  });
  callbacksRef.current = { onNodeClick, onEdgeClick, onBackgroundClick, onHoverNode: setHoverNode };

  useEffect(() => {
    let alive = true;
    if (!hostRef.current) return;
    void createMapRenderer(hostRef.current, {
      onNodeClick: (id) => callbacksRef.current.onNodeClick(id),
      onEdgeClick: (id, point) => callbacksRef.current.onEdgeClick(id, point),
      onBackgroundClick: (point) => callbacksRef.current.onBackgroundClick(point),
      onHoverNode: (id) => callbacksRef.current.onHoverNode?.(id),
    })
      .then((renderer) => {
        if (!alive) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        setMapStatus('ready');
      })
      .catch(() => {
        if (alive) setMapStatus('error');
      });
    return () => {
      alive = false;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.update({
      snapshot,
      language,
      tool,
      overlay,
      selectedNode,
      selectedEdge,
      buildFrom,
      draft,
    });
  }, [snapshot, language, tool, overlay, selectedNode, selectedEdge, buildFrom, draft, mapStatus]);
  useEffect(() => {
    if (draft.length && !hasCurrentTopology(snapshot, draft)) {
      setDraft([]);
      setBuildFrom(null);
    }
  }, [snapshot, draft]);
  useEffect(() => {
    try {
      localStorage.setItem('future-transit-language', language);
    } catch {
      /* Storage is optional. */
    }
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = language === 'zh' ? '未来交通 · Future Transit' : 'Future Transit · 未来交通';
  }, [language]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.matches('input, textarea, select, button')) return;
      if (event.key === 'Escape') {
        setDraft([]);
        setBuildFrom(null);
      }
      if (event.key === 'Backspace' && stateRef.current.draft.length) {
        event.preventDefault();
        setDraft((items) => items.slice(0, -1));
      }
      if (event.key === 'Enter' && stateRef.current.draft.length >= 2) {
        event.preventDefault();
        void commitDraft(stateRef.current.draft);
      }
      if (event.key.toLowerCase() === 'b') setTool('build');
      if (event.key === ' ') {
        event.preventDefault();
        void invoke({ type: 'setRunning', value: !snapshot.running }, 'running');
      }
      if (event.key === '1' || event.key === '2' || event.key === '3')
        void invoke(
          { type: 'setSpeed', value: ([1, 3, 8] as const)[Number(event.key) - 1] },
          'speed',
        );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commitDraft, invoke, snapshot.running]);

  const node = selectedNode
    ? (snapshot.nodes.find((item) => item.id === selectedNode) ?? null)
    : null;
  const nodeView = node ?? undefined;
  const edge = selectedEdge ? snapshot.edges.find((item) => item.id === selectedEdge) : undefined;
  const draftPreview = useMemo(() => draftStatus(snapshot, draft), [snapshot, draft]);
  const activeMission = snapshot.missions.find((mission) => !mission.completed);
  const canOpen = !snapshot.serviceOpen && snapshot.edges.length > 0;
  const canResume = !snapshot.serviceOpen && snapshot.missions[0]?.completed === true;
  const canStartEvent =
    snapshot.serviceOpen && !snapshot.cityEvent.active && snapshot.cityEvent.nextIn <= 0;
  const fleetBaseAllowed = !!node && node.kind !== 'junction' && node.portBuilt;
  const congestion = snapshot.edges.some((item) => item.utilization >= 0.8);
  const problemHint =
    snapshot.metrics.waiting >= Math.max(4, snapshot.pods.length)
      ? tr('bottleneckQueue')
      : congestion
        ? tr('bottleneckEdge')
        : tr('networkSteady');

  const switchTool = (next: MapTool) => {
    setTool(next);
    if (next !== 'build') {
      setBuildFrom(null);
      setDraft([]);
    }
  };
  const chooseDirectoryNode = (id: string) => {
    setSelectedNode(id);
    setSelectedEdge(null);
    setDirectoryOpen(false);
    if (tool === 'build') onNodeClick(id);
  };
  const runSave = async () => {
    setBusy('save');
    try {
      await onSave();
      pushToast('success', copy.saveDone);
    } catch {
      pushToast('error', copy.actionFailed);
    } finally {
      setBusy(null);
    }
  };
  const runLoad = async (file: File) => {
    setBusy('load');
    try {
      await onLoad(file);
      setDraft([]);
      setBuildFrom(null);
      setSelectedNode(null);
      setSelectedEdge(null);
      pushToast('success', copy.loadDone);
    } catch {
      pushToast('error', copy.actionFailed);
    } finally {
      setBusy(null);
    }
  };
  const runReset = async () => {
    setBusy('reset');
    try {
      await onReset();
      setResetOpen(false);
      setDraft([]);
      setBuildFrom(null);
      setSelectedNode(null);
      setSelectedEdge(null);
      pushToast('success', copy.resetDone);
    } catch {
      pushToast('error', copy.actionFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="game-shell">
      <header className="game-header">
        <div className="brand">
          <TrainFront aria-hidden="true" size={18} />
          <span>FUTURE TRANSIT</span>
          <i>/</i>
          <span className="brand-cn">未来交通</span>
          <em>{byLanguage(CITY_NAME_SAFE, language)}</em>
        </div>
        <div className="header-metrics" aria-label={tr('operation')}>
          <Metric icon={<Banknote />} label={tr('cash')} value={money(snapshot.cash, language)} />
          <Metric
            icon={<Users />}
            label={tr('served')}
            value={snapshot.metrics.served.toLocaleString()}
          />
          <Metric
            icon={<Gauge />}
            label={tr('share')}
            value={percent(snapshot.metrics.marketShare)}
          />
        </div>
        <button
          className="language-button"
          data-testid="lang-toggle"
          onClick={() => setLanguage((value) => (value === 'zh' ? 'en' : 'zh'))}
          aria-label={language === 'zh' ? 'Switch language to English' : '切换至中文'}
        >
          <Languages size={16} />
          {language === 'zh' ? 'EN' : '中'}
        </button>
      </header>

      <section className="game-layout">
        <aside className="control-rail">
          <section className="operation-card">
            <div className="eyebrow">
              <span>{tr('operation')}</span>
              <span className={snapshot.serviceOpen ? 'status live' : 'status'}>
                {snapshot.serviceOpen ? tr('serviceOpen') : tr('serviceClosed')}
              </span>
            </div>
            <div className="tool-switch" role="group" aria-label={tr('operation')}>
              <button
                className={tool === 'select' ? 'active' : ''}
                onClick={() => switchTool('select')}
                aria-pressed={tool === 'select'}
              >
                <MousePointer2 size={15} />
                {tr('select')}
              </button>
              <button
                data-testid="tool-build"
                className={tool === 'build' ? 'active' : ''}
                onClick={() => switchTool('build')}
                aria-pressed={tool === 'build'}
              >
                <Network size={15} />
                {tr('build')}
              </button>
            </div>
            <div className="build-state" aria-live="polite">
              <Zap size={14} />
              {tool === 'build'
                ? draft.length
                  ? tr('buildNext')
                  : tr('buildStart')
                : tr('noSelection')}
            </div>
            <label className="fare-control">
              <span>
                {tr('fare')} <strong>{money(snapshot.fare, language)}</strong>
              </span>
              <input
                type="range"
                min="1"
                max="12"
                step="1"
                value={snapshot.fare}
                onChange={(event) =>
                  void invoke({ type: 'setFare', value: Number(event.target.value) }, 'fare')
                }
                aria-label={tr('fare')}
              />
            </label>
            <button
              data-testid="service-orders-toggle"
              className="open-service"
              disabled={busy !== null || (!snapshot.serviceOpen && !canResume && !canOpen)}
              title={
                !snapshot.serviceOpen && !canResume && !canOpen ? tr('noRouteToOpen') : undefined
              }
              onClick={() =>
                void invoke(
                  snapshot.serviceOpen ? { type: 'closeService' } : { type: 'openService' },
                  'service',
                )
              }
            >
              <Play size={14} />
              {snapshot.serviceOpen
                ? tr('pauseOrders')
                : canResume
                  ? tr('resumeService')
                  : tr('openService')}
            </button>
            <div className="ops-grid">
              <span>
                {tr('waiting')}
                <b>{snapshot.metrics.waiting}</b>
              </span>
              <span>
                {tr('wait')}
                <b>
                  {snapshot.metrics.averageWait}
                  {tr('seconds')}
                </b>
              </span>
              <span>
                {tr('satisfaction')}
                <b>{snapshot.metrics.satisfaction}%</b>
              </span>
              <span>
                {tr('income')}
                <b>{money(snapshot.metrics.revenue, language)}</b>
              </span>
              <span>
                {tr('expense')}
                <b>{money(snapshot.metrics.expenses, language)}</b>
              </span>
            </div>
            <div className="trend" aria-label={tr('served')}>
              {snapshot.history.slice(-12).map((point) => (
                <i
                  key={point.time}
                  style={{
                    height: `${Math.max(12, Math.min(100, point.served ? (point.served / Math.max(1, snapshot.metrics.served)) * 100 : 12))}%`,
                  }}
                />
              ))}
            </div>
            <p className="problem-hint">{problemHint}</p>
          </section>

          <section className="compact-card fleet-card">
            <div className="section-title">
              <Bot size={16} />
              <span>{tr('fleet')}</span>
              <small>{snapshot.pods.length}</small>
            </div>
            <p>
              {fleetBaseAllowed
                ? language === 'zh'
                  ? `接驳舱每辆 ${money(ECONOMY.podCost, language)}`
                  : `${money(ECONOMY.podCost, language)} per pod`
                : tr('fleetPrompt')}
            </p>
            <div className="button-pair">
              <button
                disabled={!fleetBaseAllowed || snapshot.cash < ECONOMY.podCost || busy !== null}
                onClick={() =>
                  selectedNode &&
                  void invoke({ type: 'buyPods', nodeId: selectedNode, count: 1 }, 'pods')
                }
                title={!fleetBaseAllowed ? tr('fleetPrompt') : undefined}
              >
                <Plus size={14} />
                {tr('buyOne')}
              </button>
              <button
                disabled={!fleetBaseAllowed || snapshot.cash < ECONOMY.podCost * 3 || busy !== null}
                onClick={() =>
                  selectedNode &&
                  void invoke({ type: 'buyPods', nodeId: selectedNode, count: 3 }, 'pods')
                }
                title={!fleetBaseAllowed ? tr('fleetPrompt') : undefined}
              >
                <Plus size={14} />
                {tr('buyThree')}
              </button>
            </div>
          </section>

          <DetailsPanel
            language={language}
            t={tr}
            node={node}
            nodeView={nodeView}
            edge={edge}
            nodes={snapshot.nodes}
            cash={snapshot.cash}
            busy={busy}
            invoke={invoke}
          />
          <MissionCard mission={activeMission} language={language} t={tr} />

          <section className="compact-card event-card">
            <div className="section-title">
              <Sparkles size={16} />
              <span>{snapshot.cityEvent.active ? tr('eventActive') : tr('events')}</span>
            </div>
            <strong>{byLanguage(snapshot.cityEvent.title, language)}</strong>
            <p>{byLanguage(snapshot.cityEvent.description, language)}</p>
            <div className="event-timer">
              <span>{snapshot.cityEvent.active ? tr('eventLeft') : tr('eventIn')}</span>
              <b>
                {Math.ceil(
                  (snapshot.cityEvent.active
                    ? snapshot.cityEvent.remaining
                    : snapshot.cityEvent.nextIn) / 60,
                )}{' '}
                {language === 'zh' ? '分钟' : 'min'}
              </b>
            </div>
            <button
              data-testid="start-event"
              disabled={!canStartEvent || busy !== null}
              title={
                !canStartEvent
                  ? snapshot.cityEvent.active
                    ? tr('eventActive')
                    : tr('eventLater')
                  : undefined
              }
              onClick={() => void invoke({ type: 'startEvent' }, 'event')}
            >
              <Sparkles size={14} />
              {tr('startEvent')}
            </button>
          </section>

          <section className="notice-list">
            <div className="section-title">
              <Landmark size={16} />
              <span>{tr('recent')}</span>
            </div>
            {snapshot.notices.slice(0, 3).map((notice) => (
              <p key={notice.id} className={`notice ${notice.tone}`}>
                <b>{byLanguage(notice.title, language)}</b>
                {byLanguage(notice.text, language)}
              </p>
            ))}
          </section>
          <div className="panel-utilities" aria-label={tr('controls')}>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void runLoad(file);
                event.currentTarget.value = '';
              }}
              hidden
            />
            <button
              data-testid="save-game"
              disabled={busy !== null}
              onClick={() => void runSave()}
              title={tr('save')}
            >
              <Save size={14} />
              <span>{tr('save')}</span>
            </button>
            <button
              data-testid="load-game"
              disabled={busy !== null}
              onClick={() => fileRef.current?.click()}
              title={tr('load')}
            >
              <Upload size={14} />
              <span>{tr('load')}</span>
            </button>
            <button
              data-testid="reset-game"
              className="reset-button"
              disabled={busy !== null}
              onClick={() => setResetOpen(true)}
              title={tr('reset')}
            >
              <RotateCcw size={14} />
              <span>{tr('reset')}</span>
            </button>
          </div>
        </aside>

        <section className={`map-stage ${railOpen ? 'rail-open' : ''}`}>
          <div
            className="map-host"
            ref={hostRef}
            data-testid="free-canvas"
            data-free-canvas="true"
            aria-label={language === 'zh' ? '青湾市自由绘轨地图' : 'Bayhaven free track canvas'}
          />
          {mapStatus !== 'ready' && (
            <div className={`map-message ${mapStatus}`}>
              <LoaderCircle className={mapStatus === 'loading' ? 'spin' : ''} />
              <span>{mapStatus === 'loading' ? tr('rendererLoading') : tr('rendererError')}</span>
            </div>
          )}
          <button
            className="rail-toggle"
            onClick={() => setRailOpen((value) => !value)}
            aria-label={railOpen ? tr('hideControls') : tr('controls')}
            aria-expanded={railOpen}
          >
            <SlidersHorizontal size={16} />
          </button>
          <div
            className="map-tabs"
            role="tablist"
            aria-label={language === 'zh' ? '地图图层' : 'Map layer'}
          >
            {(['network', 'demand', 'traffic'] as const).map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={overlay === item}
                className={overlay === item ? 'active' : ''}
                onClick={() => setOverlay(item)}
                title={tr(item)}
                aria-label={tr(item)}
              >
                {item === 'network' ? (
                  <Network size={15} />
                ) : item === 'demand' ? (
                  <Users size={15} />
                ) : (
                  <Gauge size={15} />
                )}
              </button>
            ))}
          </div>
          <div className="mission-chip">
            <Sparkles size={14} />
            {activeMission ? (
              <>
                <strong>{byLanguage(activeMission.title, language)}</strong>
                <i
                  style={{
                    width: `${Math.min(100, activeMission.target ? (activeMission.progress / activeMission.target) * 100 : 0)}%`,
                  }}
                />
              </>
            ) : (
              <strong>{tr('missionComplete')}</strong>
            )}
          </div>
          <button
            className={`event-chip ${snapshot.cityEvent.active ? 'active' : ''}`}
            onClick={() => setRailOpen(true)}
            title={byLanguage(snapshot.cityEvent.title, language)}
          >
            <Sparkles size={14} />
            <span>
              {Math.ceil(
                (snapshot.cityEvent.active
                  ? snapshot.cityEvent.remaining
                  : snapshot.cityEvent.nextIn) / 60,
              )}
              m
            </span>
          </button>
          {(node || edge) && (
            <div className="context-card">
              <DetailsPanel
                language={language}
                t={tr}
                node={node}
                nodeView={nodeView}
                edge={edge}
                nodes={snapshot.nodes}
                cash={snapshot.cash}
                busy={busy}
                invoke={invoke}
              />
              {node && !node.portBuilt && node.kind !== 'junction' && (
                <div className="port-picker">
                  <span>
                    {tr('entrance')} · {money(ECONOMY.portCost, language)}
                  </span>
                  <div role="group" aria-label={tr('side')}>
                    {(['north', 'east', 'south', 'west'] as PortSide[]).map((side) => (
                      <button
                        key={side}
                        className={portSide === side ? 'active' : ''}
                        disabled={busy !== null || snapshot.cash < ECONOMY.portCost}
                        onClick={() => setPortSide(side)}
                      >
                        {side[0].toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <button
                    disabled={busy !== null || snapshot.cash < ECONOMY.portCost}
                    onClick={() =>
                      void invoke({ type: 'addPort', nodeId: node.id, side: portSide }, 'port')
                    }
                  >
                    {tr('addEntrance')}
                  </button>
                </div>
              )}
              {node?.portBuilt && node.kind !== 'junction' && (
                <div className="context-fleet">
                  <span>
                    <Bot size={14} />
                    {tr('fleet')}
                  </span>
                  <button
                    disabled={snapshot.cash < ECONOMY.podCost || busy !== null}
                    onClick={() =>
                      void invoke({ type: 'buyPods', nodeId: node.id, count: 1 }, 'pods')
                    }
                  >
                    <Plus size={13} />1
                  </button>
                  <button
                    disabled={snapshot.cash < ECONOMY.podCost * 3 || busy !== null}
                    onClick={() =>
                      void invoke({ type: 'buyPods', nodeId: node.id, count: 3 }, 'pods')
                    }
                  >
                    <Plus size={13} />3
                  </button>
                </div>
              )}
            </div>
          )}
          {draftPreview.kind !== 'idle' && (
            <div
              className={`draft-status ${draftPreview.kind}`}
              data-testid="track-draft-status"
              aria-live="polite"
            >
              <span>
                {draftPreview.kind === 'valid'
                  ? tr('draftCost')
                  : draftPreview.kind === 'invalid'
                    ? tr('draftInvalid')
                    : tr('buildNext')}
              </span>
              {draftPreview.kind === 'valid' && (
                <>
                  <strong>{money(draftPreview.plan.cost, language)}</strong>
                  <button
                    data-testid="commit-track"
                    disabled={busy !== null}
                    onClick={() => void commitDraft(draft)}
                    title={tr('draftReady')}
                  >
                    <Check size={15} />
                  </button>
                </>
              )}
              {draftPreview.kind === 'invalid' && (
                <small>{byLanguage(draftPreview.message, language)}</small>
              )}
              <button
                data-testid="cancel-track"
                onClick={() => {
                  setDraft([]);
                  setBuildFrom(null);
                }}
                title={tr('draftCancel')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {guideVisible && !snapshot.serviceOpen && !draft.length && (
            <div className="welcome-card">
              <MapPin size={15} />
              <span>{tr('firstRoute')}</span>
              <button
                className="close"
                onClick={() => setGuideVisible(false)}
                aria-label={tr('gotIt')}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="map-zoom">
            <button onClick={() => rendererRef.current?.zoomBy(1.16)} aria-label={tr('zoomIn')}>
              <Plus size={16} />
            </button>
            <button onClick={() => rendererRef.current?.zoomBy(0.86)} aria-label={tr('zoomOut')}>
              <Minus size={16} />
            </button>
            <button onClick={() => rendererRef.current?.resetCamera()} aria-label={tr('fit')}>
              <RotateCcw size={15} />
            </button>
          </div>
          <div className="utility-dock">
            <button
              onClick={() => setGuideVisible(true)}
              title={tr('restoreGuide')}
              aria-label={tr('restoreGuide')}
            >
              <CircleHelp size={16} />
            </button>
            <button onClick={() => setHelpOpen((value) => !value)} aria-expanded={helpOpen}>
              <CircleHelp size={16} />
              {tr('help')}
            </button>
            {helpOpen && <p>{tr('helpBody')}</p>}
          </div>
          <details
            className="station-directory"
            open={directoryOpen}
            onToggle={(event) => setDirectoryOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              <Building2 size={15} />
              {tr('stationDirectory')}
              <ChevronDown size={15} />
            </summary>
            <p>{tr('chooseFromList')}</p>
            <div>
              {CITY_NODES.map((item) => (
                <button
                  key={item.id}
                  data-node-id={item.id}
                  className={selectedNode === item.id ? 'active' : ''}
                  onClick={() => chooseDirectoryNode(item.id)}
                >
                  <span>{byLanguage(item.name, language)}</span>
                  <small>
                    {snapshot.nodes.find((view) => view.id === item.id)?.connected
                      ? tr('connected')
                      : tr('disconnected')}
                  </small>
                </button>
              ))}
            </div>
          </details>
        </section>
      </section>

      <footer className="time-bar">
        <div className="transport-controls">
          <button
            className={tool === 'select' ? 'active' : ''}
            onClick={() => switchTool('select')}
            title={tr('select')}
          >
            <MousePointer2 size={17} />
          </button>
          <button
            data-testid="tool-build"
            className={tool === 'build' ? 'active' : ''}
            onClick={() => switchTool('build')}
            title={tr('build')}
          >
            <Network size={17} />
          </button>
          <button
            data-testid="open-service"
            className="service-action"
            disabled={!canOpen || busy !== null}
            title={
              snapshot.serviceOpen
                ? tr('serviceOpen')
                : !canOpen
                  ? tr('noRouteToOpen')
                  : tr('openService')
            }
            onClick={() => void invoke({ type: 'openService' }, 'service')}
          >
            <Play size={15} />
            <span>{snapshot.serviceOpen ? tr('serviceOpen') : tr('openService')}</span>
          </button>
          <button
            data-testid="toggle-play"
            onClick={() => void invoke({ type: 'setRunning', value: !snapshot.running }, 'running')}
            aria-label={snapshot.running ? tr('pause') : tr('play')}
          >
            {snapshot.running ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button
            className="speed-cycle"
            onClick={() =>
              void invoke(
                {
                  type: 'setSpeed',
                  value: snapshot.speed === 1 ? 3 : snapshot.speed === 3 ? 8 : 1,
                },
                'speed',
              )
            }
          >
            {snapshot.speed}×
          </button>
        </div>
        <div className="city-clock">
          <strong>{clock(snapshot.simTime)}</strong>
        </div>
      </footer>
      {resetOpen && (
        <div className="confirm-popover" role="dialog" aria-modal="true" aria-label={tr('reset')}>
          <p>{tr('resetAsk')}</p>
          <div>
            <button onClick={() => setResetOpen(false)}>{tr('cancel')}</button>
            <button className="danger" onClick={() => void runReset()}>
              {tr('confirmReset')}
            </button>
          </div>
        </div>
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.tone === 'success' ? <Check size={16} /> : <X size={16} />}
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </main>
  );
}

const CITY_NAME_SAFE: Localized = { zh: '青湾市', en: 'Bayhaven' };

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailsPanel({
  language,
  t,
  node,
  nodeView,
  edge,
  nodes,
  cash,
  busy,
  invoke,
}: {
  language: Language;
  t: (key: keyof typeof copy) => string;
  node: NodeView | null;
  nodeView?: NodeView;
  edge?: EdgeView;
  nodes: NodeView[];
  cash: number;
  busy: string | null;
  invoke: (command: Command, key?: string) => Promise<boolean>;
}) {
  if (node && nodeView) {
    const canUpgrade =
      nodeView.portBuilt && nodeView.portLevel < 3 && cash >= ECONOMY.portUpgradeCost;
    return (
      <section className="details-card" data-node-id={node.id}>
        <div className="section-title">
          <MapPin size={16} />
          <span>{t('selected')}</span>
        </div>
        <h3>{byLanguage(node.name, language)}</h3>
        <div className="stat-grid">
          <span>
            {t('queue')}
            <b>{nodeView.queue}</b>
          </span>
          <span>
            {t('served')}
            <b>{nodeView.served}</b>
          </span>
          <span>
            {t('port')}
            <b>{nodeView.portBuilt ? nodeView.portLevel : '–'}</b>
          </span>
          <span>
            {t('connected')}
            <b>{nodeView.connected ? '●' : '–'}</b>
          </span>
        </div>
        <button
          disabled={busy !== null || !canUpgrade}
          title={
            !nodeView.portBuilt
              ? t('addEntrance')
              : cash < ECONOMY.portUpgradeCost
                ? t('buildNeedsCash')
                : undefined
          }
          onClick={() => void invoke({ type: 'upgradePort', nodeId: node.id }, 'upgradePort')}
        >
          <Zap size={14} />
          {t('upgrade')} · {money(ECONOMY.portUpgradeCost, language)}
        </button>
      </section>
    );
  }
  if (edge) {
    const from = nodes.find((item) => item.id === edge.from),
      to = nodes.find((item) => item.id === edge.to);
    return (
      <section className="details-card">
        <div className="section-title">
          <Network size={16} />
          <span>{t('selectedLine')}</span>
        </div>
        <h3>
          {byLanguage(from?.name, language, edge.from)} <i>→</i>{' '}
          {byLanguage(to?.name, language, edge.to)}
        </h3>
        <div className="stat-grid">
          <span>
            {t('length')}
            <b>{Math.round(edge.length)}m</b>
          </span>
          <span>
            {t('travel')}
            <b>
              {edge.travelTime} {t('routeSeconds')}
            </b>
          </span>
          <span>
            {t('utilization')}
            <b>{percent(edge.utilization)}</b>
          </span>
          <span>
            {t('trips')}
            <b>{edge.trips}</b>
          </span>
        </div>
        <button
          disabled={busy !== null || edge.level >= 3 || cash < ECONOMY.edgeUpgradeCost}
          title={cash < ECONOMY.edgeUpgradeCost ? t('buildNeedsCash') : undefined}
          onClick={() => void invoke({ type: 'upgradeEdge', edgeId: edge.id }, 'upgradeEdge')}
        >
          <Zap size={14} />
          {t('upgrade')} · {money(ECONOMY.edgeUpgradeCost, language)}
        </button>
        <button
          className="remove-track"
          disabled={busy !== null}
          onClick={() => void invoke({ type: 'removeEdge', edgeId: edge.id }, 'removeEdge')}
        >
          <X size={14} />
          {t('removeTrack')}
        </button>
      </section>
    );
  }
  return (
    <section className="details-card empty">
      <div className="section-title">
        <MapPin size={16} />
        <span>{t('selected')}</span>
      </div>
      <p>{t('noSelection')}</p>
    </section>
  );
}

function MissionCard({
  mission,
  language,
  t,
}: {
  mission?: Mission;
  language: Language;
  t: (key: keyof typeof copy) => string;
}) {
  if (!mission)
    return (
      <section className="mission-card">
        <div className="section-title">
          <Sparkles size={16} />
          <span>{t('mission')}</span>
        </div>
        <h3>{t('missionComplete')}</h3>
        <p>{t('missionCompleteBody')}</p>
      </section>
    );
  const ratio = Math.min(1, mission.target ? mission.progress / mission.target : 0);
  return (
    <section className="mission-card">
      <div className="section-title">
        <Sparkles size={16} />
        <span>{t('mission')}</span>
        <small>{money(mission.reward, language)}</small>
      </div>
      <h3>{byLanguage(mission.title, language)}</h3>
      <p>{byLanguage(mission.description, language)}</p>
      <div className="progress">
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="progress-caption">
        <span>
          {mission.progress}/{mission.target}
        </span>
        <span>
          {t('reward')} {money(mission.reward, language)}
        </span>
      </div>
    </section>
  );
}
