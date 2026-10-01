import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized } from "@/lib/intelligence/http";
import { withServiceDeadline } from "@/lib/supabase/server";
import { loadCustomerCriterionExamples } from "@/lib/intelligence/customerCriteriaServer";
import { OPERATING_INDUSTRY_GUIDES } from "@/lib/intelligence/operatingCatalog";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const version = req.nextUrl.searchParams.get("version") ?? "", criterion = req.nextUrl.searchParams.get("criterion") ?? "";
  const industry = req.nextUrl.searchParams.get("industry") ?? "all", page = Number(req.nextUrl.searchParams.get("page") ?? 1);
  if (!version || version.length > 120 || !/^[a-zA-Z0-9_.-]{1,160}$/.test(criterion) || !Number.isSafeInteger(page) || page < 1
    || industry !== "all" && !OPERATING_INDUSTRY_GUIDES.some(g => g.id === industry)) return NextResponse.json({ error: "invalid_customer_criteria_query" }, { status: 400 });
  try { return NextResponse.json(await withServiceDeadline(Date.now() + 24_000, () => loadCustomerCriterionExamples({ version, criterion, industry, page })), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "customer_criteria_examples_unavailable" }, { status: 503 }); }
}
