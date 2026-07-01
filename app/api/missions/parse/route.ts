import { NextRequest, NextResponse } from "next/server";
import { parseMissions } from "@/lib/missions/parse";
import { getPrefs } from "@/lib/db/missions";

/** Parse natural language into one or more mission DRAFTS (not created — confirm-before-apply). */
export async function POST(req: NextRequest) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const text = body?.text?.trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  let tz = "America/Los_Angeles";
  try {
    tz = (await getPrefs()).timezone;
  } catch {
    /* defaults */
  }
  const drafts = await parseMissions(text, tz);
  if (drafts.length === 0) return NextResponse.json({ error: "could not parse" }, { status: 422 });
  return NextResponse.json({ drafts });
}
