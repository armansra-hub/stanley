/** Provider-neutral evidence labels. These are public-intelligence features, never TAM grades. */
export const EVIDENCE_SIGNAL_TYPES = [
  "funding", "new_entity", "ma", "gov_contract", "finance_hire", "press", "erp_tech",
  "hiring_velocity", "employee_growth", "federal_award", "federal_subaward",
  "sam_award_notice", "operating_change", "news", "none",
] as const;

export type EvidenceSignalType = typeof EVIDENCE_SIGNAL_TYPES[number];
export type CompanyRelationship = "direct" | "related" | "unrelated" | "unknown";

export interface SemanticCriterion {
  id: string;
  /** One bounded yes/no semantic question, not an instruction to execute an action. */
  instructions: string;
}

export interface EvaluateEvidenceInput {
  text: string;
  companyName?: string;
  companyDomain?: string;
  sourceKind?: string;
  sourceUrl?: string;
  title?: string;
  privacy?: "public" | "private_excerpt";
  criteria?: readonly SemanticCriterion[];
  /** Candidate verbatim spans of text; the model selects an ID, never generates a quote. */
  sections?: readonly { id: string; text: string }[];
  /** Optional past corrections. These examples are context, not facts about this observation. */
  feedbackExamples?: readonly { text: string; correction: string }[];
  abortSignal?: AbortSignal;
}

export interface EvidenceAttributes {
  signalType: EvidenceSignalType;
  companyRelationship: CompanyRelationship;
  /** A supplied section supporting the principal finding, or null when none was selected. */
  evidenceSectionId: string | null;
  /** Model probabilities and normalized rubric positions, not measured accuracy. */
  companyRelevance: number;
  concreteEvent: number;
  isAcquirer: number;
  operationalComplexity: number;
  growthRelevance: number;
  evidenceStrength: number;
  requiresResearch: number;
}

export interface EvaluationUsage {
  /** Null means the provider did not report usage; it does not mean free. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export type EvaluationFailureKind =
  | "invalid_input" | "invalid_response" | "authentication" | "billing"
  | "rate_limit" | "timeout" | "cancelled" | "provider_unavailable" | "invalid_request"
  | "privacy_not_authorized";

export interface EvaluationFailure {
  kind: EvaluationFailureKind;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}

export interface EvaluationMetadata {
  provider: "typesafe-direct";
  /** Direct API's reported model identifier, when supplied. */
  responseModel?: string;
  /** Provider-reported distribution concentration, not a correctness certificate. */
  confidence?: Record<string, number>;
}

export type EvaluateEvidenceResult = {
  model: string;
  questionVersion: string;
  usage: EvaluationUsage | null;
} & ({
  ok: true;
  attributes: EvidenceAttributes;
  criteria: Record<string, number>;
  metadata: EvaluationMetadata;
} | {
  ok: false;
  error: EvaluationFailure;
});
