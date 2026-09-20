import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized, isUuid } from "@/lib/intelligence/http";
import { serviceClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("companyId");
  if (!id || !isUuid(id)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  const db = serviceClient();
  const [milestones, links, state, identities] = await Promise.all([
    db.from("contract_milestones").select("id,kind,milestone_date,label,source_url,evidence,federal_awards!inner(award_id,government_entity_id,start_date,end_date,potential_end_date,evidence)")
      .eq("company_id", id).gte("milestone_date", new Date().toISOString().slice(0, 10)).order("milestone_date").limit(100),
    db.from("contract_announcement_links").select("trigger_id,method,native_result,created_at,triggers!inner(summary,source_url),federal_awards!inner(award_id,government_entity_id,source_url,description)")
      .eq("company_id", id).order("created_at", { ascending: false }).limit(50),
    db.from("contract_intelligence_state").select("last_completed_at,last_error,next_due_at,last_award_id").eq("company_id", id).maybeSingle(),
    db.from("company_government_matches").select("government_entity_id").eq("company_id", id).eq("match_status", "verified"),
  ]);
  if (milestones.error || links.error || state.error || identities.error) return NextResponse.json({ error: "contract_intelligence_unavailable" }, { status: 503 });
  const currentEntities = new Set((identities.data ?? []).map(row => row.government_entity_id));
  // Old dates remain in durable receipts, but superseded dates cannot look current.
  const active = (milestones.data ?? []).filter(row => {
    const a = row.federal_awards as unknown as Record<string, unknown>;
    if (!currentEntities.has(String(a.government_entity_id))) return false;
    const e = a.evidence as Record<string, unknown> | null;
    const current = row.kind === "start" ? a.start_date : row.kind === "end" ? a.end_date : row.kind === "potential_end" ? a.potential_end_date : row.kind === "ordering_end" ? e?.orderingEndDate : null;
    if(row.kind === "option")return Array.isArray(e?.optionDates)&&e.optionDates.some(option=>option&&typeof option==="object"
      && String(option.date??"").slice(0,10)===row.milestone_date&&option.sourceUrl===row.source_url);
    if(row.kind === "potential_end"&&String(a.end_date??"").slice(0,10)===row.milestone_date)return false;
    return String(current ?? "").slice(0, 10) === row.milestone_date;
  });
  const currentLinks = (links.data ?? []).filter(row => currentEntities.has(String((row.federal_awards as unknown as Record<string, unknown>).government_entity_id)));
  return NextResponse.json({ milestones: active, links: currentLinks, state: state.data }, { headers: { "Cache-Control": "no-store" } });
}
