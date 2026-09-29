import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { withServiceDeadline } from "@/lib/supabase/server";
import { CustomerResearchError, loadCustomerResearchSavedSources } from "@/lib/intelligence/customerResearchServer";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const headers = { "Cache-Control": "no-store" }, query = new URL(req.url).searchParams;
  if (!query.has("customerId") || [...query.keys()].some(key => !["customerId", "offset", "limit", "registryUpdatedAt"].includes(key))) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400, headers });
  }
  try {
    const result = await withServiceDeadline(Date.now() + 20_000, () => loadCustomerResearchSavedSources({ customerId: query.get("customerId")!,
      offset: query.has("offset") ? Number(query.get("offset")) : undefined, limit: query.has("limit") ? Number(query.get("limit")) : undefined,
      registryUpdatedAt: query.get("registryUpdatedAt") ?? undefined }));
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof CustomerResearchError ? error.code : "customer_sources_unavailable" },
      { status: error instanceof CustomerResearchError ? error.status : 503, headers });
  }
}
