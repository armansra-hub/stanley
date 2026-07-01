import { NextRequest, NextResponse } from "next/server";
import { createMission, type CreateMissionInput } from "@/lib/db/missions";
import { reissueInvite } from "@/lib/missions/sync";

/** Create a mission. If it has a time + email is configured, email the invite so
 * it lands on Outlook (best-effort). */
export async function POST(req: NextRequest) {
  let body: CreateMissionInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body?.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });

  try {
    const mission = await createMission(body);
    const invite = await reissueInvite(mission.id);
    return NextResponse.json({ ...mission, invite_sent: invite.sent });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
