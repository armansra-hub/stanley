/** Display-only federal provenance. Related entities never contribute to direct totals. */
export type FederalRow = Record<string, unknown>;
export interface FederalRelationshipEvidence {
  relationship: "reported_parent" | "reported_child";
  directEntityId: string;
  reportingEntityId: string;
  reportingUei: string;
  reportedParentUei: string;
  source: string;
  sourceUrl: string;
  observedAt: string;
}
export interface RelatedFederalEntity {
  entity: FederalRow;
  relationships: FederalRelationshipEvidence[];
  awards: FederalRow[];
  awardsTruncated: boolean;
}
export interface FederalCoverage {
  status: "direct_awards" | "registration_only" | "verified_identity_only" | "identity_review" | "no_verified_match";
  directAwardCount: number;
  pendingIdentityCount: number;
  registrationCount: number;
  latestAwardObservedAt: string | null;
  historyComplete: boolean;
  sources?: FederalSourceCoverage[];
  relatedEntitiesTruncated: boolean;
  gaps: string[];
}
export interface FederalSourceCoverage {
  source: string; status: "unsearched" | "partial" | "complete" | "no_match" | "ambiguous" | "failed";
  scope: string; searched_from: string | null; searched_through: string | null;
  last_attempted_at: string | null; last_completed_at: string | null;
}

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const uei = (value: unknown): string | null => nonblank(value) && /^[A-Z0-9]{12}$/i.test(value.trim()) ? value.trim().toUpperCase() : null;

/** A parent label alone, a CRM parent guess, or an unsupported URL is never evidence. */
export function federalRelationshipWitness(entity: FederalRow): Omit<FederalRelationshipEvidence, "relationship" | "directEntityId"> | null {
  const ownUei = uei(entity.uei), parentUei = uei(entity.parent_uei);
  if (!nonblank(entity.id) || !ownUei || !parentUei || ownUei === parentUei
      || !nonblank(entity.source) || !nonblank(entity.source_url) || !nonblank(entity.observed_at)
      || !Number.isFinite(Date.parse(entity.observed_at))) return null;
  try {
    const url = new URL(entity.source_url);
    const sam = /^(?:sam\.gov|sam)$/i.test(entity.source) || /^SAM\.gov public monthly extract$/i.test(entity.source);
    const spending = /^USAspending$/i.test(entity.source);
    if (url.protocol !== "https:" || url.username || url.password
        || !(sam && (url.hostname === "sam.gov" || url.hostname.endsWith(".sam.gov"))
          || spending && (url.hostname === "usaspending.gov" || url.hostname.endsWith(".usaspending.gov")))) return null;
  } catch { return null; }
  return { reportingEntityId: entity.id, reportingUei: ownUei, reportedParentUei: parentUei,
    source: entity.source, sourceUrl: entity.source_url, observedAt: entity.observed_at };
}

export function bindRelatedFederalEntities(direct: FederalRow[], candidates: FederalRow[]): RelatedFederalEntity[] {
  const directIds = new Set(direct.map((row) => row.id));
  const related = new Map<string, RelatedFederalEntity>();
  for (const candidate of candidates) {
    if (!nonblank(candidate.id) || directIds.has(candidate.id) || !uei(candidate.uei)) continue;
    const relationships: FederalRelationshipEvidence[] = [];
    for (const anchor of direct) {
      if (anchor.match_status !== "verified" || !nonblank(anchor.id)) continue;
      const parentWitness = federalRelationshipWitness(anchor);
      if (parentWitness && parentWitness.reportedParentUei === uei(candidate.uei)) {
        relationships.push({ ...parentWitness, relationship: "reported_parent", directEntityId: anchor.id });
      }
      const childWitness = federalRelationshipWitness(candidate);
      if (childWitness && childWitness.reportedParentUei === uei(anchor.uei)) {
        relationships.push({ ...childWitness, relationship: "reported_child", directEntityId: anchor.id });
      }
    }
    const conflicting = relationships.some((relationship) => relationships.some((other) => other.directEntityId === relationship.directEntityId
      && other.relationship !== relationship.relationship));
    if (relationships.length && !conflicting) related.set(candidate.id, { entity: candidate, relationships, awards: [], awardsTruncated: false });
  }
  return [...related.values()];
}

