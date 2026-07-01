import { NextRequest, NextResponse } from "next/server";
import { applyKillActions, type Action } from "@/lib/killlist/applyActions";
import { listStages, listLeads } from "@/lib/db/killlist";
import { getPrefs } from "@/lib/db/missions";

export const maxDuration = 60;

/** Execute confirmed Kill List actions (the delete confirm card). */
export async function POST(req: NextRequest) {
  let body: { actions?: Action[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const actions = body?.actions ?? [];
  if (!Array.isArray(actions) || actions.length === 0) return NextResponse.json({ error: "actions[] required" }, { status: 400 });

  let tz = "America/Los_Angeles";
  try { tz = (await getPrefs()).timezone; } catch { /* default */ }

  const { results } = await applyKillActions(actions, tz);
  const [stages, leads] = await Promise.all([listStages(), listLeads()]);
  return NextResponse.json({ results, stages, leads });
}
