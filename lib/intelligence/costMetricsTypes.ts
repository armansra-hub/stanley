/** Usage reported by TypeSafe, with budget holds kept separate from estimates. */
export type JevCostTotals = {
  requests: number;
  knownUsageRequests: number;
  reportedInputTokens: number;
  estimatedUsd: number;
  unknownUsageRequests: number;
  unknownUsageReserveUsd: number;
  inFlightRequests: number;
  inFlightReserveUsd: number;
};
export type JevCostGroup = JevCostTotals & { key: string };
export type JevCostPeriod = {
  totals: JevCostTotals;
  byPurpose: JevCostGroup[];
  byActivity: JevCostGroup[];
  byWorkload: JevCostGroup[];
};
export type JevCostMetrics = {
  asOf: string;
  monthStart: string;
  usdPerMillionInputTokens: number;
  attributionStartedAt: string | null;
  month: JevCostPeriod;
  last24h: JevCostPeriod;
  /** Optional during a rolling database/code deployment. */
  last1h?: JevCostPeriod;
};
export type JevCostSnapshot = ({ available: true } & JevCostMetrics) | { available: false };
