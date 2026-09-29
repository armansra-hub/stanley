/** Paid Jev is a classifier for prospect/customer resemblance and Triggered
 * intelligence. This scope is independent of budget mode and funding. Existing
 * exact answers remain readable even when their old workflow is retired. */
export const JEV_CLASSIFIER_POLICY_VERSION = "customer-first-classifier-v1";

export const JEV_CLASSIFIER_SOURCES = {
  operating_catalog: ["account_catalog"],
  public_interpretation: ["news", "website", "job", "government"],
  federal_identity: ["federal_identity", "federal_recipient_identity"],
  event_match: ["event_reconciliation", "award_correspondence"],
} as const;

export type JevPurposeAttribution = { purpose?: string | null; sourceKind?: string | null };

/** Fail closed for missing/unknown source attribution. A broad purpose alone
 * must not authorize customer rereads, arbitrary questions, or TAM grading. */
export function jevPaidPurposeAllowed(context: JevPurposeAttribution | null | undefined): boolean {
  if (!context || !context.purpose || !context.sourceKind
    || !Object.hasOwn(JEV_CLASSIFIER_SOURCES, context.purpose)) return false;
  const sources: readonly string[] = JEV_CLASSIFIER_SOURCES[context.purpose as keyof typeof JEV_CLASSIFIER_SOURCES];
  return sources.includes(context.sourceKind);
}

export const JEV_RETIRED_PURPOSE_REASON = "purpose_retired";
