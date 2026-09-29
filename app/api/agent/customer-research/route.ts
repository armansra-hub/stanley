import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { withServiceDeadline } from "@/lib/supabase/server";
import { smallJson } from "@/lib/intelligence/http";
import { CustomerResearchError, customerResearchProgress, getCustomerResearchProof, loadCustomerResearchPage, saveCustomerResearchProfile } from "@/lib/intelligence/customerResearchServer";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof CustomerResearchError ? error.code : "customer_research_unavailable" },
    { status: error instanceof CustomerResearchError ? error.status : 503, headers });
}
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const query = new URL(req.url).searchParams;
  if ([...query.keys()].some(key => !["customerId", "after", "limit"].includes(key))
    || (query.has("customerId") && (query.has("after") || query.has("limit")))) return NextResponse.json({ error: "invalid_query" }, { status: 400, headers });
  try {
    return await withServiceDeadline(Date.now() + 20_000, async () => {
      if (query.has("customerId")) {
        const record = await getCustomerResearchProof(query.get("customerId")!);
        return NextResponse.json({ record }, { status: record ? 200 : 404, headers });
      }
      const [page, progress] = await Promise.all([loadCustomerResearchPage({ after: query.get("after") ?? undefined,
        limit: query.has("limit") ? Number(query.get("limit")) : undefined }), customerResearchProgress()]);
      return NextResponse.json({ ...page, progress, providerCalls: 0 }, { headers });
    });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = await smallJson(req, 4 * 1024 * 1024);
    if (Object.keys(body).some(key => !["profile", "expectedPreviousHash"].includes(key)) || !body.profile
      || (body.expectedPreviousHash != null && typeof body.expectedPreviousHash !== "string")) throw new Error("invalid_body");
  } catch (error) {
    const oversized = error instanceof Error && error.message === "body_too_large";
    return NextResponse.json({ error: oversized ? "customer_profile_exceeds_4mb" : "invalid_body",
      ...(oversized ? { action: "Keep the complete local archive. This endpoint does not truncate; use an explicit future chunked import for this profile." } : {}) }, { status: oversized ? 413 : 400, headers });
  }
  try {
    const result = await withServiceDeadline(Date.now() + 20_000, () => saveCustomerResearchProfile(body.profile, body.expectedPreviousHash as string | null | undefined));
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
