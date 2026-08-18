import { NextResponse } from "next/server";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";
import { serviceClient } from "@/lib/supabase/server";
import { promoteCandidate } from "@/lib/db/triggers";
import { logEvent } from "@/lib/db/events";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? 100) || 100, 1), 500);
  const { data, error } = await serviceClient().from("trigger_candidates")
    .select("id,company_id,netsuite_internal_id,company_name,type,summary,source_name,source_url,signal_date,created_at")
    .is("verdict", null).order("created_at", { ascending: true }).limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ count: data?.length ?? 0, candidates: data ?? [] });
}

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let body: { decisions?: Array<{ id?: unknown; verdict?: unknown; reason?: unknown }>; agent?: unknown } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const decisions = Array.isArray(body.decisions) ? body.decisions.slice(0, 100) : [];
  if (!decisions.length) return NextResponse.json({ error: "decisions required" }, { status: 400 });
  const reviewer = callerAgent(req, body.agent);
  const db = serviceClient();
  let kept = 0, rejected = 0, promoted = 0, skipped = 0;
  for (const decision of decisions) {
    const id = String(decision.id ?? "").trim();
    const verdict = decision.verdict === "keep" || decision.verdict === "reject" ? decision.verdict : null;
    const reason = String(decision.reason ?? "").trim();
    if (!id || !verdict || reason.length < 12) { skipped++; continue; }
    const { data, error } = await db.from("trigger_candidates")
      .update({ verdict, verdict_reason: reason.slice(0, 1000), verdict_by: reviewer, decided_at: new Date().toISOString() })
      .eq("id", id).is("verdict", null).select("id").maybeSingle();
    if (error || !data) { skipped++; continue; }
    if (verdict === "keep") {
      kept++;
      if (await promoteCandidate(id)) promoted++;
    } else rejected++;
  }
  await logEvent("headhunter", "trigger.candidates_reviewed", {
    summary: `Reviewed ${kept + rejected} news candidates: ${kept} kept, ${rejected} rejected, ${promoted} published`,
    entity_type: "agent_bridge", meta: { reviewer, kept, rejected, promoted, skipped },
  });
  return NextResponse.json({ reviewer, kept, rejected, promoted, skipped });
}
