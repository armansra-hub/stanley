export const PARTICIPANT_THRESHOLDS = [50, 100, 250, 500, 1_000] as const;
export const PARTICIPANT_GROWTH_THRESHOLDS = [25, 50, 100] as const;
export const REVENUE_THRESHOLDS = [10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000, 100_000_000] as const;

export interface TamIdentity {
  id: string;
  name: string;
  domain: string | null;
  website_raw?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface GovernmentIdentityCandidate {
  legalName: string;
  dbaName?: string | null;
  domain?: string | null;
  city?: string | null;
  state?: string | null;
  uei?: string | null;
  cageCode?: string | null;
}

export interface IdentityDecision {
  status: "verified" | "pending" | "rejected";
  method: "domain" | "exact_name_address" | "exact_name_state" | "name_only" | "conflict" | "none";
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface AwardFact {
  generatedAwardId: string;
  startDate: string | null;
  endDate: string | null;
  awardCeiling: number;
  currentAwardAmount: number;
  totalObligations: number;
  awardingAgency: string | null;
}

export interface TransactionFact {
  externalTransactionId: string;
  generatedAwardId: string;
  actionDate: string;
  obligation: number;
  modificationNumber?: string | null;
}

export interface ContractMetrics {
  obligations30d: number;
  priorObligations30d: number;
  obligations90d: number;
  priorObligations90d: number;
  obligations365d: number;
  priorObligations365d: number;
  ttmDelta: number;
  ttmGrowthPct: number | null;
  newAwards30d: number;
  newAwards90d: number;
  newAwards365d: number;
  transactionCount90d: number;
  positiveModifications90d: number;
  positiveModificationDollars90d: number;
  deobligationDollars90d: number;
  activeAwardCount: number;
  activeAwardCeiling: number;
  activeAwardObligations: number;
  agencyCount365d: number;
  largestAwardCeiling: number;
  largestAwardObligations: number;
  largestTransaction: number;
  firstAwardDate: string | null;
  latestAwardDate: string | null;
  expiringAwards180d: number;
}

export interface DerivedGrowthEvent {
  family: string;
  type: string;
  dedupeKey: string;
  strength: number;
  summary: string;
  signalDate: string | null;
  metadata: Record<string, unknown>;
}

