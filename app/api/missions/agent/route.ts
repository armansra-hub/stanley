import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { runMissionsAgent } from "@/lib/missions/agent";
import { getPrefs, logStanleyTurn, listMissions } from "@/lib/db/missions";

export const maxDuration = 60;

/** Stanley agent turn. Body: { messages } (the running Anthropic history, with the
 * new user message already appended). Returns { reply, plan, messages }. */
export async function POST(req: NextRequest) {
  let body: { messages?: Anthropic.MessageParam[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages[] required" }, { status: 400 });
  }
  let tz = "America/Los_Angeles";
  try { tz = (await getPrefs()).timezone; } catch { /* default */ }

  // The user's exact latest words (for the log).
  const last = messages[messages.length - 1];
  const userText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");

  try {
    const result = await runMissionsAgent(messages, tz);
    const planSummary = result.plan.map((p) => p.describe);
    console.log("[stanley]", JSON.stringify({ userText, reply: result.reply, plan: planSummary, changed: result.changed }));
    await logStanleyTurn(userText, result.reply, planSummary);
    const missions = result.changed ? await listMissions({ status: "active" }) : undefined;
    return NextResponse.json({ ...result, missions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[stanley] error", msg, "| user:", userText);
    await logStanleyTurn(userText, `ERROR: ${msg}`, null);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
