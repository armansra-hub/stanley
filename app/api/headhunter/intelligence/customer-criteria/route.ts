import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized } from "@/lib/intelligence/http";
import { withServiceDeadline } from "@/lib/supabase/server";
import { loadCustomerCriteriaCatalog } from "@/lib/intelligence/customerCriteriaServer";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json(await withServiceDeadline(Date.now() + 24_000, loadCustomerCriteriaCatalog), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ available: false, error: "customer_criteria_unavailable" }, { status: 503 }); }
}
