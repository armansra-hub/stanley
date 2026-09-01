import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { reheatCompanyForFreshSignal } from "@/lib/db/reheat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Repair signals that landed through an older writer which did not reheat leads. */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const since = url.searchParams.get("since");
  if (!since || !Number.isFinite(Date.parse(since))) {
    return NextResponse.json({ error: "valid since timestamp required" }, { status: 400 });
  }
  const db = serviceClient();
  const { data: triggers, error } = await db.from("triggers")
    .select("company_id,type,source_url,signal_date,detected_at")
    .gte("detected_at", since)
    .order("detected_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`fresh trigger read failed: ${error.message}`);

  const newest = new Map<string, { type: string; sourceUrl: string | null; signalDate: string | null; detectedAt: string }>();
  for (const row of triggers ?? []) {
    const id = String(row.company_id);
    if (!newest.has(id)) newest.set(id, {
      type: String(row.type), sourceUrl: row.source_url, signalDate: row.signal_date, detectedAt: String(row.detected_at),
    });
  }

  let eligible = 0, reheated = 0, preserved = 0;
  for (const [companyId, trigger] of newest) {
    const { data: decision } = await db.from("app_events")
      .select("ts")
      .eq("module", "headhunter")
      .eq("kind", "lead.status_changed")
      .contains("meta", { ids: [companyId] })
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (decision?.ts && Date.parse(String(decision.ts)) >= Date.parse(trigger.detectedAt)) {
      preserved++;
      continue;
    }
    eligible++;
    if (await reheatCompanyForFreshSignal(companyId, trigger.type, trigger.sourceUrl, trigger.signalDate)) reheated++;
  }
  return NextResponse.json({ since, triggers: triggers?.length ?? 0, companies: newest.size, eligible, reheated, preserved });
}
