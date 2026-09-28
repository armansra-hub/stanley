import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { customerReferenceProgress, runCustomerReferenceReading } from "@/lib/intelligence/customerReferenceResearch";
import { withServiceDeadline } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "no-store" };
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json(await withServiceDeadline(Date.now() + 15_000, customerReferenceProgress), { headers }); }
  catch { return NextResponse.json({ error: "customer_references_unavailable" }, { status: 503, headers }); }
}
export async function POST(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOriginMutation(req)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  try { if (Object.keys(await smallJson(req, 100)).length) throw new Error(); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  try {
    const run = await runCustomerReferenceReading(Date.now() + 250_000);
    await logEvent("headhunter", "intelligence.customer_references", { summary: `Read ${run.processed} customer reference websites; ${run.completed} completed`, meta: run });
    return NextResponse.json({ ...await customerReferenceProgress(), run }, { headers });
  } catch { return NextResponse.json({ error: "customer_reference_reading_interrupted", action: "Read saved progress before continuing; request receipts and leases are retained." }, { status: 503, headers }); }
}
