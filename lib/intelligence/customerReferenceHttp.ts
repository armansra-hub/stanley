import "server-only";
import { NextResponse } from "next/server";
import { smallJson } from "./http";
import { intelligenceEnabled } from "./observations";
import { customerReferenceProgress, runCustomerReferenceReading } from "./customerReferenceResearch";
import { withServiceDeadline } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";

const headers = { "Cache-Control": "no-store" };
/** Both entry points authenticate before calling these same bounded handlers. */
export async function customerReferenceProgressResponse() {
  try { return NextResponse.json(await withServiceDeadline(Date.now() + 15_000, customerReferenceProgress), { headers }); }
  catch { return NextResponse.json({ error: "customer_references_unavailable" }, { status: 503, headers }); }
}
export async function customerReferenceRunResponse(req: Request) {
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  try { if (Object.keys(await smallJson(req, 100)).length) throw new Error(); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  try {
    const run = await runCustomerReferenceReading(Date.now() + 250_000);
    await logEvent("headhunter", "intelligence.customer_references", { summary: `Read ${run.processed} customer reference websites; ${run.completed} completed`, meta: run });
    return NextResponse.json({ ...await customerReferenceProgress(), run }, { headers });
  } catch {
    return NextResponse.json({ error: "customer_reference_reading_interrupted", action: "Read saved progress before continuing; request receipts and leases are retained." }, { status: 503, headers });
  }
}
