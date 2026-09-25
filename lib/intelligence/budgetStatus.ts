/** Reporting contract only. Dispatch authorization remains in the database. */
type BudgetCommon = {
  available: true; asOf: string; policyId: string; enabled: boolean; policyEnabled: boolean; processingEnabled: boolean;
  blockedReason: string | null; initialUsedUsd: number; maintenanceUsedUsd: number; todayUsedUsd: number;
  inFlightReserveUsd: number; unknownReserveUsd: number; carriedUnknownUsd: number;
  fundingConfirmed: boolean; legacyReconciled: boolean; openingLiabilityUsd: number | null;
};
export type CappedJevBudget = BudgetCommon & {
  enforcement: "budget_caps"; phase: "initial" | "maintenance" | "before_start" | "expired";
  initialMaxUsd: number; dailyCapUsd: number; maintenanceLimitUsd: number;
  totalRemainingUsd: number; dailyRemainingUsd: number; initialRemainingUsd: number; maintenanceRemainingUsd: number;
  nextResetAt: string | null; initialExpiresAt: string; maintenanceExpiresAt: string;
};
export type ProviderBalanceJevBudget = BudgetCommon & {
  enforcement: "provider_balance"; phase: "ongoing";
  initialMaxUsd: null; dailyCapUsd: null; maintenanceLimitUsd: null;
  totalRemainingUsd: null; dailyRemainingUsd: null; initialRemainingUsd: null; maintenanceRemainingUsd: null;
  nextResetAt: null; initialExpiresAt: null; maintenanceExpiresAt: null;
  /** Only a provider-observed balance may populate this pair. Ledger estimates are not a balance. */
  providerBalanceUsd: number | null; providerBalanceAsOf: string | null;
};
export type JevBudgetSnapshot = { available: false } | CappedJevBudget | ProviderBalanceJevBudget;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const usageFields = ["initialUsedUsd", "maintenanceUsedUsd", "todayUsedUsd", "inFlightReserveUsd", "unknownReserveUsd", "carriedUnknownUsd"];
const allowanceFields = ["initialMaxUsd", "dailyCapUsd", "maintenanceLimitUsd", "totalRemainingUsd", "dailyRemainingUsd", "initialRemainingUsd", "maintenanceRemainingUsd"];

export function parseJevBudgetStatus(value: unknown): JevBudgetSnapshot {
  if (!record(value) || !usageFields.every(key => amount(value[key]))
    || !["enabled", "policyEnabled", "processingEnabled", "fundingConfirmed", "legacyReconciled"].every(key => typeof value[key] === "boolean")
    || !date(value.asOf) || typeof value.policyId !== "string"
    || !(value.blockedReason === null || typeof value.blockedReason === "string")
    || !(value.openingLiabilityUsd === null || amount(value.openingLiabilityUsd))) return { available: false };
  // Missing enforcement is the previous capped deployment, never uncapped mode.
  const enforcement = value.enforcement === undefined ? "budget_caps" : value.enforcement;
  if (enforcement === "provider_balance") {
    if (value.phase !== "ongoing" || !allowanceFields.every(key => value[key] === null)
      || !["nextResetAt", "initialExpiresAt", "maintenanceExpiresAt"].every(key => value[key] === null)
      || !((value.providerBalanceUsd === null && value.providerBalanceAsOf === null)
        || (typeof value.providerBalanceUsd === "number" && Number.isFinite(value.providerBalanceUsd) && date(value.providerBalanceAsOf)))) return { available: false };
  } else if (enforcement === "budget_caps") {
    if (!allowanceFields.every(key => amount(value[key]))
      || !["initial", "maintenance", "before_start", "expired"].includes(String(value.phase))
      || !["initialExpiresAt", "maintenanceExpiresAt"].every(key => date(value[key]))
      || !(value.nextResetAt === null || date(value.nextResetAt))) return { available: false };
  } else return { available: false };
  return { ...value, enforcement, available: true } as JevBudgetSnapshot;
}
