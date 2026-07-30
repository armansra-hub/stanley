import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { promoteCandidate } from "@/lib/db/triggers";
import { logEvent } from "@/lib/db/events";

/**
 * Publish verified trigger candidates. Only rows already marked verdict='keep' are
 * eligible — this endpoint cannot create a verdict, so nothing reaches the Triggered
 * tab that a reviewer did not explicitly approve.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 200) || 200, 500);

  const { data, error } = await serviceClient()
    .from("trigger_candidates")
    .select("id, company_name, type")
    .eq("verdict", "keep").is("promoted_trigger_id", null)
    .order("created_at", { ascending: true }).limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const promoted: string[] = [], failed: string[] = [];
  for (const c of data ?? []) {
    (await promoteCandidate(String(c.id)) ? promoted : failed).push(`${c.company_name} (${c.type})`);
  }
  await logEvent("headhunter", "trigger.promoted", {
    summary: `Published ${promoted.length} verified news triggers (${failed.length} failed)`,
    entity_type: "agent_bridge", meta: { promoted: promoted.length, failed: failed.length },
  });
  return NextResponse.json({ promoted: promoted.length, failed: failed.length, promotedList: promoted.slice(0, 60), failedList: failed.slice(0, 20) });
}
