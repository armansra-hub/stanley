import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { customerReferencePublicUrl } from "./customerReferenceRegistry";
import { customerResearchTextHash, normalizeCustomerResearchProfile, projectCustomerResearchProfile, type CustomerResearchProof } from "./customerResearchProfiles";

type Database = ReturnType<typeof serviceClient>;
type StoredProfile = { customer_id: string; full_profile_sha256: string; research_status: CustomerResearchProof["status"]; profile: CustomerResearchProof; updated_at: string };
type RegistryIdentity = { id: string; name: string; website: string | null; announcement_date: string;
  announcements: { id: string }[]; active: boolean; updated_at: string };
const fields = "customer_id,full_profile_sha256,research_status,profile,updated_at";
const idOk = (value: string) => /^[a-zA-Z0-9_.-]{1,160}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";

export class CustomerResearchError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
function checkStored(row: StoredProfile): StoredProfile {
  if (!row || row.profile?.schema !== "customer-research-proof-v1" || row.profile.customerId !== row.customer_id
    || row.profile.fullProfileSha256 !== row.full_profile_sha256 || row.profile.status !== row.research_status
    || row.profile.sourceStorage !== "private_local_full_text" || row.profile.sources.some(source => Object.hasOwn(source, "text"))) {
    throw new CustomerResearchError("customer_research_proof_invalid");
  }
  return row;
}
export async function loadCustomerResearchPage(input: { after?: string; limit?: number } = {}, db = serviceClient()) {
  const limit = input.limit ?? 25;
  if ((input.after && !idOk(input.after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CustomerResearchError("invalid_customer_research_cursor", 400);
  let query = db.from("intelligence_customer_research_profiles").select(fields).order("customer_id").limit(limit + 1);
  if (input.after) query = query.gt("customer_id", input.after);
  const result = await query;
  if (result.error || !Array.isArray(result.data)) throw new CustomerResearchError("customer_research_unavailable");
  const page = (result.data as StoredProfile[]).map(checkStored), hasMore = page.length > limit;
  const records = page.slice(0, limit);
  if (records.some(row => input.after && row.customer_id <= input.after)) throw new CustomerResearchError("customer_research_cursor_invalid");
  return { records, nextAfter: hasMore ? records[records.length - 1].customer_id : null };
}
/** Keyset reads compact proofs only. No total-cohort cap or paid provider. */
export async function loadCustomerResearchProofs(db = serviceClient()): Promise<CustomerResearchProof[]> {
  const proofs: CustomerResearchProof[] = [];
  let after: string | undefined;
  do {
    const page = await loadCustomerResearchPage({ after, limit: 100 }, db);
    proofs.push(...page.records.map(row => row.profile));
    after = page.nextAfter ?? undefined;
  } while (after);
  return proofs;
}
export async function getCustomerResearchProof(customerId: string, db = serviceClient()): Promise<StoredProfile | null> {
  if (!idOk(customerId)) throw new CustomerResearchError("invalid_customer_id", 400);
  const result = await db.from("intelligence_customer_research_profiles").select(fields).eq("customer_id", customerId).maybeSingle();
  if (result.error) throw new CustomerResearchError("customer_research_unavailable");
  return result.data ? checkStored(result.data as StoredProfile) : null;
}
export type CustomerResearchProgress = {
  total: number; started: number; notStarted: number; draft: number; inProgress: number;
  complete: number; completeWithGaps: number; unresolved: number; facts: number; readPages: number;
  pendingPages: number; unreadPages: number; unavailablePages: number; latestUpdatedAt: string | null;
  origin: "codex_research"; providerCalls: 0;
};
export async function customerResearchProgress(db = serviceClient()): Promise<CustomerResearchProgress> {
  const result = await db.rpc("intelligence_customer_research_progress");
  if (result.error || !object(result.data)) throw new CustomerResearchError("customer_research_progress_unavailable");
  const counts = ["total", "started", "notStarted", "draft", "inProgress", "complete", "completeWithGaps", "unresolved", "facts", "readPages", "pendingPages", "unreadPages", "unavailablePages"];
  if (counts.some(key => !Number.isInteger(result.data[key]) || Number(result.data[key]) < 0)
    || result.data.origin !== "codex_research") throw new CustomerResearchError("customer_research_progress_invalid");
  return result.data as CustomerResearchProgress;
}
export async function loadCustomerResearchSummary(db = serviceClient()): Promise<
  { available: true; progress: CustomerResearchProgress } | { available: false; reason: "customer_research_unavailable" }
> {
  try { return { available: true, progress: await customerResearchProgress(db) }; }
  catch { return { available: false, reason: "customer_research_unavailable" }; }
}

/** Full text enters only transient validation. The exact compact projection is
 * admitted atomically and read back; registry/native source records are untouched. */
export async function saveCustomerResearchProfile(input: unknown, expectedPreviousHash: string | null = null, db = serviceClient()) {
  if (expectedPreviousHash !== null && !/^[a-f0-9]{64}$/.test(expectedPreviousHash)) throw new CustomerResearchError("invalid_previous_hash", 400);
  let profile;
  try { profile = normalizeCustomerResearchProfile(input); }
  catch (error) { throw new CustomerResearchError(error instanceof Error ? error.message : "invalid_customer_research", 400); }
  const identity = await db.from("intelligence_customer_reference_registry").select("id,name,website,announcement_date,announcements,active,updated_at")
    .eq("id", profile.customerId).eq("active", true).maybeSingle();
  if (identity.error) throw new CustomerResearchError("customer_registry_unavailable");
  if (!identity.data) throw new CustomerResearchError("customer_not_in_registry", 404);
  const registry = identity.data as RegistryIdentity;
  const expectedIds = [...new Set((registry.announcements ?? []).map(announcement => announcement.id))].sort();
  // The row itself already establishes customer membership. Compare identity and
  // preserve announcements; do not independently qualify its customer status.
  if (registry.name !== profile.name || JSON.stringify(expectedIds) !== JSON.stringify([...profile.announcementIds].sort())) {
    throw new CustomerResearchError("customer_registry_identity_changed", 409);
  }
  const proof = projectCustomerResearchProfile(profile);
  const write = await db.rpc("intelligence_customer_research_put", {
    p_profile: proof, p_expected_hash: expectedPreviousHash, p_registry_updated_at: registry.updated_at,
  });
  if (write.error) {
    const message = String(write.error.message ?? "");
    throw new CustomerResearchError(/conflict|changed/.test(message) ? "customer_research_write_conflict" : "customer_research_write_failed", /conflict|changed/.test(message) ? 409 : 503);
  }
  const saved = await getCustomerResearchProof(profile.customerId, db);
  if (!saved || saved.full_profile_sha256 !== proof.fullProfileSha256) throw new CustomerResearchError("customer_research_readback_uncertain");
  return { customerId: saved.customer_id, fullProfileSha256: saved.full_profile_sha256, status: saved.research_status,
    coverage: saved.profile.coverage, saved: true, providerCalls: 0 };
}

export type CustomerResearchSavedSource = {
  id: string; url: string; title: string; text: string | null; observedAt: string | null;
  contentHash: string | null; computedHash: string | null; integrity: "verified" | "hash_missing" | "hash_mismatch" | "text_missing";
  origin: "registry" | "checkpoint";
};
function savedSources(raw: unknown, origin: CustomerResearchSavedSource["origin"]): CustomerResearchSavedSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((source): CustomerResearchSavedSource[] => {
    if (!object(source) || !string(source.id) || !idOk(source.id) || !string(source.url) || !customerReferencePublicUrl(source.url)) return [];
    const body = string(source.text) ? source.text : null, storedHash = string(source.contentHash) ? source.contentHash : string(source.textSha256) ? source.textSha256 : null;
    const computedHash = body === null ? null : customerResearchTextHash(body);
    return [{ id: source.id, url: source.url, title: string(source.title) ? source.title : source.url, text: body,
      observedAt: string(source.observedAt) ? source.observedAt : null, contentHash: storedHash, computedHash,
      integrity: body === null ? "text_missing" : !storedHash ? "hash_missing" : computedHash === storedHash ? "verified" : "hash_mismatch", origin }];
  });
}

/** Read-only export of the already-collected public evidence. A saved capture
 * is not automatically marked read by Codex, and native completion is not copied. */
export async function loadCustomerResearchSavedSources(input: { customerId: string; offset?: number; limit?: number; registryUpdatedAt?: string }, db: Database = serviceClient()) {
  const offset = input.offset ?? 0, limit = input.limit ?? 10;
  if (!idOk(input.customerId) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 25
    || (offset > 0 && !input.registryUpdatedAt)) throw new CustomerResearchError("invalid_customer_source_cursor", 400);
  const result = await db.from("intelligence_customer_reference_registry")
    .select("id,name,website,domain,announcement_date,announcements,candidate_urls,sources,source_status,source_checkpoint,updated_at")
    .eq("id", input.customerId).eq("active", true).maybeSingle();
  if (result.error) throw new CustomerResearchError("customer_sources_unavailable");
  if (!result.data) throw new CustomerResearchError("customer_not_in_registry", 404);
  const row = result.data;
  if (input.registryUpdatedAt && input.registryUpdatedAt !== row.updated_at) throw new CustomerResearchError("customer_sources_changed", 409);
  const checkpoint = object(row.source_checkpoint) ? row.source_checkpoint : {};
  const all = [...savedSources(row.sources, "registry"), ...savedSources(checkpoint.sources, "checkpoint")];
  const unexportedSources = (Array.isArray(row.sources) ? row.sources.length : 0)
    + (Array.isArray(checkpoint.sources) ? checkpoint.sources.length : 0) - all.length;
  const unique = [...new Map(all.map(source => [`${source.id}:${source.url}:${source.computedHash ?? "missing"}`, source])).values()];
  const page = unique.slice(offset, offset + limit);
  const attempts = object(checkpoint.attempts) ? Object.entries(checkpoint.attempts).flatMap(([url, attempt]) => {
    if (!customerReferencePublicUrl(url) || !object(attempt)) return [];
    return [{ url, outcome: string(attempt.outcome) ? attempt.outcome : null, code: string(attempt.code) ? attempt.code : null,
      at: string(attempt.at) ? attempt.at : null, finalUrl: customerReferencePublicUrl(attempt.finalUrl) ? attempt.finalUrl : null }];
  }) : [];
  const queue = Array.isArray(checkpoint.queue) ? checkpoint.queue.flatMap(item => object(item) && customerReferencePublicUrl(item.url) ? [item.url] : []) : [];
  return { customerId: row.id, name: row.name, website: row.website, domain: row.domain, announcementDate: row.announcement_date,
    announcements: row.announcements, candidateUrls: row.candidate_urls, registryUpdatedAt: row.updated_at,
    sourceStatus: row.source_status, sources: page, totalSources: unique.length, nextOffset: offset + page.length < unique.length ? offset + page.length : null,
    checkpoint: { attempts, queue, sourceGaps: Array.isArray(checkpoint.sourceGaps) ? checkpoint.sourceGaps.filter(string) : [] },
    unexportedSources, ...(unexportedSources ? { exportGap: "Source records with invalid IDs or unsafe URLs were not exported." } : {}),
    providerCalls: 0, researchStatusChanged: false };
}
