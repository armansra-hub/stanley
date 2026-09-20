import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { intelligenceEnabled, enqueueObservation } from "./observations";
import { buildOperatingProfile, type ProfileObservation } from "./profiles";
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

export const DIRECTED_RESEARCH_MINIMUM_MS = 40_000;
type ResearchOutcome = "queued" | "unchanged" | "source_failed" | "source_empty";
type ResearchJob = { company_id: string; desired_hash: string; lease_token: string; attempts: number };

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
  const [state, hiring, discovered] = await Promise.all([
    readSourceState(companyId, "website"), readAtsHiringContext(companyId).catch(() => null),
    db.from("intelligence_research_sources").select("source_url,title,metadata").eq("company_id", companyId).order("discovered_at", { ascending: false }).limit(200),
  ]);
  if (discovered.error) throw new Error("research_discovery_unavailable");
  const home = company.domain ? `https://${String(company.domain).replace(/^https?:\/\//, "")}` : null;
  const verified = Array.isArray(state.cursor?.verifiedUrls) ? state.cursor.verifiedUrls.filter((url): url is string =>
    typeof url === "string" && url.length <= 2048 && !!home && sameCompanySite(url, home)).slice(0, 100) : [];
  const relevant = new Set(["project_delivery", "multi_entity", "multi_location", ...operatingTopicPriority(company.subindustry, "website")]);
  const missingTopics = profile.topics.filter(topic => topic.state === "unknown" && relevant.has(topic.id)).map(topic => topic.id);
  const eventTitles = [...new Set(profile.developments.filter(event => !event.historical).map(event => event.title))].slice(0, 3);
  const researchQuestions = [...missingTopics, ...(eventTitles.length ? ["Follow up the company's recent development and resolve missing event context"] : []), "Resolve legal identity, former names and company-family relationships"];
  const sourceMetadata = Object.fromEntries((discovered.data ?? []).map(row => [row.source_url, row.metadata ?? {}]));
  const previouslyRead = new Set([...verified, ...rows.map(row => row.source_url)]);
  const priority = (url: string) => researchSourcePriority(url, company.subindustry, missingTopics) + (previouslyRead.has(url) ? 0 : 8);
  const urls = [state.cursor?.pendingUrls, state.cursor?.knownUrls, (discovered.data ?? []).map(row => row.source_url), [...previouslyRead]]
    .flatMap(value => Array.isArray(value) ? value : []).filter((url): url is string => typeof url === "string"
      && url.length <= 2048 && ((!!home && sameCompanySite(url, home)) || (() => { try { return sourceMetadata[url]?.researchOrigin === "external_search" && !!validatePublicHttpUrl(url); } catch { return false; } })()));
  const available = [...new Set(urls)].sort((a, b) => priority(b) - priority(a) || a.localeCompare(b)).slice(0, 200);
  const candidateTitles = Object.fromEntries((discovered.data ?? []).map(row => [row.source_url, row.title]));
  const [attempts, pending] = await Promise.all([
    available.length ? db.from("intelligence_research_attempts").select("source_url,next_attempt_at,last_attempt_at")
      .eq("company_id", companyId).in("source_url", available).limit(200) : Promise.resolve({ data: [], error: null }),
    db.from("intelligence_jobs").select("id,intelligence_observations:intelligence_observations!intelligence_jobs_observation_id_fkey!inner(company_id)", { count: "exact", head: true })
      .eq("intelligence_observations.company_id", companyId).in("status", ["queued", "running"]),
  ]);
  if (attempts.error || pending.error) throw new Error("research_state_unavailable");
  const candidates = researchCandidates(available, (attempts.data ?? []) as ResearchAttempt[], priority);
  const nextAttempt = (attempts.data ?? []).map(row => Date.parse(row.next_attempt_at)).filter(date => Number.isFinite(date) && date > Date.now());
  return { company, profile, nextSources: candidates.slice(0, 3), candidates, missingTopics, candidateTitles, sourceMetadata, eventTitles, researchQuestions,
    researchFocus: businessServicesResearchContext(company.subindustry),
    nextAttemptAt: new Date(nextAttempt.length ? Math.min(...nextAttempt) : Date.now() + (available.length ? 7 : 1) * 86400_000).toISOString(),
    discoveredSourceCount: available.length, newSourceCount: available.filter(url => !previouslyRead.has(url)).length,
    verifiedSourceCount: verified.length, pendingJobs: pending.count ?? 0, hiring,
    hiringCoverage: hiring ? "available" : "unavailable" };
}

export type ResearchProfile = Awaited<ReturnType<typeof loadResearchProfile>>;
export type ResearchRefreshResult = { sources: number; outcomes: ResearchOutcome[]; ranking: ResearchRankingResult | null;
  outcome: "refreshed" | "no_sources_due" | "topics_supported" | "deadline_deferred" | "sources_leased" | "ranking_pending";
  remainingSources: number; nextAttemptAt: string };

