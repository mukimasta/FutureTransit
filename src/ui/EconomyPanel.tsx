import { useEffect, useMemo, useState } from "react";
import { Banknote, Landmark, ReceiptText, X } from "lucide-react";
import {
  CITY_DAY_SECONDS,
  LOAN_DAILY_RATE,
  DEFAULT_FARE_PER_KM,
  GOVERNMENT_GRANT_AMOUNT,
  GOVERNMENT_GRANTS,
  LOAN_AMOUNT,
  LOAN_TERM_DAYS,
  MAX_FARE_PER_KM,
  MIN_FARE_PER_KM,
  PARKING_UPKEEP_PER_DAY,
  PLATFORM_UPKEEP_PER_DAY,
  POD_RUNNING_PER_KM,
  POD_UPKEEP_PER_DAY,
  TRACK_UPKEEP_PER_LANE_KM_DAY,
} from "../economy/config";
import { dailyUpkeep } from "../economy";
import type {
  Command,
  Economy,
  Language,
  LedgerCategory,
  World,
} from "../shared/types";
import { formatClock } from "../shared/selectors";
import { text } from "./i18n";

const operatingCosts: LedgerCategory[] = [
  "track-upkeep",
  "platform-upkeep",
  "parking-upkeep",
  "pod-upkeep",
  "loaded-running",
  "empty-running",
  "interest",
];
const construction: LedgerCategory[] = [
  "track-build",
  "platform-build",
  "parking-build",
  "pod-buy",
  "refund",
];
const finance: LedgerCategory[] = ["grant", "loan", "repayment"];
const credits = new Set<LedgerCategory>([
  "opening",
  "fare",
  "grant",
  "loan",
  "refund",
]);

const signedCashflow = (category: LedgerCategory, magnitude: number) =>
  (credits.has(category) ? 1 : -1) * Math.abs(magnitude);

function totalsFrom(economy: Economy): Partial<Record<LedgerCategory, number>> {
  if (economy.totals) return economy.totals;
  return (economy.ledger ?? []).reduce<Partial<Record<LedgerCategory, number>>>(
    (totals, entry) => {
      totals[entry.category] =
        (totals[entry.category] ?? 0) + Math.abs(entry.amount);
      return totals;
    },
    {},
  );
}

