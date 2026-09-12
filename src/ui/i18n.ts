import type {
  BuildingKind,
  Language,
  Purpose,
  Side,
  WaitReason,
} from "../shared/types";

export const text = (language: Language, zh: string, en: string) =>
  language === "zh" ? zh : en;

export const sideName = (side: Side, language: Language) =>
  ({
    north: text(language, "北", "N"),
    east: text(language, "东", "E"),
    south: text(language, "南", "S"),
    west: text(language, "西", "W"),
  })[side];

export const kindName = (kind: BuildingKind, language: Language) =>
  ({
    home: text(language, "住宅", "Home"),
    office: text(language, "办公", "Office"),
    shop: text(language, "商店", "Shop"),
  })[kind];

export const purposeName = (purpose: Purpose, language: Language) =>
  ({
    work: text(language, "上班", "Work"),
    shop: text(language, "购物", "Shop"),
    visit: text(language, "拜访", "Visit"),
    home: text(language, "回家", "Home"),
  })[purpose];

export const statusName = (status: string, language: Language) =>
  ({
    inside: text(language, "楼内", "Inside"),
    walking: text(language, "步行中", "Walking"),
    waiting: text(language, "候车中", "Waiting"),
    boarding: text(language, "上车中", "Boarding"),
    riding: text(language, "乘车中", "Riding"),
    alighting: text(language, "下车中", "Alighting"),
  })[status] ?? status;

export const waitReasonName = (
  reason: WaitReason | undefined,
  language: Language,
) =>
  reason
    ? {
        "no-platform": text(
          language,
          "目的地没有站台",
          "No destination platform",
        ),
        disconnected: text(language, "轨道尚未连通", "Track disconnected"),
        "no-pod": text(language, "等待空闲 Pod", "Waiting for an idle Pod"),
        "platform-busy": text(language, "站台繁忙", "Platform busy"),
        "track-busy": text(language, "轨道繁忙", "Track busy"),
        "parking-full": text(language, "停车位已满", "Parking full"),
        "awaiting-pickup": text(language, "Pod 正在接近", "Pod approaching"),
      }[reason]
    : text(language, "无", "None");
