import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized } from "@/lib/intelligence/http";
import { withServiceDeadline } from "@/lib/supabase/server";
import { CUSTOMER_PATTERNS } from "@/lib/intelligence/customerMatches";
import { loadCustomerMatches } from "@/lib/intelligence/customerMatchesServer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pattern = req.nextUrl.searchParams.get("pattern") ?? "all";
  const page = Number(req.nextUrl.searchParams.get("page") ?? "1");
  const hidden = req.nextUrl.searchParams.get("showHidden") ?? "false";
  if ((pattern !== "all" && !CUSTOMER_PATTERNS.some(p => p.id === pattern)) || !Number.isSafeInteger(page) || page < 1
    || !["true", "false"].includes(hidden)) return NextResponse.json({ error: "invalid_customer_match_query" }, { status: 400 });
  try {
    const result = await withServiceDeadline(Date.now() + 24_000, () => loadCustomerMatches({ pattern, page, showHidden: hidden === "true" }));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    console.error("intelligence.customer_matches_unavailable", { code: typeof code === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(code) ? code : "unknown" });
    return NextResponse.json({ error: "customer_matches_unavailable" }, { status: 503 });
  }
}
