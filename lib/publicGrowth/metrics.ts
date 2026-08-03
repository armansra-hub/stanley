import { PARTICIPANT_GROWTH_THRESHOLDS, PARTICIPANT_THRESHOLDS, REVENUE_THRESHOLDS, type AwardFact, type ContractMetrics, type DerivedGrowthEvent, type TransactionFact } from "./types";

const DAY = 86_400_000;
const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(n).toLocaleString("en-US")}%`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface AnnualContractRevenue {
  year: number;
  obligated: number;
  deobligated: number;
  transactions: number;
}

/**
 * Annual federal award revenue is gross positive obligation activity. Negative
 * transactions are deobligations (funding reductions), not negative revenue,
 * so retain them separately instead of subtracting them from the UI total.
 */
export function summarizeContractRevenueByYear(transactions: Array<Pick<TransactionFact, "actionDate" | "obligation">>): AnnualContractRevenue[] {
  const annual = new Map<number, AnnualContractRevenue>();
  for (const transaction of transactions) {
    const year = Number(String(transaction.actionDate ?? "").slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const row = annual.get(year) ?? { year, obligated: 0, deobligated: 0, transactions: 0 };
    const obligation = Number(transaction.obligation ?? 0);
    if (obligation > 0) row.obligated += obligation;
    else if (obligation < 0) row.deobligated += Math.abs(obligation);
    row.transactions++;
    annual.set(year, row);
  }
  return [...annual.values()].sort((a, b) => b.year - a.year);
}

function inWindow(date: string, asOf: Date, fromDaysAgo: number, toDaysAgo = 0): boolean {
  const t = new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime();
  const end = asOf.getTime() - toDaysAgo * DAY;
  const start = asOf.getTime() - fromDaysAgo * DAY;
  return t >= start && t < end + DAY;
}

export function calculateContractMetrics(awards: AwardFact[], transactions: TransactionFact[], asOf = new Date()): ContractMetrics {
  const obligations = (from: number, to = 0) => transactions.filter((t) => inWindow(t.actionDate, asOf, from, to)).reduce((s, t) => s + t.obligation, 0);
  const newAwards = (days: number) => new Set(awards.filter((a) => a.startDate && inWindow(a.startDate, asOf, days)).map((a) => a.generatedAwardId)).size;
  const recent90 = transactions.filter((t) => inWindow(t.actionDate, asOf, 90));
  const active = awards.filter((a) => (!a.startDate || new Date(a.startDate) <= asOf) && (!a.endDate || new Date(a.endDate) >= asOf));
  const agencies365 = new Set(awards.filter((a) => a.startDate && inWindow(a.startDate, asOf, 365) && a.awardingAgency).map((a) => a.awardingAgency));
  const dates = awards.map((a) => a.startDate).filter((d): d is string => Boolean(d)).sort();
  const current = obligations(365), prior = obligations(730, 365);
  return {
    obligations30d: obligations(30), priorObligations30d: obligations(60, 30),
    obligations90d: obligations(90), priorObligations90d: obligations(180, 90),
    obligations365d: current, priorObligations365d: prior,
    ttmDelta: current - prior, ttmGrowthPct: prior > 0 ? ((current - prior) / prior) * 100 : null,
    newAwards30d: newAwards(30), newAwards90d: newAwards(90), newAwards365d: newAwards(365),
    transactionCount90d: recent90.length,
    positiveModifications90d: recent90.filter((t) => Boolean(t.modificationNumber) && t.obligation > 0).length,
    positiveModificationDollars90d: recent90.filter((t) => Boolean(t.modificationNumber) && t.obligation > 0).reduce((s, t) => s + t.obligation, 0),
    deobligationDollars90d: Math.abs(recent90.filter((t) => t.obligation < 0).reduce((s, t) => s + t.obligation, 0)),
    activeAwardCount: active.length,
    activeAwardCeiling: active.reduce((s, a) => s + a.awardCeiling, 0),
    activeAwardObligations: active.reduce((s, a) => s + a.totalObligations, 0),
    agencyCount365d: agencies365.size,
    largestAwardCeiling: Math.max(0, ...awards.map((a) => a.awardCeiling)),
    largestAwardObligations: Math.max(0, ...awards.map((a) => a.totalObligations)),
    largestTransaction: Math.max(0, ...transactions.map((t) => t.obligation)),
    firstAwardDate: dates[0] ?? null, latestAwardDate: dates.at(-1) ?? null,
    expiringAwards180d: active.filter((a) => {
      if (!a.endDate) return false;
      const end = new Date(`${a.endDate.slice(0, 10)}T00:00:00Z`).getTime();
      return end >= asOf.getTime() && end <= asOf.getTime() + 180 * DAY;
    }).length,
  };
}

export function deriveParticipantEvents(args: { filingId: string; formYear: number; boy: number; eoy: number; signalDate?: string | null }): DerivedGrowthEvent[] {
  const { filingId, formYear, boy, eoy } = args;
  const signalDate = args.signalDate ?? `${formYear}-12-31`;
  const out: DerivedGrowthEvent[] = [];
  for (const threshold of PARTICIPANT_THRESHOLDS) {
    if (boy < threshold && eoy >= threshold) out.push({ family: "employee_growth", type: "employee_milestone", dedupeKey: `5500:${filingId}:participants:${threshold}`, strength: Math.min(92, 60 + Math.log10(threshold) * 10), summary: `Active benefit-plan participants passed ${threshold.toLocaleString("en-US")} during plan year ${formYear}, by ${signalDate} (${boy.toLocaleString("en-US")} → ${eoy.toLocaleString("en-US")}).`, signalDate, metadata: { metric: "active_plan_participants", threshold, boy, eoy, formYear, timeframe: "within_plan_year", thresholdPassedBy: signalDate } });
  }
  if (boy > 0 && eoy > boy) {
    const growth = ((eoy - boy) / boy) * 100;
    for (const threshold of PARTICIPANT_GROWTH_THRESHOLDS) {
      if (growth >= threshold) out.push({ family: "employee_growth", type: "employee_growth", dedupeKey: `5500:${filingId}:growth:${threshold}`, strength: Math.min(94, 62 + threshold / 4), summary: `Active benefit-plan participants grew ${pct(growth)} during plan year ${formYear}, ending ${signalDate} (${boy.toLocaleString("en-US")} → ${eoy.toLocaleString("en-US")}); passed the ${threshold}% growth level.`, signalDate, metadata: { metric: "active_plan_participant_growth", thresholdPct: threshold, growthPct: growth, boy, eoy, formYear, timeframe: "within_plan_year", periodEnd: signalDate } });
    }
  }
  return out;
}

export function deriveRevenueEvents(args: { source: string; observationId: string; priorRevenue: number | null; currentRevenue: number; signalDate: string }): DerivedGrowthEvent[] {
  const prior = args.priorRevenue ?? 0;
  return REVENUE_THRESHOLDS.filter((threshold) => prior < threshold && args.currentRevenue >= threshold).map((threshold) => ({
    family: "revenue_growth", type: "revenue_milestone", dedupeKey: `${args.source}:${args.observationId}:revenue:${threshold}`,
    strength: Math.min(93, 64 + Math.log10(threshold / 1_000_000) * 12),
    summary: args.priorRevenue == null
      ? `Estimated revenue is at or above ${money(threshold)} as of ${args.signalDate} (${args.source}).`
      : `Estimated revenue crossed ${money(threshold)} by ${args.signalDate} (${args.source}).`, signalDate: args.signalDate,
    metadata: { metric: "estimated_revenue", source: args.source, threshold, priorRevenue: args.priorRevenue, currentRevenue: args.currentRevenue },
  }));
}

export function deriveContractEvents(metrics: ContractMetrics, asOf = new Date()): DerivedGrowthEvent[] {
  const date = isoDay(asOf), out: DerivedGrowthEvent[] = [];
  if (metrics.newAwards30d > 0) out.push({ family: "federal_contract", type: "federal_new_award", dedupeKey: `contract-metrics:${date}:new-awards`, strength: 86, summary: `${metrics.newAwards30d} new federal award${metrics.newAwards30d === 1 ? "" : "s"} over the 30 days ending ${date}; ${money(metrics.obligations30d)} obligated in that period.`, signalDate: date, metadata: { ...metrics, valueKind: "obligations", timeframeDays: 30, periodEnd: date } });
  if (metrics.priorObligations365d <= 0 && metrics.obligations365d > 0) out.push({ family: "federal_contract", type: "federal_first_activity", dedupeKey: `contract-metrics:${date}:first-activity`, strength: 84, summary: `New federal contract activity: ${money(metrics.obligations365d)} obligated over the 12 months ending ${date}.`, signalDate: date, metadata: { ...metrics, valueKind: "obligations", timeframeDays: 365, periodEnd: date } });
  if (metrics.ttmGrowthPct != null && metrics.ttmGrowthPct >= 25 && metrics.ttmDelta > 0) out.push({ family: "federal_contract", type: "federal_obligation_growth", dedupeKey: `contract-metrics:${date}:ttm-growth`, strength: Math.min(95, 72 + metrics.ttmGrowthPct / 10), summary: `Federal obligations grew ${pct(metrics.ttmGrowthPct)} over 1 year: ${money(metrics.priorObligations365d)} → ${money(metrics.obligations365d)} for the 12 months ending ${date}.`, signalDate: date, metadata: { ...metrics, valueKind: "obligations", timeframeDays: 365, periodEnd: date } });
  if (metrics.positiveModificationDollars90d > 0) out.push({ family: "federal_contract", type: "federal_incumbent_funding", dedupeKey: `contract-metrics:${date}:positive-mods`, strength: 82, summary: `Existing federal awards received ${money(metrics.positiveModificationDollars90d)} in positive funding modifications over the 90 days ending ${date}.`, signalDate: date, metadata: { ...metrics, valueKind: "obligations", timeframeDays: 90, periodEnd: date } });
  if (metrics.activeAwardCeiling > 0) out.push({ family: "federal_contract", type: "federal_active_ceiling", dedupeKey: `contract-metrics:${date}:active-ceiling`, strength: 60, summary: `As of ${date}: ${money(metrics.activeAwardCeiling)} active federal contract ceiling; ${money(metrics.activeAwardObligations)} obligated to date.`, signalDate: date, metadata: { ...metrics, ceiling: metrics.activeAwardCeiling, obligations: metrics.activeAwardObligations, valueKind: "ceiling_vs_obligations", asOf: date } });
  return out;
}
