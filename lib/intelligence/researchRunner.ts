import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { intelligenceEnabled, enqueueObservation } from "./observations";
import { buildOperatingProfile, operatingCriteria, type ProfileObservation } from "./profiles";
import { readSourceState } from "./sourceState";
import { researchCandidates, type ResearchAttempt } from "./research";
import { rankResearchCandidates, type ResearchRankingResult } from "./researchRanking";
import { sameCompanySite, sitePageEvidence, discoverSiteLinks } from "@/lib/sources/siteDiscovery";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { fetchPublicPdfEvidence } from "@/lib/sources/publicPdf";
import { readNewsEvidence } from "@/lib/sources/newsEvidence";
import type { NewsItem } from "@/lib/sources/googleNews";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { discoverExternalResearch } from "./researchExternal";
import { logEvent } from "@/lib/db/events";
import { readAtsHiringContext } from "./atsLifecycle";
import { businessServicesResearchContext, operatingTopicPriority, researchSourcePriority, BUSINESS_SERVICES_RESEARCH_VERSION } from "./businessServices";
import { runOperatingCoverage } from "./operatingCoverage";
import { catalogResearchQueries } from "./operatingCatalog";
import { readJevBudgetPolicy } from "./budget";

export const DIRECTED_RESEARCH_MINIMUM_MS = 40_000;
type ResearchOutcome = "queued" | "unchanged" | "source_failed" | "source_empty";
type ResearchJob = { company_id: string; desired_hash: string; lease_token: string; attempts: number; lease_until?: string | null; catalog_requested_version?: string | null };
type SourceAttempt = ResearchAttempt & { outcome: ResearchOutcome | null; last_success_at: string | null };
export type ResearchSweepState = { knownSources: number; dueSources: number; unreadSources: number;
  leasedSources: number; retrySources: number };

/** Count the complete retained URL inventory, independently of the bounded
 * next-reading batch. Unknown operating topics do not make a source unread. */
export function researchSweepState(urls: readonly string[], attempts: SourceAttempt[], previouslyRead: ReadonlySet<string>, now = Date.now()): ResearchSweepState {
  const byUrl = new Map(attempts.map(attempt => [attempt.source_url, attempt]));
  const state: ResearchSweepState = { knownSources: 0, dueSources: 0, unreadSources: 0, leasedSources: 0, retrySources: 0 };
  for (const url of new Set(urls)) {
    state.knownSources++;
    const attempt = byUrl.get(url);
    const leased = !!attempt?.lease_until && Date.parse(attempt.lease_until) > now;
    if (leased) state.leasedSources++;
    else if (!attempt || Date.parse(attempt.next_attempt_at) <= now) state.dueSources++;
    if (!previouslyRead.has(url) && !attempt?.last_success_at) state.unreadSources++;
    if (attempt?.outcome === "source_failed" || attempt?.outcome === "source_empty") state.retrySources++;
  }
  return state;
}

function idleResearchOutcome(sweep: ResearchSweepState, pendingJobs: number, unresolvedInterpretations: number): ResearchRefreshResult["outcome"] {
  if (sweep.leasedSources) return "sources_leased";
  if (pendingJobs) return "waiting_interpretation";
  if (unresolvedInterpretations) return "interpretation_failed";
  if (sweep.retrySources || sweep.unreadSources) return "waiting_retry";
  return "caught_up";
}

/** Both manual and scheduled work share discovered URLs, the current profile,
 * exact URL leases, and seven-day/one-day revisit policy. GET stays cache-only. */
