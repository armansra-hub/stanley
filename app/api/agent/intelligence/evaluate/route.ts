import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { evaluateEvidence, hasPrivateExcerptAuthorization } from "@/lib/intelligence/jev";
import { reserveJev, settleJev } from "@/lib/intelligence/budget";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { smallJson } from "@/lib/intelligence/http";
import type { SemanticCriterion } from "@/lib/intelligence/evaluation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Narrow private-excerpt endpoint: retains only cost/usage, never the excerpt,
 * annotation, PDF, claim, grade or company record. Local caller owns caching. */
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  if (!hasPrivateExcerptAuthorization()) return NextResponse.json({ error: "privacy_not_authorized" }, { status: 409 });
  let body: Record<string, unknown>;
  try { body = await smallJson(req, 20_000); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  if (typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 12_000 ||
    (body.criteria !== undefined && !Array.isArray(body.criteria))) return NextResponse.json({ error: "invalid_excerpt" }, { status: 400 });
  const criteria = (body.criteria ?? []) as SemanticCriterion[];
  if (criteria.length > 10 || new Set(criteria.map((c) => c?.id)).size !== criteria.length || criteria.some((c) => !c || typeof c.id !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(c.id) || typeof c.instructions !== "string" || !c.instructions.trim() || Buffer.byteLength(c.instructions) > 1200)) {
    return NextResponse.json({ error: "invalid_criteria" }, { status: 400 });
  }
  try {
    const reservation = await reserveJev();
    if (!reservation) return NextResponse.json({ error: "budget_deferred" }, { status: 429 });
    const result = await evaluateEvidence({ text: body.text, criteria, privacy: "private_excerpt" });
    await settleJev(reservation, result.usage?.inputTokens ?? null);
    return NextResponse.json(result, { status: result.ok ? 200 : result.error.retryable ? 503 : 422, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "evaluation_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
