import { Graphics } from 'pixi.js';
import type { NodeKind, NodeView } from '../shared/types';

export type BuildingBox = { w: number; h: number };

/** One bright, readable hue per trip-making place type. */
export const buildingTint: Record<NodeKind, number> = {
  residential: 0x6e9a82,
  office: 0xc97555,
  university: 0x8797cf,
  leisure: 0xe18372,
  junction: 0x6a8075,
};

const P = {
  ivory: 0xfffbf2,
  gold: 0xe5a84c,
  shadow: 0x766a5f,
  residentialRoof: 0x4f7d70,
  officeRoof: 0xa95442,
  universityRoof: 0x6675ae,
  leisureRoof: 0xc85f59,
};

/** Keep footprint sizes stable: they also define stage-level picking bounds. */
export function buildingBox(n: NodeView): BuildingBox {
  if (n.id === 'u1') return { w: 92, h: 70 };
  if (n.id === 'u4') return { w: 94, h: 58 };
  if (n.id === 'c1') return { w: 78, h: 58 };
  if (n.kind === 'university') return { w: 58, h: 46 };
  if (n.kind === 'office') return { w: 39, h: 54 };
  if (n.kind === 'leisure') return { w: 54, h: 38 };
  return { w: 42, h: 35 };
}

export function paintBuilding(g: Graphics, n: NodeView, active: boolean, selected: boolean) {
  const { w, h } = buildingBox(n);
  const color = buildingTint[n.kind];
  if (active || selected) {
    g.roundRect(-w / 2 - 5, -h / 2 - 5, w + 10, h + 10, 8)
      .fill({ color: selected ? P.gold : color, alpha: selected ? 0.16 : 0.1 })
      .stroke({ color: selected ? P.gold : color, width: selected ? 3 : 1.5, alpha: 0.86 });
  }
  g.roundRect(-w / 2 + 3, -h / 2 + 4, w, h, 6).fill({ color: P.shadow, alpha: 0.15 });

  if (n.id === 'u4') return stadium(g, w, h, color);
  if (n.id === 'u1') return campus(g, w, h, color);
  if (n.kind === 'university') return academy(g, w, h, color);
  if (n.id === 'c1' || n.kind === 'office') return office(g, w, h, color);
  if (n.kind === 'leisure') return leisure(g, w, h, color);
  return home(g, w, h, color);
}

function home(g: Graphics, w: number, h: number, color: number) {
  g.roundRect(-w / 2, -h / 2 + 8, w, h - 8, 5).fill({ color });
  g.moveTo(-w / 2 - 3, -h / 2 + 9)
    .lineTo(0, -h / 2 - 5)
    .lineTo(w / 2 + 3, -h / 2 + 9)
    .closePath()
    .fill({ color: P.residentialRoof });
  g.roundRect(-w / 2 + 7, -2, 9, 7, 1.5).fill({ color: P.ivory });
  g.roundRect(w / 2 - 16, -2, 9, 7, 1.5).fill({ color: P.ivory });
  g.roundRect(-4, h / 2 - 10, 8, 10, 1.5).fill({ color: P.ivory, alpha: 0.88 });
}

function office(g: Graphics, w: number, h: number, color: number) {
  g.roundRect(-w / 2, -h / 2, w, h, 4).fill({ color });
  g.roundRect(-w / 2 + 4, -h / 2 - 6, w - 8, 8, 2).fill({ color: P.officeRoof });
  for (let y = -h / 2 + 10; y < h / 2 - 4; y += 11)
    g.roundRect(-w / 2 + 7, y, w - 14, 3, 1).fill({ color: P.ivory, alpha: 0.88 });
}

function academy(g: Graphics, w: number, h: number, color: number) {
  g.roundRect(-w / 2, -h / 2 + 6, w, h - 6, 6).fill({ color });
  g.moveTo(-w / 2 - 2, -h / 2 + 7)
    .lineTo(0, -h / 2 - 5)
    .lineTo(w / 2 + 2, -h / 2 + 7)
    .closePath()
    .fill({ color: P.universityRoof });
  for (const x of [-w / 2 + 9, -4, w / 2 - 13])
    g.roundRect(x, -3, 5, 8, 1).fill({ color: P.ivory, alpha: 0.9 });
  g.roundRect(-4, h / 2 - 11, 8, 11, 1.5).fill({ color: P.ivory, alpha: 0.9 });
}

function campus(g: Graphics, w: number, h: number, color: number) {
  g.roundRect(-w / 2, -h / 2, w, h, 8).fill({ color });
  g.roundRect(-w / 2 + 14, -h / 2 + 13, w - 28, h - 24, 5).fill({ color: P.ivory, alpha: 0.92 });
  g.roundRect(-w / 2 + 7, -h / 2 + 8, 12, h - 16, 3).fill({ color: P.universityRoof });
  g.roundRect(w / 2 - 19, -h / 2 + 8, 12, h - 16, 3).fill({ color: P.universityRoof });
  g.roundRect(-10, -h / 2 + 7, 20, 10, 3).fill({ color: P.universityRoof });
  g.circle(0, 0, 5).fill({ color });
}

function leisure(g: Graphics, w: number, h: number, color: number) {
  g.roundRect(-w / 2, -h / 2 + 5, w, h - 5, 6).fill({ color });
  g.roundRect(-w / 2 + 4, -h / 2, w - 8, 9, 3).fill({ color: P.leisureRoof });
  for (let x = -w / 2 + 7; x < w / 2 - 4; x += 12)
    g.roundRect(x, -2, 7, 6, 1).fill({ color: P.ivory, alpha: 0.92 });
  g.roundRect(-4, h / 2 - 10, 8, 10, 1.5).fill({ color: P.ivory, alpha: 0.88 });
}

function stadium(g: Graphics, w: number, h: number, color: number) {
  g.ellipse(0, 0, w / 2, h / 2).fill({ color });
  g.ellipse(0, 0, w / 2 - 11, h / 2 - 9).fill({ color: P.ivory, alpha: 0.96 });
  g.ellipse(0, 0, w / 2 - 22, h / 2 - 15).fill({ color: P.leisureRoof, alpha: 0.78 });
  g.moveTo(-w / 2 + 9, 0)
    .lineTo(w / 2 - 9, 0)
    .stroke({ color: P.ivory, width: 2, alpha: 0.9 });
}
