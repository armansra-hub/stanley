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
      .eq("company_id", companyId).eq("is_current", true).order("id").range(page * 100, page * 100 + 99);
    if (evidenceError) throw new Error("evidence_unavailable");
    rows.push(...(data ?? []) as ProfileObservation[]);
    if ((data?.length ?? 0) < 100) break;
  }
  const profile = buildOperatingProfile(rows);
  const state = await readSourceState(companyId, "website");
  const home = company.domain ? `https://${String(company.domain).replace(/^https?:\/\//, "")}` : null;
  const verified = Array.isArray(state.cursor?.verifiedUrls) ? state.cursor.verifiedUrls.filter((url): url is string => typeof url === "string" && !!home && sameCompanySite(url, home)) : [];
  const missing = new Set(profile.topics.filter(topic => topic.state === "unknown").map(topic => topic.id));
  const priority = (url: string) => {
    const kind = sitePageKind(new URL(url).pathname);
    if (kind === "services" && (missing.has("project_billing") || missing.has("recurring_revenue"))) return 4;
    if (kind === "locations" && missing.has("multi_location")) return 4;
    if (kind === "about" && missing.has("multi_entity")) return 3;
    if (kind === "news") return 2;
    return 1;
  };
  const nextSources = [...new Set(verified)].sort((a, b) => priority(b) - priority(a)).slice(0, 3);
  return { company, profile, nextSources };
}

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!isUuid(companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try { return NextResponse.json(await loadProfile(companyId), { headers: { "Cache-Control": "no-store" } }); }
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
    const { company, nextSources } = await loadProfile(body.companyId);
    // Persist observations during this invocation; acknowledged research is not a
    // volatile in-memory background task. Interpretations use the durable queue.
    const outcomes = await Promise.all(nextSources.map(async url => {
      try {
        const fetched = await fetchPublicHttpText(url, { timeoutMs: 12000, maxRedirects: 4, maxBytes: 1000000 });
        if (fetched.status < 200 || fetched.status >= 300 || !sameCompanySite(fetched.finalUrl, url)) return "source_failed";
        const page = sitePageEvidence(fetched.body, fetched.finalUrl);
        if (!page.text.trim()) return "source_empty";
        const published = page.sourceDates.find(date => date.kind === "published")?.value;
        const result = await enqueueObservation({ companyId: company.id, companyName: company.name, companyDomain: company.domain,
          netsuiteInternalId: company.netsuite_internal_id, sourceKind: "website", sourceUrl: page.url, title: page.title || company.name,
          text: page.text, eventDate: published ?? null, metadata: { focusedResearch: true, sourceDates: page.sourceDates, sourceTruncated: page.truncated } });
        return result?.queued ? "queued" : "unchanged";
      } catch { return "source_failed"; }
    }));
    after(async () => { await runIntelligenceWorker(3, Date.now() + 120000).catch(() => {}); });
    await logEvent("headhunter", "intelligence.focused_research", { summary: `Refreshed ${nextSources.length} public account sources`, entity_type: "company", entity_id: company.id, meta: { outcomes } });
    return NextResponse.json({ ok: true, outcomes, sources: nextSources.length });
  } catch { return NextResponse.json({ error: "research_unavailable" }, { status: 503 }); }
}
