import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { historicalFederalRepairSnapshot, runHistoricalFederalRemediation } from "@/lib/publicGrowth/federalIdentityResearch";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const offset = Number(new URL(req.url).searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return NextResponse.json({ error: "Invalid offset" }, { status: 400 });
  try { return NextResponse.json(await historicalFederalRepairSnapshot(offset)); }
  catch { return NextResponse.json({ error: "Repair snapshot unavailable" }, { status: 503 }); }
}
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let input: unknown;
  try { input = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const limit = input && typeof input === "object" && "limit" in input ? input.limit : 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) return NextResponse.json({ error: "limit must be 1–20" }, { status: 400 });
  const result = await runHistoricalFederalRemediation(limit);
  return NextResponse.json(result, { status: result.status === "failed" ? 503 : 200 });
}
