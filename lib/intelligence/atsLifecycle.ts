import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { scanJob, type AtsJob, type AtsJobBatch, type AtsType } from "@/lib/sources/ats";
import { canonicalEvidenceUrl, enqueueObservation } from "./observations";

export type AtsRoleCategory = "finance" | "billing" | "project_accounting" | "implementation" | "integration" | "business_systems" | "operations";
const rolePatterns: [AtsRoleCategory, RegExp][] = [
  ["billing", /\b(?:billing|revenue operations?|accounts receivable|order[- ]to[- ]cash|quote[- ]to[- ]cash)\b/i],
  ["project_accounting", /\b(?:project account(?:ant|ing)|project controls?|job costing)\b/i],
  ["implementation", /\b(?:implement(?:ation|ing)|erp rollout|migration)\b/i],
  ["integration", /\b(?:integration|multi[- ]entity|consolidation|intercompany)\b/i],
  ["business_systems", /\b(?:business systems?|financial systems?|erp|systems? analyst|systems? administrator)\b/i],
  ["operations", /\b(?:operations?|supply chain|logistics|inventory|procurement)\b/i],
];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();

export function atsRoleCategories(job: AtsJob): AtsRoleCategory[] {
  const scan = scanJob(job.title, job.description);
  if (scan.isClientPlacement) return [];
  const categories: AtsRoleCategory[] = scan.isFinance ? ["finance"] : [];
  // A title identifies the role; operational detail is considered only for
  // operating/finance roles, not an incidental ERP keyword in a sales posting.
  for (const [category, pattern] of rolePatterns) {
    if (pattern.test(job.title) || (scan.isOperating && pattern.test(job.description))) categories.push(category);
  }
  return categories;
}

export function atsJobIdentity(sourceKey: string, job: AtsJob) {
  const url = canonicalEvidenceUrl(job.url);
  return hash([sourceKey, job.id?.trim() ? `id:${job.id.trim()}` : `url:${url}`]);
}

export type AtsPreparedJob = {
  job_key: string; provider_id: string | null; url: string; title: string; location: string; source_date: string | null;
  listing_hash: string; content_hash: string; categories: AtsRoleCategory[]; client_placement: boolean;
};
export type AtsKnownJob = { job_key: string; listing_hash: string; content_hash: string; categories?: AtsRoleCategory[]; client_placement?: boolean };

export function prepareAtsJob(sourceKey: string, job: AtsJob, known?: AtsKnownJob): AtsPreparedJob {
  const listingHash = hash([normalized(job.title), normalized(job.location)]);
  const contentHash = !job.description.trim() && known?.listing_hash === listingHash
    ? known.content_hash : hash([listingHash, normalized(job.description)]);
  const retainedPlacement = !job.description.trim() && known?.client_placement === true;
  return {
    job_key: atsJobIdentity(sourceKey, job), provider_id: job.id ?? null, url: canonicalEvidenceUrl(job.url),
    title: job.title, location: job.location, source_date: job.date,
    listing_hash: listingHash, content_hash: contentHash,
    categories: retainedPlacement ? [] : !job.description.trim() && known?.listing_hash === listingHash ? known.categories ?? atsRoleCategories(job) : atsRoleCategories(job),
    client_placement: retainedPlacement || scanJob(job.title, job.description).isClientPlacement,
  };
}

export type AtsScanCursor = { scanId: string | null; offset: number; revision?: number };
export async function readAtsScan(companyId: string, sourceKey: string): Promise<AtsScanCursor> {
  const { data, error } = await serviceClient().from("intelligence_ats_boards")
    .select("active_scan_id,next_offset,revision").eq("company_id", companyId).eq("source_key", sourceKey).maybeSingle();
  if (error) throw new Error(`ATS checkpoint read failed: ${error.code}`);
  return { scanId: data?.active_scan_id ?? null, offset: data?.next_offset ?? 0, revision: data?.revision ?? 0 };
}

export async function readAtsKnownJobs(companyId: string, sourceKey: string, jobs: AtsJob[]): Promise<Map<string, AtsKnownJob>> {
  if (!jobs.length) return new Map();
  const keys = [...new Set(jobs.map((job) => atsJobIdentity(sourceKey, job)))];
  const { data, error } = await serviceClient().from("intelligence_ats_jobs").select("job_key,listing_hash,content_hash,categories,client_placement")
    .eq("company_id", companyId).eq("source_key", sourceKey).in("job_key", keys);
  if (error) throw new Error(`ATS jobs read failed: ${error.code}`);
  return new Map((data ?? []).map((job) => [job.job_key, job as AtsKnownJob]));
}

export type AtsScanSummary = {
  baseline: boolean; openJobs: number; newJobs: number; changedJobs: number; reopenedJobs: number; expiredJobs: number;
  roleCounts: Partial<Record<AtsRoleCategory, number>>;
  changes: { jobKey: string; url: string; title: string; kind: string; categories: AtsRoleCategory[]; clientPlacement: boolean }[];
  changesTruncated: boolean; previousCompleteAt: string | null; completedAt: string;
  intervalDays: number | null; newListingsPerDay: number | null; paceBasis: string;
  previousListingsPerDay?: number | null; paceChangeRatio?: number | null; newOperatingJobs?: number;
  newOperatingRoleCounts?: Partial<Record<AtsRoleCategory, number>>;
};
export type AtsBatchOutcome = { accepted: boolean; complete?: boolean; restart?: boolean; scanId?: string | null; nextOffset?: number | null; summary?: AtsScanSummary };
export async function applyAtsBatch(companyId: string, sourceKey: string, cursor: AtsScanCursor, batch: AtsJobBatch, jobs: AtsPreparedJob[]): Promise<AtsBatchOutcome> {
  const { data, error } = await serviceClient().rpc("intelligence_ats_apply_batch", {
    p_company: companyId, p_source_key: sourceKey, p_scan_id: cursor.scanId, p_offset: cursor.offset,
    p_next_offset: batch.nextOffset, p_complete: batch.complete, p_available: batch.status !== "unavailable",
    p_snapshot_key: batch.snapshotKey ?? null, p_expected_total: batch.expectedTotal ?? null, p_jobs: jobs, p_revision: cursor.revision ?? 0,
  });
  if (error) throw new Error(`ATS lifecycle write failed: ${error.code}`);
  return data as AtsBatchOutcome;
}

