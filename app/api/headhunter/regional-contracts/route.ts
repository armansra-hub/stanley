import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceUiAuthorized, isUuid, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const company = req.nextUrl.searchParams.get("companyId"), offset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  if (!isUuid(company) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  try {
    const db = serviceClient();
    const [account, matches, sources] = await Promise.all([
      db.from("companies").select("id").eq("id", company).neq("status", "removed_from_tam").not("lists", "cs", "{tam_duplicate}").maybeSingle(),
      db.from("regional_contract_matches").select("id,company_id,source_id,fact,identity_status,identity_method,identity_source_url,identity_note,reviewed_at,last_observed_at")
        .eq("company_id", company).order("last_observed_at", { ascending: false }).order("id").range(offset, offset + 20),
      db.from("regional_contract_sources").select("id,name,dataset_url,scope,next_offset,snapshot_complete,last_success_at,last_complete_at,last_error,scanned_rows,matched_rows").order("id"),
    ]);
    if (account.error || matches.error || sources.error) throw new Error();
    if (!account.data) return NextResponse.json({ error: "account_unavailable" }, { status: 404 });
    return NextResponse.json({ matches: (matches.data ?? []).slice(0, 20), sources: sources.data ?? [], hasMore: (matches.data?.length ?? 0) > 20 });
  } catch { return NextResponse.json({ error: "regional_context_unavailable" }, { status: 503 }); }
}
export async function POST(req: NextRequest) {
  if (!intelligenceUiAuthorized(req) || !sameOriginMutation(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await smallJson(req, 4000); } catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }
  if (!isUuid(body.companyId) || !isUuid(body.matchId) || !["candidate", "verified", "rejected"].includes(String(body.status))) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  let sourceUrl: string | null = null, note: string | null = null;
  if (body.status === "verified") {
    try {
      if (typeof body.sourceUrl !== "string" || body.sourceUrl.length > 2048 || typeof body.note !== "string" || body.note.trim().length < 12 || body.note.length > 500) throw new Error();
      sourceUrl = validatePublicHttpUrl(body.sourceUrl).toString(); note = body.note.trim();
    } catch { return NextResponse.json({ error: "identity_source_and_note_required" }, { status: 400 }); }
  }
  try {
    const { data, error } = await serviceClient().rpc("regional_contract_review", { p_company: body.companyId, p_match: body.matchId, p_status: body.status, p_source_url: sourceUrl, p_note: note });
    if (error) throw new Error();
    return data ? NextResponse.json({ saved: true }) : NextResponse.json({ error: "match_unavailable" }, { status: 404 });
  } catch { return NextResponse.json({ error: "regional_review_unavailable" }, { status: 503 }); }
}