export async function loadResearchProfile(companyId: string, deadlineMs = Infinity) {
  const db = serviceClient();
  const { data: company, error } = await db.from("companies").select("id,name,domain,subindustry,netsuite_internal_id")
    .eq("id", companyId).neq("status", "removed_from_tam").single();
  if (error || !company) throw new Error("account_unavailable");
  const rows: ProfileObservation[] = [];
  for (let page = 0;; page++) {
    if (Date.now() >= deadlineMs - 2000) throw new Error("research_deadline");
    const { data, error: evidenceError } = await db.from("intelligence_observations")
      .select("id,source_url,title,source_kind,event_date,observed_at,evidence_text,attributes")
      .eq("company_id", companyId).eq("is_current", true).eq("feedback_excluded", false)
      .order("id").range(page * 100, page * 100 + 99);
    if (evidenceError) throw new Error("evidence_unavailable");
    rows.push(...(data ?? []) as ProfileObservation[]);
    if ((data?.length ?? 0) < 100) break;
  }
  const profile = buildOperatingProfile(rows);
  const discovered: { source_url: string; title: string; metadata: Record<string, unknown> }[] = [];
  for (let page = 0;; page++) {
    if (Date.now() >= deadlineMs - 2000) throw new Error("research_deadline");
    const result = await db.from("intelligence_research_sources").select("source_url,title,metadata")
      .eq("company_id", companyId).order("source_url").range(page * 200, page * 200 + 199);
    if (result.error) throw new Error("research_discovery_unavailable");
    discovered.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 200) break;
  }
  const [state, hiring] = await Promise.all([
    readSourceState(companyId, "website"), readAtsHiringContext(companyId).catch(() => null),
  ]);
  const home = company.domain ? `https://${String(company.domain).replace(/^https?:\/\//, "")}` : null;
  const verified = Array.isArray(state.cursor?.verifiedUrls) ? state.cursor.verifiedUrls.filter((url): url is string =>
    typeof url === "string" && url.length <= 2048 && !!home && sameCompanySite(url, home)) : [];
  const relevant = new Set(["project_delivery", "multi_entity", "multi_location", ...operatingTopicPriority(company.subindustry, "website")]);
  const missingTopics = profile.topics.filter(topic => topic.state === "unknown" && relevant.has(topic.id)).map(topic => topic.id);
  const eventTitles = [...new Set(profile.developments.filter(event => !event.historical).map(event => event.title))].slice(0, 3);
  const researchQuestions = [...missingTopics, ...(eventTitles.length ? ["Follow up the company's recent development and resolve missing event context"] : []), "Resolve legal identity, former names and company-family relationships"];
  const sourceMetadata = Object.fromEntries(discovered.map(row => [row.source_url, row.metadata ?? {}]));
  const previouslyRead = new Set([...verified, ...rows.map(row => row.source_url)]);
  const priority = (url: string) => researchSourcePriority(url, company.subindustry, missingTopics) + (previouslyRead.has(url) ? 0 : 8);
  const urls = [state.cursor?.pendingUrls, state.cursor?.knownUrls, discovered.map(row => row.source_url), [...previouslyRead]]
    .flatMap(value => Array.isArray(value) ? value : []).filter((url): url is string => typeof url === "string"
      && url.length <= 2048 && ((!!home && sameCompanySite(url, home)) || (() => { try { return sourceMetadata[url]?.researchOrigin === "external_search" && !!validatePublicHttpUrl(url); } catch { return false; } })()));
  const available = [...new Set(urls)].sort((a, b) => priority(b) - priority(a) || a.localeCompare(b));
  const candidateTitles = Object.fromEntries(discovered.map(row => [row.source_url, row.title]));
  const attempts: SourceAttempt[] = [];
  for (let page = 0; available.length; page++) {
    if (Date.now() >= deadlineMs - 2000) throw new Error("research_deadline");
    const result = await db.from("intelligence_research_attempts").select("source_url,next_attempt_at,last_attempt_at,lease_until,outcome,last_success_at")
      .eq("company_id", companyId).order("source_url").range(page * 200, page * 200 + 199);
    if (result.error) throw new Error("research_state_unavailable");
    attempts.push(...(result.data ?? []) as SourceAttempt[]);
    if ((result.data?.length ?? 0) < 200) break;
  }
  const interpretationJobs: { observation_id: string; status: string }[] = [];
  for (let page = 0;; page++) {
    if (Date.now() >= deadlineMs - 2000) throw new Error("research_deadline");
    const result = await db.from("intelligence_jobs")
      .select("id,observation_id,status,intelligence_observations:intelligence_observations!intelligence_jobs_observation_id_fkey!inner(company_id,is_current,feedback_excluded)")
      .eq("intelligence_observations.company_id", companyId).eq("intelligence_observations.is_current", true)
      .eq("intelligence_observations.feedback_excluded", false).eq("kind", "interpret").in("status", ["queued", "running", "failed"])
      .order("id").range(page * 200, page * 200 + 199);
    if (result.error) throw new Error("research_state_unavailable");
    interpretationJobs.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 200) break;
  }
  const pendingInterpretations = new Set(interpretationJobs.filter(job => job.status === "queued" || job.status === "running").map(job => job.observation_id));
  const unresolvedInterpretations = new Set([
    ...interpretationJobs.filter(job => job.status === "failed").map(job => job.observation_id),
    ...rows.filter(row => !row.attributes && !pendingInterpretations.has(row.id)).map(row => row.id),
  ]).size;
  const candidates = researchCandidates(available, attempts, priority);
  const availableSet = new Set(available);
  const nextAttempt = attempts.filter(row => availableSet.has(row.source_url)).flatMap(row => [row.next_attempt_at, row.lease_until])
    .filter((value): value is string => typeof value === "string").map(value => Date.parse(value))
    .filter(date => Number.isFinite(date) && date > Date.now());
  return { company, profile, nextSources: candidates.slice(0, 3), candidates, missingTopics, candidateTitles, sourceMetadata, eventTitles, researchQuestions,
    researchFocus: businessServicesResearchContext(company.subindustry),
    nextAttemptAt: new Date(nextAttempt.length ? Math.min(...nextAttempt) : Date.now() + (available.length ? 7 : 1) * 86400_000).toISOString(),
    discoveredSourceCount: available.length, newSourceCount: available.filter(url => !previouslyRead.has(url)).length,
    sweep: researchSweepState(available, attempts, previouslyRead),
    verifiedSourceCount: verified.length, pendingJobs: pendingInterpretations.size, unresolvedInterpretations, hiring,
    hiringCoverage: hiring ? "available" : "unavailable" };
}

