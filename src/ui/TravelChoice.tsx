import type { Language, Resident } from "../shared/types";
import { formatClock, formatDuration } from "../shared/selectors";
import { text } from "./i18n";

function occupationName(
  occupation: Resident["occupation"],
  language: Language,
) {
  const labels = {
    worker: ["上班族", "Worker"],
    student: ["学生", "Student"],
    teacher: ["教师", "Teacher"],
    medic: ["医护", "Medic"],
    service: ["服务人员", "Service worker"],
  } as const;
  return occupation ? labels[occupation][language === "zh" ? 0 : 1] : "—";
}

function reasonName(
  reason: NonNullable<Resident["decision"]>["reason"],
  language: Language,
) {
  const labels = {
    faster: ["Pod 更快", "Pod is faster"],
    "short-walk": ["距离很近，步行更合适", "It is close enough to walk"],
    price: ["节约的时间不值得这笔车费", "The time saved is not worth the fare"],
    wait: ["Pod 总耗时更长", "Pod would take longer overall"],
    preference: ["个人偏好", "Personal preference"],
    "no-platform": ["没有可用平台", "No usable platform"],
    disconnected: ["轨道未连通", "Track is disconnected"],
    "no-pod": ["没有空闲 Pod", "No idle Pod"],
    "wait-abandoned": ["等待后改走路", "Walked after waiting"],
  } as const;
  return labels[reason][language === "zh" ? 0 : 1];
}

const money = (value: number, language: Language) =>
  `${language === "zh" ? "¥" : "$"}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function TravelChoice({
  resident,
  language,
  destinationName,
}: {
  resident: Resident;
  language: Language;
  destinationName: string;
}) {
  const decision = resident.decision;
  const tx = (zh: string, en: string) => text(language, zh, en);
  if (!decision) return null;
  return (
    <section className="travel-choice">
      <div className="travel-choice-heading">
        <span>
          {tx("最近一次出行选择", "LAST DEPARTURE CHOICE")} ·{" "}
          {formatClock(decision.at)}
        </span>
        <strong>{decision.mode === "pod" ? "Pod" : tx("步行", "Walk")}</strong>
      </div>
      <p>{reasonName(decision.reason, language)}</p>
      <div className="details">
        <div className="detail-row">
          <span>{tx("职业", "Occupation")}</span>
          <strong>{occupationName(resident.occupation, language)}</strong>
        </div>
        <div className="detail-row">
          <span>{tx("目的地", "Destination")}</span>
          <strong>{destinationName}</strong>
        </div>
        <div className="detail-row">
          <span>{tx("纯步行", "Walk")}</span>
          <strong>{formatDuration(decision.walkSeconds, language)}</strong>
        </div>
        <div className="detail-row">
          <span>{tx("Pod 等待 / 乘坐", "Pod wait / ride")}</span>
          <strong>
            {decision.podSeconds === undefined
              ? "—"
              : `${formatDuration(decision.waitSeconds ?? 0, language)} / ${formatDuration(decision.rideSeconds ?? Math.max(0, decision.podSeconds - (decision.waitSeconds ?? 0)), language)}`}
          </strong>
        </div>
        <div className="detail-row">
          <span>
            {tx("Pod 门到门 · 含接驳步行", "Pod door-to-door · incl. walking")}
          </span>
          <strong>
            {decision.podSeconds === undefined
              ? "—"
              : formatDuration(decision.podSeconds, language)}
          </strong>
        </div>
        <div className="detail-row">
          <span>{tx("预估里程 / 票价", "Distance / fare")}</span>
          <strong>
            {decision.distanceKm === undefined
              ? "—"
              : `${decision.distanceKm.toFixed(2)} km · ${money(decision.fare ?? decision.distanceKm * decision.farePerKm, language)}`}
          </strong>
        </div>
        <div className="detail-row">
          <span>{tx("当时单价", "Rate at choice")}</span>
          <strong>{money(decision.farePerKm, language)} / km</strong>
        </div>
      </div>
    </section>
  );
}
