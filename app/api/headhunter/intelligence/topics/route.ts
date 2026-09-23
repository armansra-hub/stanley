import { NextRequest, NextResponse } from "next/server";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { intelligenceUiAuthorized, isUuid } from "@/lib/intelligence/http";
import { buildTopicSearchResult, operatingTopicFilter, type TopicSearchRaw } from "@/lib/intelligence/topicSearch";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const topics = operatingTopicFilter(req.nextUrl.searchParams.getAll("topic"));
  const after = req.nextUrl.searchParams.get("after");
  const mode = req.nextUrl.searchParams.get("mode") ?? "all";
  const visibility = req.nextUrl.searchParams.get("visibility") ?? "supported";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 8);
  if (!topics || !["all", "any"].includes(mode) || !["supported", "explore"].includes(visibility) || (after && !isUuid(after)) || !Number.isInteger(limit) || limit < 1 || limit > 12) {
    return NextResponse.json({ error: "invalid_topic_filter" }, { status: 400 });
  }
  // This searches stored answers only. Pausing processing must not hide them.
  try {
    const result = await withServiceDeadline(Date.now() + 20_000, async () => {
      const { data, error } = await serviceClient().rpc(visibility === "explore" ? "intelligence_topic_explore" : "intelligence_topic_search", { p_topics: topics, p_after: after || null, p_limit: limit, p_mode: mode });
      if (error || !data) throw new Error("topic_search_unavailable");
      return buildTopicSearchResult(data as TopicSearchRaw);
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "topic_search_unavailable" }, { status: 503 }); }
}