export type ResearchProfile = Awaited<ReturnType<typeof loadResearchProfile>>;
export type ResearchRefreshResult = { sources: number; outcomes: ResearchOutcome[]; ranking: ResearchRankingResult | null;
  outcome: "refreshed" | "caught_up" | "waiting_interpretation" | "interpretation_failed" | "waiting_retry" | "deadline_deferred" | "sources_leased" | "ranking_pending" | "catalog_only";
  remainingSources: number; nextAttemptAt: string; sweep?: ResearchSweepState; unresolvedInterpretations?: number };

export async function refreshAccountResearch(companyId: string, options: {
  deadlineMs: number; automatic?: boolean; profile?: ResearchProfile; catalogGap?: { facetIds: string[] };
}): Promise<ResearchRefreshResult> {
  return withServiceDeadline(options.deadlineMs, async () => {
    const empty = (outcome: ResearchRefreshResult["outcome"], nextAttemptAt = new Date(Date.now() + 600_000).toISOString()): ResearchRefreshResult =>
      ({ sources: 0, outcomes: [], ranking: null, outcome, remainingSources: 0, nextAttemptAt });
    const config = await serviceClient().from("intelligence_config").select("catalog_mode").eq("id",1).single();
    if(config.error)throw new Error("research_configuration_unavailable");
    if(!options.catalogGap && ["pilot","rollout"].includes(config.data?.catalog_mode)) {
      const budget=await readJevBudgetPolicy();
      if(config.data?.catalog_mode==="pilot"||!budget.available||!budget.enabled||budget.phase!=="maintenance")return empty("catalog_only");
    }
    if (Date.now() > options.deadlineMs - DIRECTED_RESEARCH_MINIMUM_MS) return empty("deadline_deferred");
    let loaded = options.profile ?? await loadResearchProfile(companyId, options.deadlineMs);
    if (loaded.company.id !== companyId) throw new Error("research_account_mismatch");
    // External discovery has its own durable per-query cadence. It can follow a
    // newly observed event even when the account's stable operating topics are known.
    if (Date.now() < options.deadlineMs - 55_000) {
      const external = options.catalogGap ? await discoverExternalResearch(loaded.company, loaded.missingTopics, loaded.eventTitles ?? [], options.deadlineMs,
        catalogResearchQueries(options.catalogGap.facetIds)) :
        await discoverExternalResearch(loaded.company, loaded.missingTopics, loaded.eventTitles ?? [], options.deadlineMs);
      if (external.sources) loaded = await loadResearchProfile(companyId, options.deadlineMs);
      if (external.nextAttemptAt && Date.parse(external.nextAttemptAt) < Date.parse(loaded.nextAttemptAt))
        loaded = { ...loaded, nextAttemptAt: external.nextAttemptAt };
    }
    if (!loaded.candidates.length) {
      const outcome = idleResearchOutcome(loaded.sweep, loaded.pendingJobs, loaded.unresolvedInterpretations);
      // An interpretation completion will wake the account too. Keep a bounded
      // recovery wake while waiting; failed/empty sources retain their backoff.
      const nextAttemptAt = outcome === "waiting_interpretation"
        ? new Date(Math.min(Date.parse(loaded.nextAttemptAt), Date.now() + 600_000)).toISOString() : loaded.nextAttemptAt;
      return { ...empty(outcome, nextAttemptAt), sweep: loaded.sweep, unresolvedInterpretations: loaded.unresolvedInterpretations };
    }
    if (Date.now() > options.deadlineMs - 32_000) return empty("deadline_deferred");
    const ranking = await rankResearchCandidates({ companyId, automaticResearch: options.automatic === true, catalogOwned: !!options.catalogGap,
      companyName: loaded.company.name, companyDomain: loaded.company.domain,
      missingTopics: options.catalogGap ? ["Resolve the named company's unresolved public operating predicates and company identity using the supplied known source options"] : loaded.researchQuestions ?? loaded.missingTopics,
      candidates: loaded.candidates, candidateTitles: loaded.candidateTitles,
      ...(options.catalogGap ? { catalogFacetIds: options.catalogGap.facetIds } : { researchContext: loaded.researchFocus }) });
    // An identical native ranking is already in flight. Let that invocation
    // choose its sources; do not race it using the unranked fallback order.
    if (ranking.outcome === "busy") return { ...empty("ranking_pending", new Date(Date.now() + 60_000).toISOString()),
      ranking, remainingSources: loaded.candidates.length };
    if (Date.now() > options.deadlineMs - 17_000) return { ...empty("deadline_deferred"), ranking };
    const db = serviceClient();
    const { data, error } = await db.rpc("intelligence_research_claim", { p_company: companyId, p_urls: ranking.candidates });
    if (error || !Array.isArray(data)) throw new Error("research_claim_failed");
    const claims = data as { source_url: string; lease_token: string }[];
    if (!claims.length) return { ...empty("sources_leased"), ranking };
    let discoveries = 0;
    const reads = await Promise.allSettled(claims.map(async claim => {
      let outcome: ResearchOutcome = "source_failed";
      try {
        const provenance = loaded.sourceMetadata?.[claim.source_url];
        if (provenance?.researchOrigin === "external_search" && provenance.newsItem) {
          const evidence = await readNewsEvidence(provenance.newsItem as NewsItem, { deadlineMs: options.deadlineMs - 5000 });
          const result = await enqueueObservation({ companyId, companyName: loaded.company.name, companyDomain: loaded.company.domain,
            netsuiteInternalId: loaded.company.netsuite_internal_id, sourceKind: "news", sourceUrl: evidence.sourceUrl,
            title: evidence.title, text: evidence.text, eventDate: evidence.eventDate,
            metadata: { ...evidence.metadata, focusedResearch: true, externalResearch: true, automaticResearch: options.automatic === true,
              researchPurpose: provenance.researchPurpose, researchQuery: provenance.query, researchQueryHash: provenance.queryHash,
              researchTopics: loaded.missingTopics,
              researchCriteria: operatingCriteria(loaded.company.subindustry, "news", loaded.missingTopics).map(criterion => criterion.id),
              researchRankingVersion: ranking.rankingVersion } });
          if (!result) throw new Error("observation_not_persisted");
          outcome = result.queued ? "queued" : "unchanged";
        } else if (/\.pdf$/i.test(new URL(claim.source_url).pathname)) {
          const pdf = await fetchPublicPdfEvidence(claim.source_url, { mode: "deep", deadlineMs: options.deadlineMs - 5000 });
          if (!sameCompanySite(pdf.url, claim.source_url)) throw new Error("source_failed");
          if (pdf.status === "no_readable_text") outcome = "source_empty";
          else {
            const result = await enqueueObservation({ companyId, companyName: loaded.company.name, companyDomain: loaded.company.domain,
              netsuiteInternalId: loaded.company.netsuite_internal_id, sourceKind: "website", sourceUrl: pdf.url,
              title: loaded.candidateTitles[claim.source_url] || `${loaded.company.name} public document`, text: pdf.text, eventDate: null,
              metadata: { focusedResearch: true, automaticResearch: options.automatic === true, researchRankingVersion: ranking.rankingVersion,
                businessServicesResearchVersion: BUSINESS_SERVICES_RESEARCH_VERSION, researchTopics: loaded.missingTopics,
                researchCriteria: operatingCriteria(loaded.company.subindustry, "website", loaded.missingTopics).map(criterion => criterion.id),
                evidenceKind: pdf.evidenceKind, sourceTruncated: pdf.truncated, truncationReasons: pdf.truncationReasons,
                pdfPagesRead: pdf.pagesRead, pdfTotalPages: pdf.totalPages, pdfBytes: pdf.bytes } });
            if (!result) throw new Error("observation_not_persisted");
            outcome = result.queued ? "queued" : "unchanged";
          }
        } else {
        const fetched = await fetchPublicHttpText(claim.source_url, {
          timeoutMs: Math.min(12000, Math.max(1, options.deadlineMs - Date.now() - 5000)), maxRedirects: 4, maxBytes: 1000000,
        });
        if (fetched.status < 200 || fetched.status >= 300 || !sameCompanySite(fetched.finalUrl, claim.source_url)) throw new Error("source_failed");
        const page = sitePageEvidence(fetched.body, fetched.finalUrl);
        const links = discoverSiteLinks(fetched.body, fetched.finalUrl, { includePdf: true }).filter(link => link.url !== page.url)
          .sort((a, b) => researchSourcePriority(b.url, loaded.company.subindustry, loaded.missingTopics)
            - researchSourcePriority(a.url, loaded.company.subindustry, loaded.missingTopics)).slice(0, 30);
        if (links.length) {
          const { data: inserted, error: discoveryError } = await db.from("intelligence_research_sources").upsert(links.map(link => ({
            company_id: companyId, source_url: link.url, title: link.label, discovered_from: fetched.finalUrl,
          })), { onConflict: "company_id,source_url", ignoreDuplicates: true }).select("source_url");
          if (discoveryError) throw new Error("research_discovery_save_failed");
          // A known URL omitted from this due batch is not a new discovery.
          discoveries += inserted?.length ?? 0;
        }
        if (!page.text.trim()) outcome = "source_empty";
        else {
          // Match the website collector's date contract. Choosing the first of
          // conflicting page dates invents certainty and creates another paid
          // version when the ordinary website scan revisits identical text.
          const publicationDates = [...new Set(page.sourceDates.filter(date => date.kind === "published").map(date => date.value))];
          const published = publicationDates.length === 1 ? publicationDates[0] : null;
          const result = await enqueueObservation({ companyId, companyName: loaded.company.name, companyDomain: loaded.company.domain,
            netsuiteInternalId: loaded.company.netsuite_internal_id, sourceKind: "website", sourceUrl: page.url, title: page.title || `${loaded.company.name} company website`,
            text: page.text, eventDate: published ?? null, metadata: { focusedResearch: true, automaticResearch: options.automatic === true,
              researchRankingVersion: ranking.rankingVersion, businessServicesResearchVersion: BUSINESS_SERVICES_RESEARCH_VERSION,
              researchTopics: loaded.missingTopics,
              researchCriteria: operatingCriteria(loaded.company.subindustry, "website", loaded.missingTopics).map(criterion => criterion.id),
              sourceDates: page.sourceDates, sourceTruncated: page.truncated,
              ...(page.identityClaims?.length ? { identityClaims: page.identityClaims } : {}),
              eventDateBasis: published ? "page_publication" : "unknown",
              discovery: { collector: "directed_research", url: claim.source_url, title: loaded.candidateTitles[claim.source_url] ?? null, eventDate: null },
              ...(page.companyIdentity && loaded.company.domain && sameCompanySite(page.url, `https://${String(loaded.company.domain).replace(/^https?:\/\//, "")}`)
                ? { companyIdentity: page.companyIdentity } : {}) } });
          if (!result) throw new Error("observation_not_persisted");
          outcome = result.queued ? "queued" : "unchanged";
        }
        }
      } catch { outcome = "source_failed"; }
      const { data: saved, error: finishError } = await db.rpc("intelligence_research_finish", {
        p_company: companyId, p_url: claim.source_url, p_lease: claim.lease_token, p_outcome: outcome,
      });
      if (finishError || saved !== true) throw new Error("research_completion_failed");
      return outcome;
    }));
    // One failed durable finish must not release the account while its other
    // leased source reads are still healthy and writing their own receipts.
    if (reads.some(read => read.status === "rejected")) throw new Error("research_completion_failed");
    const outcomes = reads.flatMap(read => read.status === "fulfilled" ? [read.value] : []);
    await logEvent("headhunter", "intelligence.focused_research", {
      summary: `Researched ${claims.length} public account sources`, entity_type: "company", entity_id: companyId,
      meta: { outcomes, discoveries, automatic: options.automatic === true, researchVersion: BUSINESS_SERVICES_RESEARCH_VERSION, ranking },
    });
    let remainingSources = Math.max(0, loaded.sweep.dueSources - claims.length) + discoveries;
    const retryMs = remainingSources ? 600_000 : outcomes.some(outcome => outcome === "source_failed" || outcome === "source_empty") ? 86400_000 : 7 * 86400_000;
    let outcome: ResearchRefreshResult["outcome"] = "refreshed";
    let nextAttemptAt = new Date(Math.min(Date.now() + retryMs, Date.parse(loaded.nextAttemptAt))).toISOString();
    let sweep: ResearchSweepState | undefined;
    let unresolvedInterpretations: number | undefined;
    if (!remainingSources) {
      // Confirm the final batch against durable attempts and new interpretation
      // jobs. Finishing a source fetch does not mean its Jev work has finished.
      const current = await loadResearchProfile(companyId, options.deadlineMs);
      sweep = current.sweep;
      unresolvedInterpretations = current.unresolvedInterpretations;
      remainingSources = current.sweep.dueSources;
      if (!current.candidates.length) outcome = idleResearchOutcome(current.sweep, current.pendingJobs, current.unresolvedInterpretations);
      nextAttemptAt = new Date(Math.min(Date.parse(current.nextAttemptAt), Date.parse(nextAttemptAt),
        outcome === "waiting_interpretation" || remainingSources ? Date.now() + 600_000 : Infinity)).toISOString();
    }
    return { sources: claims.length, outcomes, ranking, outcome, remainingSources, nextAttemptAt,
      ...(sweep ? { sweep, unresolvedInterpretations } : {}) };
  });
}

