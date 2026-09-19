import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Read-only public evidence for one canonical local CRM record. No CRM notes,
 * grades, model calls, refresh jobs or private excerpts enter this route. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  const internalId = new URL(req.url).searchParams.get("internalId");
  if (!internalId || !/^[1-9]\d{0,19}$/.test(internalId)) return NextResponse.json({ error: "invalid_exact_id" }, { status: 400 });
  try {
    const db = serviceClient();
    const { data: companies, error } = await db.from("companies").select("id,name,netsuite_internal_id")
      .eq("netsuite_internal_id", internalId).contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam").limit(2);
    if (error) throw new Error("account_unavailable");
    if (!companies?.length) return NextResponse.json({ error: "current_exact_account_not_found" }, { status: 404 });
    if (companies.length !== 1) return NextResponse.json({ error: "ambiguous_exact_account" }, { status: 409 });
    const company = companies[0];
    const { data, error: evidenceError } = await db.from("intelligence_observations")
      .select("id,source_url,title,event_date,observed_at,evidence_text,attributes")
      .eq("company_id", company.id).eq("is_current", true).eq("feedback_excluded", false)
      .order("observed_at", { ascending: false }).order("id").limit(101);
    if (evidenceError) throw new Error("public_evidence_unavailable");
    const observations = (data ?? []).slice(0, 100).map(row => {
      const attributes = row.attributes && typeof row.attributes === "object" ? row.attributes as Record<string, unknown> : {};
      const excerpt = typeof attributes.evidenceExcerpt === "string" ? attributes.evidenceExcerpt : String(row.evidence_text ?? "");
      return { id: row.id, url: row.source_url, title: row.title, eventDate: row.event_date, observedAt: row.observed_at,
        excerpt: excerpt.slice(0, 1600), excerptTruncated: excerpt.length > 1600,
        relationship: attributes.companyRelationship ?? "unknown", signalType: attributes.signalType ?? null };
    });
    return NextResponse.json({ schema: "stanley-public-account-context", version: 1, internalId, companyId: company.id,
      fetchedAt: new Date().toISOString(), observations,
      coverage: { scope: "latest_current_public_observations", limit: 100, partial: (data?.length ?? 0) > 100 },
      note: "Public source context only. Collection time is not event time. This response does not change a TAM grade." },
    { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "public_context_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
