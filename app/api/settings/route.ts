import { NextRequest, NextResponse } from "next/server";
import {
  setTerritoryConfig,
  updateAppConfig,
  updateScoringWeights,
  setActorEnabled,
} from "@/lib/db/settings";

// Single settings endpoint. POST { section, payload }. Single-user — no auth
// here yet (add before shared deploy).
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { section?: string; payload?: any };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { section, payload } = body;
  try {
    switch (section) {
      case "territory":
        await setTerritoryConfig(payload);
        break;
      case "app":
        await updateAppConfig(payload);
        break;
      case "scoring":
        await updateScoringWeights(payload?.rows ?? []);
        break;
      case "actors":
        await setActorEnabled(payload?.key, payload?.enabled);
        break;
      default:
        return NextResponse.json({ error: "unknown section" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
