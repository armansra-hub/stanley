import { NextRequest, NextResponse, after } from "next/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { intelligenceUiAuthorized, isUuid, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { loadAccountIntelligence, queueAccountStory, runAccountStoryWorker } from "@/lib/intelligence/narratives";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function accountExists(id: string) {
  const { data, error } = await serviceClient().from("companies").select("id").eq("id", id).neq("status", "removed_from_tam").maybeSingle();
  if (error) throw new Error("account_lookup_unavailable");
  return Boolean(data);
}
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!isUuid(companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try {
    if (!await accountExists(companyId)) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    return NextResponse.json(await loadAccountIntelligence(companyId), { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "account_research_unavailable" }, { status: 503 }); }
}
export async function POST(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOriginMutation(req)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  let body: Record<string, unknown>;
  try { body = await smallJson(req); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  if (!isUuid(body.companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try {
    if (!await accountExists(body.companyId)) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    const queued = await queueAccountStory(body.companyId, { force: true });
    if (queued) after(async () => { await runAccountStoryWorker(1, Date.now() + 40_000); });
    return NextResponse.json({ ok: true, queued });
  } catch { return NextResponse.json({ error: "account_research_unavailable" }, { status: 503 }); }
}
