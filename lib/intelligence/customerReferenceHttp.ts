import "server-only";
import { NextResponse } from "next/server";
import { customerReferenceProgress } from "./customerReferenceResearch";
import { withServiceDeadline } from "@/lib/supabase/server";

const headers = { "Cache-Control": "no-store" };
/** Both entry points authenticate before calling these same bounded handlers. */
export async function customerReferenceProgressResponse() {
  try { return NextResponse.json(await withServiceDeadline(Date.now() + 15_000, customerReferenceProgress), { headers }); }
  catch { return NextResponse.json({ error: "customer_references_unavailable" }, { status: 503, headers }); }
}
export async function customerReferenceRunResponse(_req: Request) {
  // Research is now authored from full website reads. The old paid customer
  // classifier must never claim a reference or create a repeated deferral.
  return NextResponse.json({ error: "customer_research_is_codex_owned",
    action: "Use the customer research workflow. Existing Jev reference answers remain available." }, { status: 409, headers });
}
