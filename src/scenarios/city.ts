import type { CityNode, Localized } from '../shared/types';
export const WORLD = { width: 1600, height: 1100 };
export const CITY_NAME: Localized = { zh: '青湾市', en: 'Bayhaven' };
export const DISTRICTS = [
  { id: 'north', name: { zh: '北岸住区', en: 'NORTHBANK' }, x: 350, y: 165, color: 0x789684 },
  { id: 'central', name: { zh: '中央商务区', en: 'CENTRAL' }, x: 485, y: 750, color: 0xc99871 },
  { id: 'campus', name: { zh: '大学城区', en: 'UNIVERSITY' }, x: 1190, y: 410, color: 0x8694b2 },
] as const;
export const CITY_NODES: CityNode[] = [
  {
    id: 'n1',
    name: { zh: '松庭公寓', en: 'Pine Court' },
    x: 230,
    y: 285,
    kind: 'residential',
    district: 'north',
    population: 720,
  },
  {
    id: 'n2',
    name: { zh: '北岸花园', en: 'Northbank Gardens' },
    x: 460,
    y: 260,
    kind: 'residential',
    district: 'north',
    population: 980,
  },
  {
    id: 'n3',
    name: { zh: '运河居', en: 'Canal House' },
    x: 650,
    y: 350,
    kind: 'residential',
    district: 'north',
    population: 620,
  },
  {
    id: 'n4',
    name: { zh: '枫林社区', en: 'Maple Quarter' },
    x: 260,
    y: 465,
    kind: 'residential',
    district: 'north',
    population: 860,
  },
  {
    id: 'c1',
    name: { zh: '中央商务楼', en: 'Central Exchange' },
    x: 440,
    y: 625,
    kind: 'office',
    district: 'central',
    population: 1100,
  },
  {
    id: 'c2',
    name: { zh: '天际中心', en: 'Skyline Exchange' },
    x: 625,
    y: 805,
    kind: 'office',
    district: 'central',
    population: 1500,
  },
  {
    id: 'c3',
    name: { zh: '河湾市场', en: 'Riverside Market' },
    x: 290,
    y: 855,
    kind: 'leisure',
    district: 'central',
    population: 700,
  },
  {
    id: 'c4',
    name: { zh: '海港工作室', en: 'Harbor Studios' },
    x: 605,
    y: 1000,
    kind: 'office',
    district: 'central',
    population: 820,
  },
  {
    id: 'u1',
    name: { zh: '青湾大学', en: 'Bayhaven University' },
    x: 1080,
    y: 530,
    kind: 'university',
    district: 'campus',
    population: 1400,
  },
  {
    id: 'u2',
    name: { zh: '创新园', en: 'Innovation Park' },
    x: 1330,
    y: 615,
    kind: 'office',
    district: 'campus',
    population: 1050,
  },
  {
    id: 'u3',
    name: { zh: '学苑公寓', en: 'Scholar Residences' },
    x: 1230,
    y: 280,
    kind: 'residential',
    district: 'campus',
    population: 880,
  },
  {
    id: 'u4',
    name: { zh: '湾畔体育场', en: 'Bayfront Arena' },
    x: 1090,
    y: 870,
    kind: 'leisure',
    district: 'campus',
    population: 600,
  },
  ...[
    [140, 150, 'residential', 'north'],
    [320, 155, 'residential', 'north'],
    [590, 160, 'residential', 'north'],
    [155, 370, 'residential', 'north'],
    [370, 355, 'residential', 'north'],
    [580, 440, 'residential', 'north'],
    [140, 610, 'office', 'central'],
    [325, 600, 'office', 'central'],
    [610, 590, 'office', 'central'],
    [160, 775, 'leisure', 'central'],
    [455, 835, 'office', 'central'],
    [350, 1000, 'residential', 'central'],
    [1020, 155, 'residential', 'campus'],
    [1400, 190, 'residential', 'campus'],
    [1070, 350, 'university', 'campus'],
    [1370, 380, 'office', 'campus'],
    [1210, 510, 'university', 'campus'],
    [1020, 700, 'office', 'campus'],
    [1240, 795, 'leisure', 'campus'],
    [1420, 980, 'residential', 'campus'],
    [1130, 1010, 'office', 'campus'],
  ].map(([x, y, kind, district], index) => ({
    id: `b${index + 1}`,
    name: {
      zh: `${district === 'north' ? '北岸' : district === 'central' ? '河湾' : '学苑'}${kind === 'residential' ? '公馆' : kind === 'office' ? '大厦' : kind === 'university' ? '学院' : '广场'} ${index + 1}`,
      en: `${district === 'north' ? 'Northbank' : district === 'central' ? 'Riverside' : 'Campus'} ${kind === 'residential' ? 'House' : kind === 'office' ? 'Works' : kind === 'university' ? 'College' : 'Square'} ${index + 1}`,
    },
    x: Number(x),
    y: Number(y),
    kind: kind as CityNode['kind'],
    district: district as CityNode['district'],
    population: 360 + index * 23,
  })),
];
export const NODE_BY_ID = Object.fromEntries(CITY_NODES.map((n) => [n.id, n])) as Record<
  string,
  CityNode
>;
/** Shared preview/charging formula. A bridge is priced when endpoints cross the canal. */
export function connectionInfo(
  from: string,
  to: string,
  nodes: Record<string, { x: number; y: number }> = NODE_BY_ID,
) {
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !Object.hasOwn(nodes, from) ||
    !Object.hasOwn(nodes, to)
  )
    return null;
  const a = nodes[from],
    b = nodes[to];
  if (!a || !b || from === to) return null;
  const length = Math.hypot(a.x - b.x, a.y - b.y);
  const bridge = a.x < 820 !== b.x < 820;
  return {
    length,
    cost: Math.round(length * 1.05 + (bridge ? 300 : 0)),
    travelTime: Math.max(4, Math.ceil(length / 24)),
    bridge,
  };
}
export const ECONOMY = {
  initialCash: 4200,
  podCost: 180,
  portCost: 90,
  junctionCost: 70,
  portUpgradeCost: 380,
  edgeUpgradeCost: 480,
  startingPods: 6,
};
