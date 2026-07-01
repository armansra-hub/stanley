import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { runKillListAgent } from "@/lib/killlist/agent";
import { listStages, listLeads } from "@/lib/db/killlist";
import { getPrefs, logStanleyTurn } from "@/lib/db/missions";

export const maxDuration = 60;

/** Stanley Kill List turn. Body: { messages }. Returns { reply, plan, changed,
 * messages, stages, leads } (board refreshed when a write applied). */
export async function POST(req: NextRequest) {
  let body: { messages?: Anthropic.MessageParam[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return NextResponse.json({ error: "messages[] required" }, { status: 400 });

  let tz = "America/Los_Angeles";
  try { tz = (await getPrefs()).timezone; } catch { /* default */ }

  const last = messages[messages.length - 1];
  const userText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");

  try {
    const result = await runKillListAgent(messages, tz);
    await logStanleyTurn(`[killlist] ${userText}`, result.reply, result.plan.map((p) => p.describe));
    if (result.changed) {
      const [stages, leads] = await Promise.all([listStages(), listLeads()]);
      return NextResponse.json({ ...result, stages, leads });
    }
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[killlist] error", msg, "| user:", userText);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
