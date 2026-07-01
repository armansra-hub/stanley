import { NextRequest, NextResponse } from "next/server";
import { applyActions, type Action } from "@/lib/missions/applyActions";
import { getPrefs, listMissions } from "@/lib/db/missions";

export const maxDuration = 60;

/** Execute a confirmed plan. Body: { actions }. Returns { results, missions } so the
 * UI can refresh the board after the writes apply. */
export async function POST(req: NextRequest) {
  let body: { actions?: Action[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const actions = body?.actions ?? [];
  if (!Array.isArray(actions) || actions.length === 0) {
    return NextResponse.json({ error: "actions[] required" }, { status: 400 });
  }
  let tz = "America/Los_Angeles";
  try { tz = (await getPrefs()).timezone; } catch { /* default */ }

  const { results } = await applyActions(actions, tz);
  const missions = await listMissions({ status: "active" });
  return NextResponse.json({ results, missions });
}
