import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { DISTRICTS, WORLD, connectionInfo } from '../scenarios/city';
import type {
  Language,
  MapCallbacks,
  MapRenderer,
  MapState,
  NodeView,
  PodView,
} from '../shared/types';
import { buildingBox, paintBuilding } from './buildings';

const C = {
  paper: 0xf1f0e8,
  ink: 0x34483f,
  road: 0xe5dfd0,
  roadEdge: 0xd6cebd,
  water: 0x91bdba,
  waterEdge: 0x6b9f9d,
  park: 0xb7c7ae,
  teal: 0x207f80,
  orange: 0xd77945,
  gold: 0xe5a84c,
  shadow: 0x9a8e7a,
  roof: 0x87776a,
};
type Point = { x: number; y: number };
type PodSprite = {
  graphic: Graphics;
  current: Point;
  target: Point;
  angle: number;
  targetAngle: number;
  status: PodView['status'];
  visualStatus: PodView['status'];
};
const local = (v: { zh: string; en: string }, l: Language) => v[l];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    q = dx * dx + dy * dy;
  if (!q) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / q, 0, 1);
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}
function projectOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    q = dx * dx + dy * dy;
  if (!q) return { ...a };
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / q, 0, 1);
  return { x: a.x + dx * t, y: a.y + dy * t };
}
function endpoint(n: NodeView): Point {
  return n.portBuilt || n.kind === 'junction' ? { x: n.portX, y: n.portY } : { x: n.x, y: n.y };
}

