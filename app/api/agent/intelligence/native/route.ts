import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { JEV_MODEL } from "@/lib/intelligence/jev";
import { evaluateNativeCached, nativeJevBody, type NativeJevInput } from "@/lib/intelligence/nativeJev";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { smallJson } from "@/lib/intelligence/http";
import { readJevBudgetPolicy } from "@/lib/intelligence/budget";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS, OPERATING_INDUSTRY_GUIDES } from "@/lib/intelligence/operatingCatalog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const budget = await readJevBudgetPolicy();
  const configured = !!process.env.TYPESAFE_API_KEY;
  return NextResponse.json({ enabled: intelligenceEnabled() && configured && budget.available && budget.enabled, configured,
    budget, budgetStatusPath: "/api/agent/intelligence/budget-status",
    catalog: { version: OPERATING_CATALOG_VERSION, facets: OPERATING_FACETS.length, industryGuides: OPERATING_INDUSTRY_GUIDES.length },
    privateExcerptsAuthorized: false, model: JEV_MODEL,
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
  if (input.privacy === "private_excerpt")
    return NextResponse.json({ error: "private_evaluation_excluded_from_jev_policy" }, { status: 409, headers });
  try {
    const receipt = await evaluateNativeCached(input, { purpose: "codex_connector", sourceKind: "codex_public", workload: "manual" });
    if (receipt.status !== "complete") return NextResponse.json(receipt, { status: receipt.status === "busy" ? 409 : 429, headers });
    return NextResponse.json(receipt, { status: receipt.evaluation.ok ? 200 : 422, headers });
  } catch { return NextResponse.json({ error: "native_evaluation_unavailable" }, { status: 503, headers }); }
}
