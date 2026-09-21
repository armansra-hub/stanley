import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized } from "@/lib/intelligence/http";
import { readResearchProgress } from "@/lib/intelligence/researchProgress";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await readResearchProgress();
  return NextResponse.json(result, { status: result.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
