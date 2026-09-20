import { FEDERAL_STATUS_TEXT, type FederalCoverage, type FederalRow, type FederalSourceCoverage } from "./federalPresentation";

export const FEDERAL_COVERAGE_SOURCES = [
  { source: "federal-discovery", label: "USAspending recipient search" },
  { source: "usaspending", label: "Contracts, vehicles and transactions" },
  { source: "usaspending-subawards", label: "Reported subawards" },
  { source: "sam-entity", label: "SAM registration search" },
] as const;

type CoverageState = "unsearched" | "partial" | "complete" | "no_verified_match" | "needs_identity" | "failed";
type SourceWithDetail = FederalSourceCoverage & { detail?: { stage?: unknown; reason?: unknown; collection?: unknown } | null };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Display saved collection state without converting a missed/unfinished query
 * into a claim that a company has no government business. */
export function federalSourcePresentation(row?: SourceWithDetail): { state: CoverageState; label: string; detail: string; reason: string | null; collection: string | null } {
  const reason = text(row?.detail?.reason), collection = text(row?.detail?.collection);
  const context = { reason, collection };
  if (!row || row.status === "unsearched") return { ...context, state: "unsearched", label: "Not searched yet", detail: "No completed search is recorded for this source." };
  if (row.status === "failed") return { ...context, state: "failed", label: "Query failed", detail: "The latest query did not finish. Previously stored evidence is still available." };
  if (row.status === "ambiguous" || row.status === "partial" && /^(?:not_linked|identity_not_verified|recipient_identity_ambiguous|company_identity_changed|no_verified_entity|verified_identity_required)$/.test(reason ?? ""))
    return { ...context, state: "needs_identity", label: "Awaiting identity evidence", detail: "A recipient identity still needs to be established before this search can attach account activity." };
  if (row.status === "partial") return { ...context, state: "partial", label: "Search unfinished", detail: "The saved search has remaining pages or stages. Current results cover only the work completed so far." };
  if (row.status === "no_match") return { ...context, state: "no_verified_match", label: "Search complete · no verified match", detail: "This search finished without establishing a verified match within its saved source scope." };
  return { ...context, state: "complete", label: "Search complete", detail: "The saved search completed for the source and date range below." };
}

export function federalCoverageHeadline(coverage: FederalCoverage): { label: string; detail: string } {
  if (["direct_awards", "registration_only", "verified_identity_only"].includes(coverage.status)) return FEDERAL_STATUS_TEXT[coverage.status];
  if (coverage.pendingIdentityCount > 0 || coverage.status === "identity_review") return {
    label: "Candidates awaiting identity evidence", detail: "Possible recipients are stored below. Their activity is separate from this account’s verified direct awards.",
  };
  const states = (coverage.sources ?? []).map(row => federalSourcePresentation(row));
  if (states.some(row => row.state === "failed")) return { label: "Federal search encountered a query failure", detail: "A failed query is unresolved coverage. See the affected source and last attempt below." };
  if (states.some(row => row.state === "needs_identity")) return { label: "Federal identity evidence still needed", detail: "The saved search has not established which recipient belongs to this account." };
  if (states.some(row => row.state === "partial")) return { label: "Federal search is unfinished", detail: "Remaining search work may add recipients or awards. See each source’s progress below." };
  if (states.some(row => row.state === "no_verified_match")) return { label: "Completed search found no verified match", detail: "This result applies to the completed source searches below. Sources without a completed search remain unresolved." };
  return FEDERAL_STATUS_TEXT.no_verified_match;
}

/** This is the original stored decision, not a reinterpretation of its answers. */
export function federalIdentityDecision(entity: FederalRow): { label: string; detail: string; raw: Record<string, unknown> | null } {
  const raw = object(object(entity.match_evidence)?.jevIdentity);
  if (entity.match_status === "verified") return { label: "Same legal entity · verified", detail: "Awards for this recipient count toward this account’s direct totals.", raw };
  if (raw?.outcome === "related_company") return { label: "Related-company candidate", detail: "Jev identified a possible company relationship. A related award binding has not been established for this candidate.", raw };
  if (raw?.outcome === "same_company") return { label: "Same-company candidate", detail: "Jev identified the same company; the saved identity binding is still pending.", raw };
  if (raw?.outcome === "different_company") return { label: "Different-company decision", detail: "The stored Jev decision identifies a different company. This candidate does not establish account awards.", raw };
  return { label: "Candidate awaiting identity evidence", detail: "More identity evidence is needed to establish this recipient’s relationship to the account.", raw };
}

export function federalPublicSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null; }
  catch { return null; }
}