export function federalAwardLabel(awardType: unknown): string {
  const row = awardType && typeof awardType === "object" ? awardType as FederalRow : null;
  const evidence = row?.evidence && typeof row.evidence === "object" ? row.evidence as FederalRow : {};
  const type = String(row ? evidence.awardTypeCode || row.award_type || "" : awardType ?? "").trim();
  if (/^IDV(?:_|\b)|indefinite[ -]delivery vehicle|blanket purchase agreement|government[ -]wide acquisition|federal supply schedule/i.test(type)) return "Contract vehicle (IDV)";
  if (/delivery order|task order|BPA call/i.test(type)) return "Order / call";
  if (/^[A-D]$/.test(type)) return "Contract award";
  return type || "Federal award";
}

/** Source facts only: potential options are never represented as exercised work. */
export function federalLifecycleFacts(award: FederalRow): string[] {
  const evidence = award.evidence && typeof award.evidence === "object" ? award.evidence as FederalRow : {};
  const isVehicle = evidence.awardCategory === "idv" || String(award.generated_award_id ?? "").startsWith("CONT_IDV_");
  const facts: string[] = [];
  const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  if (date(evidence.signedDate)) facts.push(`Signed ${date(evidence.signedDate)}`);
  if (date(award.start_date)) facts.push(`${isVehicle ? "Vehicle begins" : "Performance starts"} ${date(award.start_date)}`);
  if (isVehicle) {
    if (date(evidence.orderingEndDate)) facts.push(`Last date to order ${date(evidence.orderingEndDate)}`);
    if (date(award.end_date)) facts.push(`Reported vehicle period end ${date(award.end_date)}`);
    facts.push("Vehicle ceiling is potential ordering capacity; funded orders are separate awards.");
  } else if (date(award.end_date)) facts.push(`Current performance end ${date(award.end_date)}`);
  if (date(award.potential_end_date)) facts.push(`Potential end including options ${date(award.potential_end_date)}; future options are not confirmed exercised.`);
  if (award.current_award_amount !== null && award.current_award_amount !== undefined && Number.isFinite(Number(award.current_award_amount))) {
    facts.push(`${Number(award.current_award_amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} base plus exercised options; obligations show committed funding.`);
  }
  if (evidence.optionSchedule === "not_provided_by_source") facts.push("Individual option-period dates are not supplied by this source.");
  return facts;
}

export function federalCoverage(entities: FederalRow[], pending: FederalRow[], awards: FederalRow[], relatedEntitiesTruncated = false, sources: FederalSourceCoverage[] = []): FederalCoverage {
  const registrations = entities.filter((entity) => nonblank(entity.registration_status));
  const dates = awards.map((award) => award.observed_at).filter((value): value is string => nonblank(value) && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return { status: awards.length ? "direct_awards" : registrations.length ? "registration_only" : entities.length ? "verified_identity_only"
    : pending.length ? "identity_review" : "no_verified_match", directAwardCount: awards.length,
    registrationCount: registrations.length, pendingIdentityCount: pending.length, latestAwardObservedAt: dates[0] ?? null,
    historyComplete: entities.length > 0 && ["usaspending", "usaspending-subawards"].every((source) => sources.some((row) => row.source === source && row.status === "complete")), sources, relatedEntitiesTruncated,
    gaps: ["Completion applies only to the named source scope and frozen search dates; missing records do not establish an absence of federal business.",
      "USAspending contract and vehicle collection covers source records from October 2007 onward; earlier awards, undisclosed records and state/local awards are outside that source scope."] };
}

export const FEDERAL_STATUS_TEXT: Record<FederalCoverage["status"], { label: string; detail: string }> = {
  direct_awards: { label: "Direct federal award history", detail: "Awards are attached to verified legal entities for this account." },
  registration_only: { label: "Federal registration on file", detail: "Registration evidence is stored; no direct awards are stored for the verified entities." },
  verified_identity_only: { label: "Verified federal identity", detail: "The entity is verified; direct award history has not been established in stored evidence." },
  identity_review: { label: "Federal identity needs review", detail: "Candidate identities are unverified and do not establish this account's federal awards." },
  no_verified_match: { label: "No verified federal match stored", detail: "Federal contractor status is unresolved for this account." },
};
