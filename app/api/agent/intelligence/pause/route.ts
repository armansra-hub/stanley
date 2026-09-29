import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { smallJson } from "@/lib/intelligence/http";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const policyId = "jev-rollout-2026-09-24";
const haltReason = "user_requested_customer_research_pause";

/** Pause-only control. Existing native receipts and TAM grading are untouched. */
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  try {
    const body = await smallJson(req, 1_024);
    if (Object.keys(body).length !== 1 || body.paused !== true) throw new Error("invalid_pause_request");
  } catch {
    return NextResponse.json({ error: "invalid_pause_request" }, { status: 400, headers });
  }

  try {
    const updatedAt = new Date().toISOString();
    const { data, error } = await serviceClient().from("intelligence_jev_budget_policy")
      .update({ enabled: false, halt_reason: haltReason, updated_at: updatedAt })
      .eq("id", policyId).select("id,enabled,halt_reason,updated_at").single();
    if (error || !data || data.id !== policyId || data.enabled !== false || data.halt_reason !== haltReason
      || typeof data.updated_at !== "string" || Date.parse(data.updated_at) !== Date.parse(updatedAt)) {
      throw new Error("pause_readback_unavailable");
    }
    return NextResponse.json({ paused: true, policy: data }, { headers });
  } catch {
    return NextResponse.json({ error: "jev_pause_unavailable" }, { status: 503, headers });
  }
}