export async function createMapRenderer(
  host: HTMLElement,
  callbacks: MapCallbacks,
): Promise<MapRenderer> {
  let destroyed = false;
  const app = new Application();
  await app.init({
    width: Math.max(1, host.clientWidth),
    height: Math.max(1, host.clientHeight),
    backgroundColor: C.paper,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
  });
  if (destroyed) {
    app.destroy({ removeView: true }, { children: true });
    return inert();
  }
  app.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  host.replaceChildren(app.canvas);
  const world = new Container(),
    city = new Container(),
    demand = new Container(),
    edges = new Container(),
    nodes = new Container(),
    podsLayer = new Container(),
    preview = new Container();
  world.addChild(city, demand, edges, nodes, podsLayer, preview);
  app.stage.addChild(world);
  // Keep input on one stable surface: hover redraws must never replace a pressed target.
  world.eventMode = 'none';
  app.stage.eventMode = 'static';
  app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
  let state: MapState | null = null,
    language: Language = 'zh',
    nodeKey = '',
    edgeKey = '',
    sceneKey = '',
    hovered: string | null = null,
    pointer: Point | null = null,
    fitted = false,
    suppressTap = false,
    lastTime: number | null = null;
  let drag: { origin: Point; world: Point; moved: boolean } | null = null;
  const podSprites = new Map<number, PodSprite>();
  const nodeMap = () => new Map(state?.snapshot.nodes.map((n) => [n.id, n]) ?? []);
  const fit = () => {
    const z = clamp(
      Math.min(app.screen.width / (WORLD.width + 90), app.screen.height / (WORLD.height + 80)),
      0.42,
      1.1,
    );
    world.scale.set(z);
    world.position.set(
      (app.screen.width - WORLD.width * z) / 2,
      (app.screen.height - WORLD.height * z) / 2,
    );
    fitted = true;
  };
  const at = (e: { global: Point }): Point => ({
    x: (e.global.x - world.position.x) / world.scale.x,
    y: (e.global.y - world.position.y) / world.scale.y,
  });
  drawCity(city, language);
  fit();
  const eligible = (n: NodeView | undefined) => !!n && (n.kind === 'junction' || n.portBuilt);
  const setHover = (id: string | null) => {
    if (hovered === id) return;
    hovered = id;
    callbacks.onHoverNode?.(id);
    drawNodes();
    drawPreview();
  };

  function drawNodes() {
    nodes.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!state) return;
    for (const n of state.snapshot.nodes) {
      const c = new Container(),
        g = new Graphics(),
        active = hovered === n.id,
        selected = state.selectedNode === n.id || state.buildFrom === n.id;
      c.position.set(n.x, n.y);
      c.eventMode = 'static';
      c.cursor = 'pointer';
      if (n.kind === 'junction') {
        const p = endpoint(n);
        c.position.set(p.x, p.y);
        c.hitArea = new Rectangle(-20, -20, 40, 40);
        if (active || selected)
          g.circle(0, 0, selected ? 18 : 14).fill({
            color: selected ? C.gold : C.teal,
            alpha: 0.16,
          });
        g.circle(0, 0, 7).fill({ color: C.paper }).stroke({ color: C.teal, width: 3 });
        g.circle(0, 0, 2.5).fill({ color: C.teal });
      } else {
        const b = buildingBox(n);
        c.hitArea = new Rectangle(-b.w / 2 - 8, -b.h / 2 - 8, b.w + 16, b.h + 16);
        paintBuilding(g, n, active, selected);
        if (n.portBuilt) {
          const p = endpoint(n),
            dx = p.x - n.x,
            dy = p.y - n.y;
          g.moveTo(dx * 0.78, dy * 0.78)
            .lineTo(dx, dy)
            .stroke({ color: C.teal, width: 3, alpha: 0.75 });
          g.circle(dx, dy, 7).fill({ color: C.paper }).stroke({ color: C.teal, width: 3 });
          g.rect(dx - 3, dy - 2, 6, 4).fill({ color: C.teal });
          if (n.queue) {
            g.circle(dx + 12, dy - 12, 9).fill({ color: C.orange });
            const q = new Text({
              text: String(n.queue),
              style: { fontFamily: 'system-ui', fontSize: 11, fontWeight: '700', fill: 0xffffff },
              anchor: 0.5,
            });
            q.position.set(dx + 12, dy - 12);
            c.addChild(q);
          }
        }
        if (active || selected) {
          const label = new Text({
            text: local(n.name, language),
            style: {
              fontFamily: 'ui-rounded, "PingFang SC", system-ui',
              fontSize: 20,
              fontWeight: '600',
              fill: C.ink,
              stroke: { color: C.paper, width: 4 },
            },
            anchor: 0.5,
          });
          label.position.set(0, -b.h / 2 - 18);
          c.addChild(label);
        }
      }
      c.addChildAt(g, 0);
      c.on('pointerover', () => setHover(n.id));
      c.on('pointerout', () => setHover(null));
      c.on('pointertap', (e) => {
        e.stopPropagation();
        if (!suppressTap) callbacks.onNodeClick(n.id);
      });
      nodes.addChild(c);
    }
  }
  function drawEdges() {
    edges.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!state) return;
    const map = nodeMap();
    for (const e of state.snapshot.edges) {
      const from = map.get(e.from),
        to = map.get(e.to);
      if (!from || !to) continue;
      const a = endpoint(from),
        b = endpoint(to),
        selected = state.selectedEdge === e.id,
        g = new Graphics();
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({ color: 0x496860, width: (selected ? 17 : 15) + (e.level - 1) * 4, alpha: 0.28 });
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({
          color: selected ? C.gold : C.teal,
          width: (selected ? 10 : 8) + (e.level - 1) * 4,
          alpha: 0.96,
        });
      const length = Math.max(1, dist(a, b));
      const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
      for (let lane = 0; lane < e.level; lane++) {
        const offset = (lane - (e.level - 1) / 2) * 4;
        g.moveTo(a.x + normal.x * offset, a.y + normal.y * offset)
          .lineTo(b.x + normal.x * offset, b.y + normal.y * offset)
          .stroke({ color: 0xe4f2e9, width: 1.5, alpha: 0.9 });
      }
      if (state.overlay === 'traffic' && e.utilization > 0)
        g.moveTo(a.x, a.y)
          .lineTo(b.x, b.y)
          .stroke({ color: C.orange, width: 5, alpha: 0.25 + clamp(e.utilization, 0, 1) * 0.65 });
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = { contains: (x: number, y: number) => segmentDistance({ x, y }, a, b) <= 12 };
      g.on('pointertap', (event) => {
        event.stopPropagation();
        if (!suppressTap) callbacks.onEdgeClick(e.id, projectOnSegment(at(event), a, b));
      });
      edges.addChild(g);
    }
  }
  function drawDemand() {
    demand.removeChildren().forEach((c) => c.destroy());
    if (!state || state.overlay !== 'demand') return;
    const map = nodeMap();
    for (const f of state.snapshot.demandFlows
      .filter((f) => map.has(f.from) && map.has(f.to) && f.from !== f.to && (f.demand || f.waiting))
      .sort((a, b) => b.waiting + b.demand - a.waiting - a.demand)
      .slice(0, 10)) {
      const a = map.get(f.from)!,
        b = map.get(f.to)!,
        strength = Math.max(f.demand, f.waiting),
        g = new Graphics(),
        mx = (a.x + b.x) / 2,
        my = Math.min(a.y, b.y) - 55 - Math.min(strength, 24) * 2;
      g.moveTo(a.x, a.y)
        .quadraticCurveTo(mx, my, b.x, b.y)
        .stroke({
          color: C.orange,
          width: clamp(1.2 + strength * 0.3, 1.2, 7),
          alpha: 0.18 + Math.min(strength, 12) * 0.045,
        });
      if (f.waiting)
        g.circle(a.x, a.y, 5 + Math.min(f.waiting, 6)).stroke({
          color: C.orange,
          width: 1.5,
          alpha: 0.65,
        });
      demand.addChild(g);
    }
  }
  function drawPreview() {
    preview.removeChildren().forEach((c) => c.destroy());
    if (!state || !pointer) return;
    if (state.tool === 'junction') {
      const g = new Graphics();
      g.circle(pointer.x, pointer.y, 11)
        .fill({ color: C.orange, alpha: 0.13 })
        .stroke({ color: C.orange, width: 2, alpha: 0.78 });
      g.moveTo(pointer.x - 6, pointer.y)
        .lineTo(pointer.x + 6, pointer.y)
        .moveTo(pointer.x, pointer.y - 6)
        .lineTo(pointer.x, pointer.y + 6)
        .stroke({ color: C.orange, width: 1.5 });
      preview.addChild(g);
      return;
    }
    if (state.tool !== 'build') return;
    const map = nodeMap(),
      draft = state.draft ?? [];
    if (draft.length) {
      const points = draft.map((point) =>
        point.nodeId && map.get(point.nodeId) ? endpoint(map.get(point.nodeId)!) : point,
      );
      const g = new Graphics();
      g.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((point) => g.lineTo(point.x, point.y));
      g.stroke({ color: C.teal, width: 4, alpha: 0.88 });
      points.forEach((point) =>
        g.circle(point.x, point.y, 5).fill({ color: C.paper }).stroke({ color: C.teal, width: 2 }),
      );
      g.moveTo(points.at(-1)!.x, points.at(-1)!.y)
        .lineTo(pointer.x, pointer.y)
        .stroke({ color: C.teal, width: 3, alpha: 0.42 });
      g.circle(pointer.x, pointer.y, 6).stroke({ color: C.teal, width: 1.5, alpha: 0.56 });
      preview.addChild(g);
      return;
    }
    if (!state.buildFrom) return;
    const from = map.get(state.buildFrom),
      to = hovered ? map.get(hovered) : undefined;
    if (!from) return;
    const a = endpoint(from),
      b = to ? endpoint(to) : pointer,
      valid = !!to && to.id !== from.id && eligible(from) && eligible(to),
      g = new Graphics();
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ color: valid ? C.teal : C.orange, width: 4, alpha: 0.78 });
    g.circle(b.x, b.y, valid ? 13 : 7).stroke({ color: valid ? C.teal : C.orange, width: 2 });
    preview.addChild(g);
    if (valid && to) {
      const coords = Object.fromEntries([...map].map(([id, n]) => [id, endpoint(n)]));
      const info = connectionInfo(from.id, to.id, coords);
      if (info) {
        const label = new Text({
          text:
            Math.round(info.length) +
            'm · ' +
            info.cost +
            ' CR' +
            (info.bridge ? (language === 'zh' ? ' · 桥梁' : ' · bridge') : ''),
          style: {
            fontFamily: 'ui-rounded, system-ui',
            fontSize: 13,
            fontWeight: '600',
            fill: C.ink,
            stroke: { color: C.paper, width: 4 },
          },
          anchor: 0.5,
        });
        label.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 - 17);
        preview.addChild(label);
      }
    }
  }
  function paint(p: PodSprite) {
    const g = p.graphic;
    g.clear();
    const busy = p.status === 'occupied',
      idle = p.status === 'idle' || p.status === 'waiting',
      color = busy ? C.teal : idle ? 0xd8e5dc : 0xaec7c0;
    g.ellipse(0, 4, 8, 3).fill({ color: C.shadow, alpha: 0.2 });
    g.roundRect(-9, -5, 18, 10, 5)
      .fill({ color, alpha: 0.98 })
      .stroke({ color: C.ink, width: 1, alpha: 0.36 });
    g.rect(1, -3, 5, 6).fill({ color: busy ? 0xe8f6ed : C.paper, alpha: 0.9 });
    g.circle(-4, 0, 1.5).fill({ color: C.orange, alpha: busy ? 0.95 : 0.35 });
    p.visualStatus = p.status;
  }
  const place = (p: PodSprite) => {
    p.graphic.position.set(p.current.x, p.current.y);
    p.graphic.rotation = p.angle;
  };
  function setPods(next: PodView[], snap: boolean) {
    const ids = new Set(next.map((p) => p.id));
    for (const [id, p] of podSprites)
      if (!ids.has(id)) {
        p.graphic.destroy();
        podSprites.delete(id);
      }
    for (const value of next) {
      const old = podSprites.get(value.id);
      if (old) {
        old.target = { x: value.x, y: value.y };
        old.targetAngle = value.angle;
        old.status = value.status;
        if (snap) {
          old.current = { ...old.target };
          old.angle = value.angle;
        }
        if (old.visualStatus !== old.status) paint(old);
        place(old);
      } else {
        const p: PodSprite = {
          graphic: new Graphics(),
          current: { x: value.x, y: value.y },
          target: { x: value.x, y: value.y },
          angle: value.angle,
          targetAngle: value.angle,
          status: value.status,
          visualStatus: value.status,
        };
        podsLayer.addChild(p.graphic);
        podSprites.set(value.id, p);
        paint(p);
        place(p);
      }
    }
  }
  const tick = (ticker: { deltaMS: number }) => {
    const step = 1 - Math.exp(-ticker.deltaMS / 115);
    for (const p of podSprites.values()) {
      p.current.x += (p.target.x - p.current.x) * step;
      p.current.y += (p.target.y - p.current.y) * step;
      p.angle += (((p.targetAngle - p.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * step;
      place(p);
    }
  };
  app.ticker.add(tick);
  function pickNode(point: Point): NodeView | undefined {
    return [...(state?.snapshot.nodes ?? [])].reverse().find((n) => {
      const p = endpoint(n),
        b = buildingBox(n),
        padding = Math.max(8, 9 / world.scale.x);
      if (n.kind === 'junction') return dist(point, p) <= Math.max(15, 12 / world.scale.x);
      return (
        (Math.abs(point.x - n.x) <= b.w / 2 + padding &&
          Math.abs(point.y - n.y) <= b.h / 2 + padding) ||
        (n.portBuilt && dist(point, p) <= Math.max(13, 10 / world.scale.x))
      );
    });
  }
  function pickEdge(point: Point) {
    const map = nodeMap();
    return [...(state?.snapshot.edges ?? [])].reverse().find((edge) => {
      const a = map.get(edge.from),
        b = map.get(edge.to);
      return (
        a &&
        b &&
        segmentDistance(point, endpoint(a), endpoint(b)) <= Math.max(12, 8 / world.scale.x)
      );
    });
  }
  const move = (e: { global: Point }) => {
    pointer = at(e);
    const hit = pickNode(pointer);
    setHover(hit?.id ?? null);
    app.stage.cursor = drag?.moved
      ? 'grabbing'
      : hit || pickEdge(pointer)
        ? 'pointer'
        : state?.tool === 'build'
          ? 'crosshair'
          : 'grab';
    drawPreview();
  };
  app.stage.on('pointerdown', (e) => {
    suppressTap = false;
    drag = {
      origin: { x: e.global.x, y: e.global.y },
      world: { x: world.position.x, y: world.position.y },
      moved: false,
    };
    move(e);
  });
  app.stage.on('pointermove', (e) => {
    move(e);
    if (!drag) return;
    const dx = e.global.x - drag.origin.x,
      dy = e.global.y - drag.origin.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) world.position.set(drag.world.x + dx, drag.world.y + dy);
  });
  app.stage.on('pointerup', (e) => {
    const moved = !!drag?.moved;
    suppressTap = moved;
    const point = at(e);
    drag = null;
    if (moved) return;
    const node = pickNode(point);
    if (node) {
      callbacks.onNodeClick(node.id);
      return;
    }
    const edge = pickEdge(point),
      map = nodeMap();
    if (edge) {
      callbacks.onEdgeClick(
        edge.id,
        projectOnSegment(point, endpoint(map.get(edge.from)!), endpoint(map.get(edge.to)!)),
      );
      return;
    }
    callbacks.onBackgroundClick(point);
  });
  app.stage.on('pointerupoutside', () => {
    drag = null;
  });
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = app.canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.14 : 1 / 1.14, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  app.canvas.addEventListener('wheel', wheel, { passive: false });
  function zoomAt(factor: number, screen: Point) {
    const old = world.scale.x,
      next = clamp(old * factor, 0.24, 2.2);
    if (old === next) return;
    const fixed = {
      x: (screen.x - world.position.x) / old,
      y: (screen.y - world.position.y) / old,
    };
    world.scale.set(next);
    world.position.set(screen.x - fixed.x * next, screen.y - fixed.y * next);
    fitted = false;
  }
  const observer = new ResizeObserver(() => resize());
  observer.observe(host);
  function resize() {
    if (destroyed) return;
    const w = Math.max(1, host.clientWidth),
      h = Math.max(1, host.clientHeight);
    if (w === app.screen.width && h === app.screen.height) return;
    const center = {
      x: (app.screen.width / 2 - world.position.x) / world.scale.x,
      y: (app.screen.height / 2 - world.position.y) / world.scale.y,
    };
    app.renderer.resize(w, h);
    app.stage.hitArea = new Rectangle(0, 0, w, h);
    if (fitted) fit();
    else world.position.set(w / 2 - center.x * world.scale.x, h / 2 - center.y * world.scale.y);
  }
  return {
    update(next) {
      if (destroyed) return;
      state = next;
      if (sceneKey !== next.language) {
        language = next.language;
        drawCity(city, language);
        sceneKey = language;
      }
      const nk =
        next.language +
        '/' +
        next.selectedNode +
        '/' +
        next.buildFrom +
        '/' +
        hovered +
        '/' +
        next.snapshot.nodes
          .map(
            (n) =>
              n.id +
              ':' +
              n.x +
              ':' +
              n.y +
              ':' +
              n.portBuilt +
              ':' +
              n.portX +
              ':' +
              n.portY +
              ':' +
              n.queue +
              ':' +
              n.portLevel,
          )
          .join('|');
      if (nk !== nodeKey) {
        drawNodes();
        nodeKey = nk;
      }
      const ek =
        next.overlay +
        '/' +
        next.selectedEdge +
        '/' +
        next.snapshot.edges.map((e) => e.id + ':' + e.level + ':' + e.utilization).join('|');
      if (ek !== edgeKey) {
        drawEdges();
        edgeKey = ek;
      }
      drawDemand();
      const jump = next.snapshot.pods.some((p) => {
        const old = podSprites.get(p.id);
        return old ? dist(old.target, p) > 140 : false;
      });
      setPods(
        next.snapshot.pods,
        !next.snapshot.running || (lastTime !== null && next.snapshot.simTime < lastTime) || jump,
      );
      lastTime = next.snapshot.simTime;
      drawPreview();
    },
    resize,
    resetCamera: fit,
    zoomBy: (factor) => zoomAt(factor, { x: app.screen.width / 2, y: app.screen.height / 2 }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      app.canvas.removeEventListener('wheel', wheel);
      app.ticker.remove(tick);
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
function inert(): MapRenderer {
  return { update() {}, resize() {}, resetCamera() {}, zoomBy() {}, destroy() {} };
}
function drawCity(layer: Container, language: Language) {
  layer.removeChildren().forEach((c) => c.destroy({ children: true }));
  const base = new Graphics();
  base.rect(-100, -100, WORLD.width + 200, WORLD.height + 200).fill({ color: C.paper });
  layer.addChild(base);
  const green = new Graphics();
  for (const p of [
    { x: 88, y: 543, w: 318, h: 145 },
    { x: 930, y: 220, w: 230, h: 145 },
    { x: 1265, y: 785, w: 205, h: 155 },
  ]) {
    green.roundRect(p.x, p.y, p.w, p.h, 18).fill({ color: C.park, alpha: 0.64 });
    for (let i = 0; i < 15; i++)
      green
        .circle(p.x + 18 + ((i * 31) % (p.w - 32)), p.y + 18 + ((i * 47) % (p.h - 32)), 6)
        .fill({ color: 0x789b7a, alpha: 0.65 });
  }
  layer.addChild(green);
  const water = new Graphics(),
    canal = [
      { x: 808, y: -80 },
      { x: 845, y: 80 },
      { x: 790, y: 210 },
      { x: 846, y: 355 },
      { x: 798, y: 500 },
      { x: 855, y: 650 },
      { x: 810, y: 810 },
      { x: 862, y: 960 },
      { x: 830, y: 1180 },
    ];
  water.moveTo(canal[0].x, canal[0].y);
  canal.slice(1).forEach((p) => water.lineTo(p.x, p.y));
  water.stroke({ color: C.waterEdge, width: 104, alpha: 0.22 });
  water.moveTo(canal[0].x, canal[0].y);
  canal.slice(1).forEach((p) => water.lineTo(p.x, p.y));
  water.stroke({ color: C.water, width: 88, alpha: 0.96 });
  layer.addChild(water);
  const roads = new Graphics(),
    lines: Point[][] = [
      [
        { x: 85, y: 180 },
        { x: 695, y: 180 },
        { x: 760, y: 200 },
      ],
      [
        { x: 80, y: 505 },
        { x: 725, y: 505 },
        { x: 790, y: 470 },
      ],
      [
        { x: 70, y: 720 },
        { x: 710, y: 720 },
        { x: 800, y: 750 },
        { x: 1480, y: 750 },
      ],
      [
        { x: 110, y: 935 },
        { x: 745, y: 935 },
        { x: 820, y: 900 },
        { x: 1480, y: 900 },
      ],
      [
        { x: 170, y: 85 },
        { x: 170, y: 1010 },
      ],
      [
        { x: 485, y: 85 },
        { x: 485, y: 1015 },
      ],
      [
        { x: 690, y: 95 },
        { x: 690, y: 1030 },
      ],
      [
        { x: 990, y: 100 },
        { x: 990, y: 1000 },
      ],
      [
        { x: 1210, y: 100 },
        { x: 1210, y: 1000 },
      ],
      [
        { x: 1435, y: 100 },
        { x: 1435, y: 1000 },
      ],
      [
        { x: 850, y: 370 },
        { x: 1490, y: 370 },
      ],
      [
        { x: 850, y: 590 },
        { x: 1490, y: 590 },
      ],
    ];
  for (const l of lines) {
    roads.moveTo(l[0].x, l[0].y);
    l.slice(1).forEach((p) => roads.lineTo(p.x, p.y));
    roads.stroke({ color: C.roadEdge, width: 31, alpha: 0.35 });
    roads.moveTo(l[0].x, l[0].y);
    l.slice(1).forEach((p) => roads.lineTo(p.x, p.y));
    roads.stroke({ color: C.road, width: 25, alpha: 0.96 });
  }
  layer.addChild(roads);
  for (const d of DISTRICTS) {
    const label = new Text({
      text: local(d.name, language),
      style: {
        fontFamily: 'Georgia, "Songti SC", serif',
        fontSize: 20,
        letterSpacing: 3,
        fontWeight: '600',
        fill: d.color,
      },
      anchor: 0.5,
    });
    label.alpha = 0.78;
    label.position.set(d.x, d.y);
    layer.addChild(label);
  }
  const canalLabel = new Text({
    text: language === 'zh' ? '青湾运河' : 'BAY CANAL',
    style: {
      fontFamily: 'Georgia, serif',
      fontSize: 15,
      letterSpacing: 2,
      fontStyle: 'italic',
      fill: C.waterEdge,
    },
    anchor: 0.5,
  });
  canalLabel.position.set(856, 555);
  canalLabel.rotation = Math.PI / 2;
  canalLabel.alpha = 0.82;
  layer.addChild(canalLabel);
}