export async function refreshAccountResearch(companyId: string, options: {
  deadlineMs: number; automatic?: boolean; profile?: ResearchProfile;
}): Promise<ResearchRefreshResult> {
  return withServiceDeadline(options.deadlineMs, async () => {
    const empty = (outcome: ResearchRefreshResult["outcome"], nextAttemptAt = new Date(Date.now() + 600_000).toISOString()): ResearchRefreshResult =>
      ({ sources: 0, outcomes: [], ranking: null, outcome, remainingSources: 0, nextAttemptAt });
    if (Date.now() > options.deadlineMs - DIRECTED_RESEARCH_MINIMUM_MS) return empty("deadline_deferred");
    let loaded = options.profile ?? await loadResearchProfile(companyId, options.deadlineMs);
    if (loaded.company.id !== companyId) throw new Error("research_account_mismatch");
    // External discovery has its own durable per-query cadence. It can follow a
    // newly observed event even when the account's stable operating topics are known.
    if (Date.now() < options.deadlineMs - 55_000) {
      const external = await discoverExternalResearch(loaded.company, loaded.missingTopics, loaded.eventTitles ?? [], options.deadlineMs);
      if (external.sources) loaded = await loadResearchProfile(companyId, options.deadlineMs);
      if (external.nextAttemptAt && Date.parse(external.nextAttemptAt) < Date.parse(loaded.nextAttemptAt))
        loaded = { ...loaded, nextAttemptAt: external.nextAttemptAt };
    }
    if (!loaded.candidates.length) return empty("no_sources_due", loaded.nextAttemptAt);
    if (Date.now() > options.deadlineMs - 32_000) return empty("deadline_deferred");
    const ranking = await rankResearchCandidates({ companyId, automaticResearch: options.automatic === true,
      companyName: loaded.company.name, companyDomain: loaded.company.domain,
      missingTopics: loaded.researchQuestions ?? loaded.missingTopics, candidates: loaded.candidates, candidateTitles: loaded.candidateTitles,
      researchContext: loaded.researchFocus });
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
    const outcomes = await Promise.all(claims.map(async claim => {
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
              researchTopics: loaded.missingTopics, researchRankingVersion: ranking.rankingVersion } });
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
          const { error: discoveryError } = await db.from("intelligence_research_sources").upsert(links.map(link => ({
            company_id: companyId, source_url: link.url, title: link.label, discovered_from: fetched.finalUrl,
          })), { onConflict: "company_id,source_url", ignoreDuplicates: true });
          if (discoveryError) throw new Error("research_discovery_save_failed");
          discoveries += links.filter(link => !loaded.candidates.includes(link.url)).length;
        }
        if (!page.text.trim()) outcome = "source_empty";
        else {
          const published = page.sourceDates.find(date => date.kind === "published")?.value;
          const result = await enqueueObservation({ companyId, companyName: loaded.company.name, companyDomain: loaded.company.domain,
            netsuiteInternalId: loaded.company.netsuite_internal_id, sourceKind: "website", sourceUrl: page.url, title: page.title || loaded.company.name,
            text: page.text, eventDate: published ?? null, metadata: { focusedResearch: true, automaticResearch: options.automatic === true,
              researchRankingVersion: ranking.rankingVersion, businessServicesResearchVersion: BUSINESS_SERVICES_RESEARCH_VERSION,
              researchTopics: loaded.missingTopics, sourceDates: page.sourceDates, sourceTruncated: page.truncated,
              ...(page.identityClaims?.length ? { identityClaims: page.identityClaims } : {}),
              eventDateBasis: published ? "source_publication" : "unknown",
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
    await logEvent("headhunter", "intelligence.focused_research", {
      summary: `Researched ${claims.length} public account sources`, entity_type: "company", entity_id: companyId,
      meta: { outcomes, discoveries, automatic: options.automatic === true, researchVersion: BUSINESS_SERVICES_RESEARCH_VERSION, ranking },
    });
    const remainingSources = Math.max(0, loaded.candidates.length - claims.length) + discoveries;
    const retryMs = remainingSources ? 600_000 : outcomes.some(outcome => outcome === "source_failed" || outcome === "source_empty") ? 86400_000 : 7 * 86400_000;
    return { sources: claims.length, outcomes, ranking, outcome: "refreshed", remainingSources,
      nextAttemptAt: new Date(Math.min(Date.now() + retryMs, Date.parse(loaded.nextAttemptAt))).toISOString() };
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

export async function runDirectedResearchWorker(limit = 1, deadlineMs = Date.now() + 90_000) {
  if (!intelligenceEnabled()) return { enabled: false, processed: 0, outcomes: {} as Record<string, number> };
  return withServiceDeadline(deadlineMs, async () => {
    const outcomes: Record<string, number> = {};
    let processed = 0;
    while (processed < Math.max(0, Math.min(8, limit)) && Date.now() < deadlineMs - DIRECTED_RESEARCH_MINIMUM_MS) {
      const { data, error } = await serviceClient().rpc("intelligence_directed_claim", { p_limit: 1 });
      if (error) throw new Error("directed_research_claim_failed");
      const job = (data as ResearchJob[] | null)?.[0];
      if (!job) break;
      let outcome = "service_error";
      try {
        const result = await refreshAccountResearch(job.company_id, { deadlineMs, automatic: true });
        const seconds = Math.max(60, Math.ceil((Date.parse(result.nextAttemptAt) - Date.now()) / 1000));
        const saved = await finishResearchJob(job, result.outcome === "topics_supported" ? "complete" : "queued", result, null, seconds);
        outcome = saved ? result.outcome : "superseded";
      } catch {
        try { await finishResearchJob(job, job.attempts >= 6 ? "failed" : "queued", null, "research_service_error", Math.min(86400, 300 * 2 ** Math.min(job.attempts, 8))); }
        catch { /* The live lease remains the durable recovery path. */ }
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      processed++;
    }
    return { enabled: true, processed, outcomes };
  });
}
