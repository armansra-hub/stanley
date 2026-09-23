import { NextRequest, NextResponse, after } from "next/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { intelligenceUiAuthorized, isUuid, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { loadResearchProfile, refreshAccountResearch } from "@/lib/intelligence/researchRunner";
import { withServiceDeadline } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!isUuid(companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try {
    const deadline = Date.now() + 15_000;
    const { candidates: _candidates, ...result } = await withServiceDeadline(deadline, () => loadResearchProfile(companyId, deadline));
    return NextResponse.json({ ...result, processingEnabled: intelligenceEnabled() }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "profile_unavailable" }, { status: 503 }); }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOriginMutation(req)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  let body: Record<string, unknown>;
  try { body = await smallJson(req); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  if (!isUuid(body.companyId)) return NextResponse.json({ error: "invalid_company" }, { status: 400 });
  try {
    const result = await refreshAccountResearch(body.companyId, { deadlineMs: startedAt + 90_000 });
    if (result.outcomes.includes("queued")) after(async () => {
      await runIntelligenceWorker(12, startedAt + 270_000).catch(() => {});
    });
    return NextResponse.json({ ok: true, ...result });
  } catch { return NextResponse.json({ error: "research_unavailable" }, { status: 503 }); }
}