async function finishResearchJob(job: ResearchJob, status: "queued" | "complete" | "failed", result: ResearchRefreshResult | null, error: string | null, retry = 600) {
  const { data, error: dbError } = await serviceClient().rpc("intelligence_directed_finish", {
    p_company: job.company_id, p_lease: job.lease_token, p_hash: job.desired_hash, p_status: status,
    p_retry_seconds: retry, p_result: result, p_error: error,
  });
  if (dbError) throw new Error("directed_research_finish_failed");
  return data === true;
}

export type DirectedResearchWorkerOptions = { mode: "drain"; concurrency?: number };
export type DirectedResearchStopReason = "disabled" | "batch_limit" | "deadline" | "queue_empty" | "queue_empty_or_capacity" | "claim_error" | "duplicate_claim";

/** Drain the existing leased queue for the request's available runtime. Finite
 * callers keep their original sequential, at-most-eight-account contract. */
export async function runDirectedResearchWorker(limit: number | DirectedResearchWorkerOptions = 1, deadlineMs = Date.now() + 90_000) {
  const startedAt = Date.now();
  const mode = typeof limit === "number" ? "bounded" : "drain";
  const requestedConcurrency = typeof limit === "number" ? 1 : limit.concurrency ?? 2;
  const concurrency = Number.isFinite(requestedConcurrency) ? Math.max(1, Math.min(2, Math.floor(requestedConcurrency))) : 2;
  const bound = typeof limit === "number" ? Math.max(0, Math.min(8, Math.ceil(limit) || 0)) : Infinity;
  const outcomes: Record<string, number> = {};
  let processed = 0, claimed = 0, peakInFlight = 0;
  let stoppedBy: DirectedResearchStopReason = "queue_empty";
  const receipt = (enabled: boolean) => ({ enabled, processed, outcomes, claimed, mode, concurrency, peakInFlight,
    durationMs: Math.max(0, Date.now() - startedAt), stoppedBy });
  if (!intelligenceEnabled()) { stoppedBy = "disabled"; return receipt(false); }
  return withServiceDeadline(deadlineMs, async () => {
    const inFlight = new Map<string, Promise<string>>();
    const process = async (job: ResearchJob, claimedAt: number) => {
      const leaseTimestamp = job.lease_until ? Date.parse(job.lease_until) : NaN;
      const leaseExpiresAt = Number.isFinite(leaseTimestamp) ? leaseTimestamp : claimedAt + 180_000;
      const leaseDeadlineMs = Math.min(deadlineMs, leaseExpiresAt);
      const accountDeadlineMs = Math.min(deadlineMs, leaseExpiresAt - 10_000);
      const finish = (status: "queued" | "complete" | "failed", result: ResearchRefreshResult | null, error: string | null, retry: number) =>
        withServiceDeadline(leaseDeadlineMs, () => finishResearchJob(job, status, result, error, retry));
      let outcome = "service_error";
      try {
        // The request may live longer than one account's three-minute lease.
        // Reserve its final ten seconds for a durable completion/backoff; the
        // next independent account can still use the request's remaining time.
        if (job.catalog_requested_version) {
          // Same account lease, explicit catalog admission. The catalog owns its
          // atomic answer/checkpoint finish; never also run legacy discovery or
          // complete the old interpretation backlog from this branch.
          const coverage = await runOperatingCoverage(job, accountDeadlineMs);
          outcome = coverage.outcome;
          if (coverage.outcome === "catalog_needs_research") {
            const research = await refreshAccountResearch(job.company_id, { deadlineMs: accountDeadlineMs, automatic: true,
              catalogGap: { facetIds: coverage.researchFacets ?? [] } });
            const saved = await serviceClient().rpc("intelligence_catalog_research_finish", { p_company: job.company_id,
              p_lease: job.lease_token, p_outcome: research.outcome, p_next_at: research.nextAttemptAt });
            if (saved.error) throw new Error("catalog_research_finish_failed");
            outcome = saved.data === true ? "catalog_researched" : "catalog_stale";
          }
        } else {
          const result = await refreshAccountResearch(job.company_id, { deadlineMs: accountDeadlineMs, automatic: true });
          const seconds = Math.max(60, Math.ceil((Date.parse(result.nextAttemptAt) - Date.now()) / 1000));
          const saved = await finish(result.outcome === "caught_up" ? "complete" : "queued", result, null, seconds);
          outcome = saved ? result.outcome : "superseded";
        }
      } catch (error) {
        try {
          if (job.catalog_requested_version) await withServiceDeadline(leaseDeadlineMs, async () => {
            const reason = error instanceof Error ? error.message : "catalog_service_error";
            const readOnlyRetry = ["catalog_loading_deadline", "catalog_sources_unavailable", "catalog_answers_unavailable",
              "catalog_snapshot_unavailable", "catalog_snapshot_sources_changed"].includes(reason);
            const deferred = await serviceClient().rpc("intelligence_catalog_defer", { p_company: job.company_id,
              p_lease: job.lease_token, p_reason: reason,
              p_retry_at: readOnlyRetry && job.attempts < 4 ? new Date(Date.now() + 60_000).toISOString() : null });
            if (deferred.error) throw new Error("catalog_defer_failed");
          });
          else await finish(job.attempts >= 6 ? "failed" : "queued", null, "research_service_error", Math.min(86400, 300 * 2 ** Math.min(job.attempts, 8)));
        }
        catch { /* The live lease remains the durable recovery path. */ }
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      processed++;
      return job.company_id;
    };
    let stopped = false;
    while (!stopped) {
      while (inFlight.size < concurrency && !stopped) {
        if (claimed >= bound) { stoppedBy = "batch_limit"; stopped = true; break; }
        if (Date.now() >= deadlineMs - DIRECTED_RESEARCH_MINIMUM_MS) { stoppedBy = "deadline"; stopped = true; break; }
        let job: ResearchJob | undefined;
        const claimedAt = Date.now();
        try {
          const { data, error } = await serviceClient().rpc("intelligence_directed_claim", { p_limit: 1 });
          if (error) throw new Error("directed_research_claim_failed");
          job = (data as ResearchJob[] | null)?.[0];
        } catch {
          outcomes.claim_error = (outcomes.claim_error ?? 0) + 1;
          stoppedBy = "claim_error"; stopped = true; break;
        }
        if (!job) { stoppedBy = mode === "drain" ? "queue_empty_or_capacity" : "queue_empty"; stopped = true; break; }
        claimed++;
        // The database owns cross-request exclusivity. This defensive guard
        // also refuses an unexpected duplicate without touching the live lease.
        if (inFlight.has(job.company_id)) {
          outcomes.duplicate_claim = (outcomes.duplicate_claim ?? 0) + 1;
          stoppedBy = "duplicate_claim"; stopped = true; break;
        }
        inFlight.set(job.company_id, process(job, claimedAt));
        peakInFlight = Math.max(peakInFlight, inFlight.size);
      }
      if (!stopped && inFlight.size) {
        // Refill the first completed slot; a slow account does not block the
        // next independent account behind a fixed two-account batch.
        inFlight.delete(await Promise.race(inFlight.values()));
      }
    }
    // Never let a queue-empty/error/deadline stop abandon healthy owned work.
    // Per-account finish/backoff and live leases remain the recovery authority.
    await Promise.all(inFlight.values());
    return receipt(true);
  });
}
