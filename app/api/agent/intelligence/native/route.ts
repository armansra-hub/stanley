import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { hasPrivateExcerptAuthorization, JEV_MODEL } from "@/lib/intelligence/jev";
import { evaluateNativeCached, evaluateNativeQuestions, nativeJevBody, type NativeJevInput } from "@/lib/intelligence/nativeJev";
import { reserveJev, settleJev } from "@/lib/intelligence/budget";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { smallJson } from "@/lib/intelligence/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return NextResponse.json({ enabled: intelligenceEnabled(), configured: !!process.env.TYPESAFE_API_KEY,
    privateExcerptsAuthorized: hasPrivateExcerptAuthorization(), model: JEV_MODEL,
    provider: "typesafe-direct", nativeQuestions: ["noul", "choice", "score"], maxRequestBytes: 48_000 }, { headers });
}
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409, headers });
  let input: NativeJevInput;
  try {
    const body = await smallJson(req, 50_000);
    if (!["public", "private_excerpt"].includes(String(body.privacy))) throw new Error("explicit_privacy_required");
    input = body as NativeJevInput;
    nativeJevBody(input);
  } catch { return NextResponse.json({ error: "invalid_native_request" }, { status: 400, headers }); }
  if (input.privacy === "private_excerpt" && !hasPrivateExcerptAuthorization())
    return NextResponse.json({ error: "privacy_not_authorized" }, { status: 409, headers });
  try {
    if (input.privacy === "public") {
      const receipt = await evaluateNativeCached(input, { purpose: "codex_connector", sourceKind: "codex_public", workload: "manual" });
      if (receipt.status !== "complete") return NextResponse.json(receipt, { status: receipt.status === "busy" ? 409 : 429, headers });
      return NextResponse.json(receipt, { status: receipt.evaluation.ok ? 200 : 422, headers });
    }
    // Private input/answers never enter the public response cache. The local MCP
    // caller owns its intent and answer receipt, exactly as the local TAM caller does.
    const reservation = await reserveJev({ purpose: "codex_connector", sourceKind: "codex_private", workload: "manual" });
    if (!reservation) return NextResponse.json({ status: "budget_deferred" }, { status: 429, headers });
    const evaluation = await evaluateNativeQuestions(input);
    let accountingPending = false;
    try { await settleJev(reservation, evaluation.usage?.inputTokens ?? null); } catch { accountingPending = true; }
    // Never discard a paid answer because the subsequent accounting request failed.
    return NextResponse.json({ status: "complete", evaluation, reused: false, accountingPending },
      { status: evaluation.ok ? 200 : 422, headers });
  } catch { return NextResponse.json({ error: "native_evaluation_unavailable" }, { status: 503, headers }); }
}
