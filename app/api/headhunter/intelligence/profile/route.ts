import { NextRequest, NextResponse, after } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled, enqueueObservation } from "@/lib/intelligence/observations";
import { intelligenceUiAuthorized, isUuid, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { buildOperatingProfile, type ProfileObservation } from "@/lib/intelligence/profiles";
import { readSourceState } from "@/lib/intelligence/sourceState";
import { sameCompanySite, sitePageEvidence, sitePageKind } from "@/lib/sources/siteDiscovery";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { logEvent } from "@/lib/db/events";
import { researchCandidates, type ResearchAttempt } from "@/lib/intelligence/research";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function loadProfile(companyId: string) {
  const db = serviceClient();
  const { data: company, error } = await db.from("companies").select("id,name,domain,subindustry,netsuite_internal_id")
    .eq("id", companyId).neq("status", "removed_from_tam").single();
  if (error || !company) throw new Error("account_unavailable");
  const rows: ProfileObservation[] = [];
  // Page through the complete current evidence for this exact account.
  for (let page = 0;; page++) {
    const { data, error: evidenceError } = await db.from("intelligence_observations")
      .select("id,source_url,title,source_kind,event_date,observed_at,evidence_text,attributes")
      .eq("company_id", companyId).eq("is_current", true).eq("feedback_excluded", false).order("id").range(page * 100, page * 100 + 99);
    if (evidenceError) throw new Error("evidence_unavailable");
    rows.push(...(data ?? []) as ProfileObservation[]);
    if ((data?.length ?? 0) < 100) break;
  }
  const profile = buildOperatingProfile(rows);
  const state = await readSourceState(companyId, "website");
  const home = company.domain ? `https://${String(company.domain).replace(/^https?:\/\//, "")}` : null;
  const verified = Array.isArray(state.cursor?.verifiedUrls) ? state.cursor.verifiedUrls.filter((url): url is string => typeof url === "string" && url.length <= 2048 && !!home && sameCompanySite(url, home)).slice(0, 100) : [];
  const missing = new Set(profile.topics.filter(topic => topic.state === "unknown").map(topic => topic.id));
  const priority = (url: string) => {
    const kind = sitePageKind(new URL(url).pathname);
    if (kind === "services" && (missing.has("project_billing") || missing.has("recurring_revenue"))) return 4;
    if (kind === "locations" && missing.has("multi_location")) return 4;
    if (kind === "about" && missing.has("multi_entity")) return 3;
    if (kind === "news") return 2;
    return 1;
  };
  const [attempts, pending] = await Promise.all([
    verified.length ? db.from("intelligence_research_attempts").select("source_url,next_attempt_at,last_attempt_at")
      .eq("company_id", companyId).in("source_url", verified).limit(100) : Promise.resolve({ data: [], error: null }),
    db.from("intelligence_jobs").select("id,intelligence_observations:intelligence_observations!intelligence_jobs_observation_id_fkey!inner(company_id)", { count: "exact", head: true })
      .eq("intelligence_observations.company_id", companyId).in("status", ["queued", "running"]),
  ]);
  if (attempts.error || pending.error) throw new Error("research_state_unavailable");
  const candidates = researchCandidates(verified, (attempts.data ?? []) as ResearchAttempt[], priority);
  return { company, profile, nextSources: candidates.slice(0, 3), candidates, pendingJobs: pending.count ?? 0 };
}

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!isUuid(companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try {
    const { candidates: _candidates, ...result } = await loadProfile(companyId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }
  catch { return NextResponse.json({ error: "profile_unavailable" }, { status: 503 }); }
}

export async function POST(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOriginMutation(req)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  let body: Record<string, unknown>;
  try { body = await smallJson(req); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  if (!isUuid(body.companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try {
    const { company, candidates } = await loadProfile(body.companyId);
    const db = serviceClient();
    const { data: claims, error: claimError } = await db.rpc("intelligence_research_claim", { p_company: company.id, p_urls: candidates });
    if (claimError || !Array.isArray(claims)) throw new Error("research_claim_failed");
    // Persist observations during this invocation; acknowledged research is not a
    // volatile in-memory background task. Interpretations use the durable queue.
    const outcomes = await Promise.all((claims as { source_url: string; lease_token: string }[]).map(async claim => {
      const url = claim.source_url;
      let outcome: "queued" | "unchanged" | "source_failed" | "source_empty" = "source_failed";
      try {
        const fetched = await fetchPublicHttpText(url, { timeoutMs: 12000, maxRedirects: 4, maxBytes: 1000000 });
        if (fetched.status < 200 || fetched.status >= 300 || !sameCompanySite(fetched.finalUrl, url)) throw new Error("source_failed");
        const page = sitePageEvidence(fetched.body, fetched.finalUrl);
        if (!page.text.trim()) outcome = "source_empty";
        else {
          const published = page.sourceDates.find(date => date.kind === "published")?.value;
          const result = await enqueueObservation({ companyId: company.id, companyName: company.name, companyDomain: company.domain,
            netsuiteInternalId: company.netsuite_internal_id, sourceKind: "website", sourceUrl: page.url, title: page.title || company.name,
            text: page.text, eventDate: published ?? null, metadata: { focusedResearch: true, sourceDates: page.sourceDates, sourceTruncated: page.truncated } });
          if (!result) throw new Error("observation_not_persisted");
          outcome = result.queued ? "queued" : "unchanged";
        }
      } catch { outcome = "source_failed"; }
      const { data: saved, error: finishError } = await db.rpc("intelligence_research_finish", {
        p_company: company.id, p_url: url, p_lease: claim.lease_token, p_outcome: outcome,
      });
      if (finishError || saved !== true) throw new Error("research_completion_failed");
      return outcome;
    }));
    after(async () => { await runIntelligenceWorker(3, Date.now() + 120000).catch(() => {}); });
    await logEvent("headhunter", "intelligence.focused_research", { summary: `Refreshed ${claims.length} public account sources`, entity_type: "company", entity_id: company.id, meta: { outcomes } });
    return NextResponse.json({ ok: true, outcomes, sources: claims.length });
  } catch { return NextResponse.json({ error: "research_unavailable" }, { status: 503 }); }
}
