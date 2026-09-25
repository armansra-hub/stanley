import type { ProviderBalanceJevBudget } from "@/lib/intelligence/budgetStatus";
export const providerBudget: ProviderBalanceJevBudget = {
  available: true, enforcement: "provider_balance", phase: "ongoing", asOf: "2026-09-25T20:00:00Z", policyId: "existing-policy",
  enabled: true, policyEnabled: true, processingEnabled: true, blockedReason: null,
  initialUsedUsd: 12.88, maintenanceUsedUsd: 0.49, todayUsedUsd: 0.49,
  inFlightReserveUsd: 0, unknownReserveUsd: 0.011, carriedUnknownUsd: 0.011,
  fundingConfirmed: true, legacyReconciled: true, openingLiabilityUsd: 1.15,
  initialMaxUsd: null, dailyCapUsd: null, maintenanceLimitUsd: null, totalRemainingUsd: null,
  dailyRemainingUsd: null, initialRemainingUsd: null, maintenanceRemainingUsd: null,
  nextResetAt: null, initialExpiresAt: null, maintenanceExpiresAt: null,
  providerBalanceUsd: null, providerBalanceAsOf: null,
};
