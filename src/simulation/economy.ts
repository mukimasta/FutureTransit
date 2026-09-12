/** Pure operating economics; construction charges stay with their transactions. */
export function journeyOperatingCost(kind: 'empty' | 'customer', durationSeconds: number): number {
  const rate = kind === 'empty' ? 0.12 : 0.14;
  return Math.max(1, Math.round(Math.max(0, durationSeconds) * rate));
}

export function applyJourneyEconomy(
  cash: number,
  expenses: number,
  kind: 'empty' | 'customer',
  durationSeconds: number,
  fare = 0,
) {
  const operatingCost = journeyOperatingCost(kind, durationSeconds);
  return {
    cash: cash + (kind === 'customer' ? fare : 0) - operatingCost,
    expenses: expenses + operatingCost,
    revenue: kind === 'customer' ? fare : 0,
    operatingCost,
  };
}