/** A measured listing pattern, clearly separated from employer assertions. */
export function atsHiringPattern(summary: AtsScanSummary): { title: string; text: string } | null {
  if (summary.baseline || !summary.previousCompleteAt) return null;
  const roles = Object.entries(summary.newOperatingRoleCounts ?? {}).filter(([, count]) => (count ?? 0) > 0);
  const cluster = (summary.newOperatingJobs ?? 0) >= 3 && roles.length >= 2;
  const faster = summary.newJobs >= 3 && (summary.paceChangeRatio ?? 0) >= 2;
  if (!cluster && !faster) return null;
  return {
    title: cluster ? "New operating-role hiring cluster" : "Public job-listing pace increased",
    text: `Stanley's complete scans of this company's public job board at ${summary.previousCompleteAt} and ${summary.completedAt} observed ${summary.newJobs} newly listed roles, ${summary.reopenedJobs} reappearing roles, ${summary.changedJobs} changed listings, and ${summary.expiredJobs} roles no longer listed. ${summary.openJobs} listings are currently open. ` +
      `${summary.newOperatingJobs ?? 0} new or reopened in-house operating roles span ${roles.map(([role, count]) => `${role.replaceAll("_", " ")}: ${count}`).join(", ") || "no classified role cluster"}. ` +
      (faster ? `The measured new-listing pace is ${summary.newListingsPerDay} per day versus ${summary.previousListingsPerDay} in the preceding complete-scan interval. ` : "") +
      "These are observed listing changes, not confirmed hires, filled vacancies, net employee growth, or proof of buying intent. The company may repost or withdraw roles.\n" +
      summary.changes.filter((change) => !change.clientPlacement && change.kind !== "expired").slice(0, 20)
        .map((change) => `${change.kind}: ${change.title} — ${change.url}`).join("\n"),
  };
}

export function atsBoardSourceUrl(type: AtsType, token: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,100}$/i.test(token)) throw new Error("Invalid ATS board token");
  const urls: Record<AtsType, string> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
    lever: `https://api.lever.co/v0/postings/${token}?mode=json`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=false`,
    smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${token}/postings`,
    recruitee: `https://${token}.recruitee.com/api/offers/`,
    workable: `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`,
    wizehire: `https://wizehire.com/jobroll/v1/jobs/${token}/jsonp`,
  };
  return urls[type];
}

/** A lost observation response is replayed through the existing observation key;
 * the durable scan stays pending until its exact effect has been acknowledged. */
export async function enqueuePendingAtsPatterns(company: { id: string; name: string; domain: string }, sourceKey: string, type: AtsType, token: string): Promise<void> {
  const db = serviceClient();
  const { data, error } = await db.from("intelligence_ats_scans").select("id,summary").eq("company_id", company.id)
    .eq("source_key", sourceKey).eq("status", "complete").eq("pattern_status", "pending")
    .order("completed_at", { ascending: true }).limit(3);
  if (error) throw new Error(`ATS pattern read failed: ${error.code}`);
  for (const row of data ?? []) {
    const summary = row.summary as AtsScanSummary;
    const pattern = atsHiringPattern(summary);
    let observationId: string | null = null;
    if (pattern) {
      const result = await enqueueObservation({
        companyId: company.id, companyName: company.name, companyDomain: company.domain, sourceKind: "job",
        sourceUrl: atsBoardSourceUrl(type, token), title: pattern.title, text: pattern.text,
        eventDate: summary.completedAt, metadata: { atsType: type, atsToken: token, scanId: row.id,
          derivedEvidence: "complete_ats_scan_comparison", previousCompleteAt: summary.previousCompleteAt,
          eventDateKind: "observed_listing_change", hiringSummary: summary },
      });
      if (!result) continue;
      observationId = result.id;
    }
    const updated = await db.from("intelligence_ats_scans").update({ pattern_status: pattern ? "enqueued" : "none", pattern_observation_id: observationId })
      .eq("id", row.id).eq("company_id", company.id).eq("source_key", sourceKey);
    if (updated.error) throw new Error(`ATS pattern receipt failed: ${updated.error.code}`);
  }
}

/** Cache-only context for UI/profile use. Missing baselines remain explicit. */
export async function readAtsHiringContext(companyId: string) {
  const db = serviceClient();
  const [boards, scans] = await Promise.all([
    db.from("intelligence_ats_boards").select("source_key,active_scan_id,next_offset,last_complete_at,last_attempt_at,last_error").eq("company_id", companyId),
    db.from("intelligence_ats_scans").select("id,source_key,started_at,completed_at,summary").eq("company_id", companyId)
      .eq("status", "complete").order("completed_at", { ascending: false }).limit(20),
  ]);
  if (boards.error || scans.error) throw new Error("ATS hiring context unavailable");
  return { boards: boards.data ?? [], scans: (scans.data ?? []).map((scan) => ({ ...scan, summary: scan.summary as AtsScanSummary })),
    basis: "Public listing presence and changes across completed board scans; not confirmed hires, vacancies filled, or company growth." };
}
