import { NextRequest, NextResponse } from "next/server";
import { pruneListMembership } from "@/lib/db/companies";
import { logEvent } from "@/lib/db/events";

/**
 * Weekly-refresh prune: after re-importing a list CSV, drop the list tag (and
 * claimable, if it was the claimable list) from companies whose domain is NOT in
 * the fresh upload. Deliberate, separate step — imports themselves stay additive.
 * Body: { list: string, keepDomains: string[] }. Secret-guarded for prod use.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret");
  if (process.env.APP_PASSWORD && (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { list?: string; keepDomains?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body.list || !Array.isArray(body.keepDomains)) return NextResponse.json({ error: "need list + keepDomains" }, { status: 400 });
  try {
    const dropped = await pruneListMembership(body.list, new Set(body.keepDomains));
    await logEvent("headhunter", "list.pruned", { summary: `List ${body.list}: ${dropped} companies left the list (tag removed)`, entity_type: "import", meta: { list: body.list, dropped, kept: body.keepDomains.length } }).catch(() => {});
    return NextResponse.json({ dropped });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
