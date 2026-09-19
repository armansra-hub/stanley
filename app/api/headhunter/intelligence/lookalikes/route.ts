import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { intelligenceUiAuthorized, isUuid } from "@/lib/intelligence/http";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  const companyId = req.nextUrl.searchParams.get("companyId"), offset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  if (!isUuid(companyId) || !Number.isInteger(offset) || offset<0 || offset>100000) return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  try {
    const { data, error } = await serviceClient().rpc("intelligence_lookalikes", { p_company: companyId, p_offset: offset, p_limit: 8 });
    if (error || !data) throw new Error();
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "lookalikes_unavailable" }, { status: 503 }); }
}