function money(value: number, language: Language, signed = false) {
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${language === "zh" ? "¥" : "$"}${value.toLocaleString(
    undefined,
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  )}`;
}

function cityTimestamp(value: number, language: Language) {
  const day = Math.floor((value + 7 * 3600) / CITY_DAY_SECONDS) + 1;
  return language === "zh"
    ? `第 ${day} 天 ${formatClock(value)}`
    : `Day ${day} ${formatClock(value)}`;
}

function categoryName(category: LedgerCategory, language: Language) {
  const names: Record<LedgerCategory, [string, string]> = {
    opening: ["起始余额", "Opening balance"],
    fare: ["票款", "Fares"],
    grant: ["政府补助", "Government grant"],
    loan: ["借入本金", "Loan principal"],
    repayment: ["归还本金", "Principal repayment"],
    interest: ["贷款利息", "Loan interest"],
    "track-build": ["建设轨道", "Track construction"],
    "platform-build": ["建设平台", "Platform construction"],
    "parking-build": ["建设停车位", "Parking construction"],
    "pod-buy": ["购入 Pod", "Pod purchase"],
    refund: ["拆除退款", "Removal refund"],
    "track-upkeep": ["轨道维护", "Track upkeep"],
    "platform-upkeep": ["平台维护", "Platform upkeep"],
    "parking-upkeep": ["停车位维护", "Parking upkeep"],
    "pod-upkeep": ["Pod 维护", "Pod upkeep"],
    "loaded-running": ["载客运行", "Loaded running"],
    "empty-running": ["空驶运行", "Empty running"],
  };
  return names[category][language === "zh" ? 0 : 1];
}

function SumRow({
  label,
  value,
  language,
}: {
  label: string;
  value: number;
  language: Language;
}) {
  return (
    <div className="economy-row">
      <span>{label}</span>
      <strong className={value < 0 ? "is-debit" : value > 0 ? "is-credit" : ""}>
        {money(value, language, true)}
      </strong>
    </div>
  );
}

export function EconomyPanel({
  world,
  language,
  send,
  onClose,
}: {
  world: World;
  language: Language;
  send: (command: Command) => void;
  onClose: () => void;
}) {
  const economy = world.economy;
  const tx = (zh: string, en: string) => text(language, zh, en);
  const totals = useMemo(() => totalsFrom(economy), [economy]);
  const upkeep = useMemo(() => dailyUpkeep(world), [world]);
  const fare = economy.farePerKm ?? DEFAULT_FARE_PER_KM;
  const [fareInput, setFareInput] = useState(String(fare));
  useEffect(() => setFareInput(String(fare)), [fare]);
  const categoryTotal = (category: LedgerCategory) =>
    signedCashflow(category, totals[category] ?? 0);
  const sum = (categories: LedgerCategory[]) =>
    categories.reduce(
      (result, category) => result + categoryTotal(category),
      0,
    );
  const revenue = categoryTotal("fare");
  const operating = sum(operatingCosts);
  const constructionCashflow = sum(construction);
  const financeCashflow = sum(finance);
  const grantsClaimed = economy.grantsClaimed ?? 0;
  const mayTakeLoan = grantsClaimed >= GOVERNMENT_GRANTS && !economy.loan;
  const outstanding = economy.loan?.remaining ?? 0;
  const commitFare = () => {
    const value = Number(fareInput);
    if (!Number.isFinite(value)) {
      setFareInput(String(fare));
      return;
    }
    const bounded = Math.max(MIN_FARE_PER_KM, Math.min(MAX_FARE_PER_KM, value));
    setFareInput(String(bounded));
    if (bounded !== fare) send({ type: "set-fare", value: bounded });
  };

  return (
    <aside
      className="economy-panel"
      aria-label={tx("经营账本", "Economy ledger")}
    >
      <div className="economy-heading">
        <span>
          <ReceiptText size={15} />
          {tx("经营账本", "ECONOMY")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={tx("关闭", "Close")}
        >
          <X size={15} />
        </button>
      </div>
      <section className="economy-balance">
        <small>{tx("可用现金", "AVAILABLE CASH")}</small>
        <strong>{money(economy.cash, language)}</strong>
        <p>
          {tx(
            "起始资金、补助与借款不算经营利润。",
            "Opening funds, grants and loans are not operating profit.",
          )}
        </p>
      </section>

      <section className="economy-section fare-control">
        <label htmlFor="fare-per-km">{tx("票价 / 公里", "Fare per km")}</label>
        <div>
          <span>{language === "zh" ? "¥" : "$"}</span>
          <input
            id="fare-per-km"
            type="number"
            min={MIN_FARE_PER_KM}
            max={MAX_FARE_PER_KM}
            step="1"
            value={fareInput}
            onChange={(event) => setFareInput(event.target.value)}
            onBlur={commitFare}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <small>/ km</small>
        </div>
        <p>
          {tx(
            "仅影响之后出发的载客行程；按实际载客里程计费。",
            "Changes only later departures; fares use actual loaded distance.",
          )}
        </p>
      </section>

      <section className="economy-section">
        <h3>
          <Banknote size={14} />
          {tx("累计经营", "Operations to date")}
        </h3>
        <SumRow
          label={tx("票款收入", "Fare revenue")}
          value={revenue}
          language={language}
        />
        <SumRow
          label={tx("维护、运行和利息", "Upkeep, running and interest")}
          value={operating}
          language={language}
        />
        <div className="economy-total">
          <span>{tx("经营利润", "Operating profit")}</span>
          <strong>{money(revenue + operating, language, true)}</strong>
        </div>
        {economy.runningAccrued &&
        (economy.runningAccrued.loaded || economy.runningAccrued.empty) ? (
          <p className="economy-note">
            {tx("待结算运行费", "Pending running costs")} ·{" "}
            {money(
              -(economy.runningAccrued.loaded + economy.runningAccrued.empty),
              language,
              true,
            )}
          </p>
        ) : null}
      </section>

      <section className="economy-section compact-summary">
        <SumRow
          label={tx("建设与退款", "Construction & refunds")}
          value={constructionCashflow}
          language={language}
        />
        <SumRow
          label={tx("补助、借还本金", "Grants, borrowing & principal")}
          value={financeCashflow}
          language={language}
        />
      </section>

      <section className="economy-section finance-actions">
        <h3>
          <Landmark size={14} />
          {tx("补助与贷款", "Grants & loan")}
        </h3>
        <p>
          {tx(
            `已领 ${grantsClaimed} / ${GOVERNMENT_GRANTS} 次，每次 ${money(GOVERNMENT_GRANT_AMOUNT, language)}。`,
            `Claimed ${grantsClaimed} / ${GOVERNMENT_GRANTS}, ${money(GOVERNMENT_GRANT_AMOUNT, language)} each.`,
          )}
        </p>
        <button
          type="button"
          className="economy-action"
          disabled={grantsClaimed >= GOVERNMENT_GRANTS}
          onClick={() => send({ type: "claim-grant" })}
        >
          {tx("领取补助", "Claim grant")} +
          {money(GOVERNMENT_GRANT_AMOUNT, language)}
        </button>
        {economy.loan ? (
          <>
            <p>
              {tx(
                `剩余本金 ${money(outstanding, language)}${economy.loan.arrears ? `，其中逾期 ${money(economy.loan.arrears, language)}（已包含在剩余本金内）` : ""}；下期 ${cityTimestamp(economy.loan.nextPaymentAt, language)}，每期按剩余本金收 ${LOAN_DAILY_RATE * 100}% 利息。`,
                `${money(outstanding, language)} principal${economy.loan.arrears ? `, including ${money(economy.loan.arrears, language)} overdue (already included in principal)` : ""}; next due ${cityTimestamp(economy.loan.nextPaymentAt, language)}, with ${LOAN_DAILY_RATE * 100}% interest on remaining principal per instalment.`,
              )}
            </p>
            <button
              type="button"
              className="economy-action"
              disabled={economy.cash < outstanding}
              onClick={() => send({ type: "repay-loan" })}
            >
              {tx(
                `全额还款 ${money(outstanding, language)}`,
                `Repay in full ${money(outstanding, language)}`,
              )}
            </button>
          </>
        ) : (
          <>
            <p>
              {tx(
                `借款 ${money(LOAN_AMOUNT, language)}，分 ${LOAN_TERM_DAYS} 期，每个城市日还一期：本金 ${money(LOAN_AMOUNT / LOAN_TERM_DAYS, language)}，加剩余本金 ${LOAN_DAILY_RATE * 100}% 的利息。按期还清共付利息 ${money((LOAN_AMOUNT * LOAN_DAILY_RATE * (LOAN_TERM_DAYS + 1)) / 2, language)}。`,
                `Borrow ${money(LOAN_AMOUNT, language)} over ${LOAN_TERM_DAYS} instalments, one per city day: ${money(LOAN_AMOUNT / LOAN_TERM_DAYS, language)} principal plus ${LOAN_DAILY_RATE * 100}% interest on remaining principal. Total interest if paid on time: ${money((LOAN_AMOUNT * LOAN_DAILY_RATE * (LOAN_TERM_DAYS + 1)) / 2, language)}.`,
              )}
            </p>
            <button
              type="button"
              className="economy-action"
              disabled={!mayTakeLoan}
              onClick={() => send({ type: "take-loan" })}
            >
              {tx(
                `借入 ${money(LOAN_AMOUNT, language)}`,
                `Take ${money(LOAN_AMOUNT, language)} loan`,
              )}
            </button>
          </>
        )}
        <p className="economy-note">
          {tx(
            "这是压缩的游戏还款周期，不是现实日利率；提前还清不收后续利息。",
            "A compressed game repayment schedule, not a real-world daily rate. Early repayment avoids future interest.",
          )}
        </p>
      </section>

      <details className="economy-details economy-cost-rules">
        <summary>{tx("成本规则", "Cost rules")}</summary>
        <div>
          <p className="economy-note">
            {tx(
              "按城市分钟结算；以下为当前资产每天的维护预计。",
              "Settled by city minute; current assets' daily upkeep is shown below.",
            )}
          </p>
          <SumRow
            label={tx(
              `轨道 · ${TRACK_UPKEEP_PER_LANE_KM_DAY} / 车道公里 / 日`,
              `Track · ${TRACK_UPKEEP_PER_LANE_KM_DAY} / lane-km / day`,
            )}
            value={-upkeep["track-upkeep"]}
            language={language}
          />
          <SumRow
            label={tx(
              `平台 · ${PLATFORM_UPKEEP_PER_DAY} / 日`,
              `Platforms · ${PLATFORM_UPKEEP_PER_DAY} / day`,
            )}
            value={-upkeep["platform-upkeep"]}
            language={language}
          />
          <SumRow
            label={tx(
              `停车位 · ${PARKING_UPKEEP_PER_DAY} / 日`,
              `Parking · ${PARKING_UPKEEP_PER_DAY} / day`,
            )}
            value={-upkeep["parking-upkeep"]}
            language={language}
          />
          <SumRow
            label={tx(
              `Pod · ${POD_UPKEEP_PER_DAY} / 日`,
              `Pods · ${POD_UPKEEP_PER_DAY} / day`,
            )}
            value={-upkeep["pod-upkeep"]}
            language={language}
          />
          <div className="economy-row">
            <span>
              {tx(
                `Pod 实际运行 · ${POD_RUNNING_PER_KM} / 公里`,
                `Pod movement · ${POD_RUNNING_PER_KM} / km`,
              )}
            </span>
            <strong className="is-debit">
              {tx("载客与空驶均计费", "Loaded and empty both billed")}
            </strong>
          </div>
        </div>
      </details>

      <details className="economy-details">
        <summary>{tx("累计分类明细", "Cumulative categories")}</summary>
        <div>
          {(Object.entries(totals) as [LedgerCategory, number][])
            .filter(([, amount]) => amount !== 0)
            .map(([category, amount]) => (
              <SumRow
                key={category}
                label={categoryName(category, language)}
                value={signedCashflow(category, amount)}
                language={language}
              />
            ))}
        </div>
      </details>
      <details className="economy-details">
        <summary>
          {tx(
            `最近账目 ${Math.min(300, economy.ledger?.length ?? 0)}`,
            `Recent ledger ${Math.min(300, economy.ledger?.length ?? 0)}`,
          )}
        </summary>
        <div className="ledger-list">
          {[...(economy.ledger ?? [])].reverse().map((entry, index) => (
            <div
              className="ledger-entry"
              key={`${entry.at}-${entry.category}-${index}`}
            >
              <span>
                {formatClock(entry.at)} ·{" "}
                {categoryName(entry.category, language)}
              </span>
              <strong className={entry.amount < 0 ? "is-debit" : "is-credit"}>
                {money(entry.amount, language, true)}
              </strong>
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}
