/** Read-only projections. Never return raw job results, leases or provider cursors. */
export const COMPANY_FIELDS = "id,name,domain,website_raw,city,state,netsuite_internal_id,status,lists,tal_claimed,record_dead,description,subindustry,ns_industry,last_checked_at,ats_checked_at,site_checked_at,fmcsa_checked_at,sos_checked_at";
export const OBSERVATION_FIELDS = "id,company_id,source_kind,source_url,title,evidence_text,content_hash,event_date,observed_at,is_current,feedback_excluded,metadata,sections";
export const JOB_FIELDS = "id,observation_id,kind,status,priority,due_at,attempts,lease_until,created_at,finished_at,codex_news_request_id";
export const SOURCE_FIELDS = "company_id,source_key,complete,last_attempt_at,last_success_at,last_error,coverage_status,next_attempt_at,cursor";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CoverageQuery = { view: "companies" | "evidence" | "sources" | "jobs" | "registry-capture"; scope: "all" | "tam" | "tal"; limit: number; after: string | null; companyId: string | null; companyIds?: string[]; observationId: string | null; sourceKey: "fmcsa" | "cosos" | null };
export function parseCoverageQuery(params: URLSearchParams): CoverageQuery {
  const allowed = new Set(["view", "scope", "limit", "after", "companyId", "companyIds", "observationId", "sourceKey"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("invalid_query");
  const view = params.get("view") ?? "companies", scope = params.get("scope") ?? "all";
  if (!["companies", "evidence", "sources", "jobs", "registry-capture"].includes(view) || !["all", "tam", "tal"].includes(scope)) throw new Error("invalid_query");
  const rawIds = params.get("companyIds"), companyIds = rawIds === null ? undefined : rawIds.split(",").map(id => id.toLowerCase());
  if (companyIds && (view !== "sources" || companyIds.length > 100 || companyIds.some(id => !UUID.test(id))
    || new Set(companyIds).size !== companyIds.length || params.has("companyId") || params.has("after"))) throw new Error("invalid_query");
  const rawLimit = params.get("limit") ?? (companyIds ? "1000" : view === "registry-capture" ? "1" : view === "evidence" ? "5" : "100");
  if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > (companyIds ? 1000 : view === "evidence" ? 10 : 100)) throw new Error("invalid_query");
  const companyId = params.get("companyId"), observationId = params.get("observationId"), after = params.get("after");
  const sourceKey = params.get("sourceKey");
  if (view === "registry-capture" ? !["fmcsa", "cosos"].includes(sourceKey ?? "") || rawLimit !== "1" || after !== null : sourceKey !== null) throw new Error("invalid_query");
  if ((view === "companies" ? companyId !== null : !companyIds && (!companyId || !UUID.test(companyId)))
    || (view === "jobs" ? !observationId || !UUID.test(observationId) : observationId !== null)
    || (after !== null && (view === "sources" ? !/^[a-zA-Z0-9:._/-]{1,512}$/.test(after) : !UUID.test(after)))) throw new Error("invalid_query");
  return { view: view as CoverageQuery["view"], scope: scope as CoverageQuery["scope"], limit: Number(rawLimit), companyId, ...(companyIds ? { companyIds } : {}), observationId, after, sourceKey: sourceKey as CoverageQuery["sourceKey"] };
}
export function membershipFilter(scope: CoverageQuery["scope"]): string {
  const tal = "and(tal_claimed.eq.true,or(lists.is.null,lists.not.cs.{tam_duplicate}))";
  const tam = "and(lists.cs.{netsuite_tam},lists.not.cs.{tam_duplicate},status.neq.removed_from_tam)";
  return scope === "tal" ? tal : scope === "tam" ? tam : `${tal},${tam}`;
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function pick(row: Record<string, unknown>, fields: string) { return Object.fromEntries(fields.split(",").map(key => [key, row[key] ?? null])); }
const publicMetadata = ["feedUrl", "sourceName", "companyName", "companyDomain", "netsuiteInternalId", "sourceDates", "evidenceKind", "publisherUrl", "textTruncated", "sourceTruncated", "discoveryQuery", "eventDateBasis", "researchCriteria", "researchCriteriaBasis", "researchCriteriaModel", "researchCriteriaSubindustry", "sourceCharacters", "retainedCharacters", "documentContentHash", "publisherResolution", "articleBodyAvailable", "articleFetchError", "httpStatus", "meaningfulContentHash", "collectionMode", "descriptionAvailable", "atsType", "atsJobKey", "listingChange", "isClientPlacement", "jobDateKind"];
export function evidenceProjection(row: Record<string, unknown>) {
  const result = pick(row, OBSERVATION_FIELDS), meta = record(row.metadata);
  // Known collector provenance only. Arbitrary metadata is not a credential channel.
  const metadata: Record<string, unknown> = Object.fromEntries(publicMetadata.filter(key => key in meta &&
    (meta[key] === null || ["string", "boolean", "number"].includes(typeof meta[key]))).map(key => [key, meta[key]]));
  metadata.sourceDates = Array.isArray(meta.sourceDates) ? meta.sourceDates.map(value => pick(record(value), "kind,value,source")) : null;
  metadata.researchCriteria = Array.isArray(meta.researchCriteria) ? meta.researchCriteria.filter(value => typeof value === "string") : null;
  metadata.discovery = pick(record(meta.discovery), "url,title,collector,eventDate");
  (metadata.discovery as Record<string, unknown>).requestedUrls = Array.isArray(record(meta.discovery).requestedUrls)
    ? (record(meta.discovery).requestedUrls as unknown[]).filter(v => typeof v === "string") : null;
  metadata.atsRoleCategories = Array.isArray(meta.atsRoleCategories) ? meta.atsRoleCategories.filter(v => typeof v === "string") : null;
  metadata.atsBoardIdentifierPresent = typeof meta.atsToken === "string" && meta.atsToken.length > 0;
  metadata.publisherIdentity = pick(record(meta.publisherIdentity), "names,addresses,sourceUrl");
  result.metadata = metadata;
  result.sections = Array.isArray(row.sections) ? row.sections.map(value => pick(record(value), "id,start,end,text")) : null;
  return { ...result, retainedTextCharacters: typeof row.evidence_text === "string" ? row.evidence_text.length : 0,
    responseTextTruncated: false, originalCompleteness: meta.textTruncated === true || meta.sourceTruncated === true ? "truncated"
      : meta.articleBodyAvailable === false || meta.evidenceKind === "headline_only" ? "body_unavailable" : "requires_full_source_review",
    metadataProjection: "public_collector_fields_only", metadataFieldsOmitted: Object.keys(meta).filter(key => !(key in metadata)),
    completenessAuthority: "exact_claim_packet_required_for_review_including_ats_board_identifier" };
}
export function sourceProjection(row: Record<string, unknown>) {
  const cursor = record(row.cursor);
  const revisit = record(cursor.revisit);
  const revisitCount = (key: string) => typeof revisit[key] === "number" && Number.isSafeInteger(revisit[key]) && (revisit[key] as number) >= 0 ? revisit[key] : null;
  const revisitDate = (key: string) => typeof revisit[key] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(revisit[key]) && Number.isFinite(Date.parse(revisit[key])) ? revisit[key] : null;
  const counts: Record<string, number> = {};
  for (const key of ["pending", "pendingUrls", "failedUrls", "retryQueue", "deadLetters", "knownUrls", "verifiedUrls", "seen"]) {
    if (Array.isArray(cursor[key])) counts[key] = cursor[key].length;
  }
  if (cursor.retries && typeof cursor.retries === "object" && !Array.isArray(cursor.retries)) counts.retries = Object.keys(cursor.retries).length;
  const position: Record<string, number | boolean> = {};
  for (const key of ["offset", "queryCycle", "attemptedPages", "retainedPages", "complete"]) {
    const value = cursor[key]; if (typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) position[key] = value;
  }
  return { ...pick(row, "company_id,source_key,complete,last_attempt_at,last_success_at,coverage_status,next_attempt_at"),
    hasError: row.last_error != null, cursor: { present: row.cursor != null, projection: "counts_and_positions_only", position, counts },
    continuation: { atsScanActive: typeof cursor.scanId === "string" && !!cursor.scanId,
      websiteChangedSinceComplete: typeof cursor.changedSinceComplete === "boolean" ? cursor.changedSinceComplete : null,
      consecutiveFailures: typeof cursor.consecutiveFailures === "number" ? cursor.consecutiveFailures : null,
      revisit: { quietRuns: revisitCount("quietRuns"), intervalHours: revisitCount("intervalHours"), nextDueAt: revisitDate("nextDueAt"), lastChangedAt: revisitDate("lastChangedAt") },
      mappedFields: Object.keys(cursor).filter(key => ["pending", "pendingUrls", "failedUrls", "retryQueue", "deadLetters", "knownUrls", "verifiedUrls", "seen", "retries", "offset", "queryCycle", "attemptedPages", "retainedPages", "complete", "scanId", "changedSinceComplete", "consecutiveFailures", "revisit"].includes(key)),
      otherCursorFieldsPresent: Object.keys(cursor).some(key => !["pending", "pendingUrls", "failedUrls", "retryQueue", "deadLetters", "knownUrls", "verifiedUrls", "seen", "retries", "offset", "queryCycle", "attemptedPages", "retainedPages", "complete", "scanId", "changedSinceComplete", "consecutiveFailures", "revisit"].includes(key)) },
    debtAssessment: "partial_projection_not_proof_of_no_debt" };
}
export function jobProjection(row: Record<string, unknown>, sourceKind: unknown) {
  return { ...pick(row, "id,observation_id,kind,status,priority,due_at,attempts,lease_until,created_at,finished_at"),
    alreadyCodexClaimed: row.codex_news_request_id != null,
    reviewKind: row.kind === "interpret" && ["news", "website", "job"].includes(String(sourceKind)) ? "codex_source" : "not_supported_by_codex_source",
    admissionVerified: false, admissionReason: "canonical_claim_must_check_current_state_and_pending_provider_work" };
}
