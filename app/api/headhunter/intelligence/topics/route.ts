import { NextRequest, NextResponse } from "next/server";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { intelligenceUiAuthorized, isUuid } from "@/lib/intelligence/http";
import { buildTopicSearchResult, operatingTopicFilter, type TopicSearchRaw } from "@/lib/intelligence/topicSearch";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS } from "@/lib/intelligence/operatingCatalog";
import { operatingRecipe } from "@/lib/intelligence/operatingSearchCatalog";
import { catalogFacetVersion } from "@/lib/intelligence/operatingCoverage";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const recipeId = req.nextUrl.searchParams.get("recipe");
  const recipe = recipeId ? operatingRecipe(recipeId) : null;
  const topics = operatingTopicFilter(recipe ? recipe.topics : req.nextUrl.searchParams.getAll("topic"));
  const after = req.nextUrl.searchParams.get("after");
  const mode = req.nextUrl.searchParams.get("mode") ?? "all";
  const visibility = req.nextUrl.searchParams.get("visibility") ?? "supported";
  const showHidden = req.nextUrl.searchParams.get("showHidden") === "true";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 8);
  if ((recipeId && !recipe) || !topics || !["all", "any"].includes(mode) || !["supported", "explore"].includes(visibility) || (after && !isUuid(after)) || !Number.isInteger(limit) || limit < 1 || limit > 12) {
    return NextResponse.json({ error: "invalid_topic_filter" }, { status: 400 });
  }
  // This searches stored answers only. Pausing processing must not hide them.
  try {
    const result = await withServiceDeadline(Date.now() + 20_000, async () => {
      const { data, error } = await serviceClient().rpc("intelligence_catalog_topic_search", { p_topics: topics, p_catalog_version: OPERATING_CATALOG_VERSION,
        p_facet_versions: Object.fromEntries(OPERATING_FACETS.map(facet => [facet.id, catalogFacetVersion(facet)])),
        p_after: after || null, p_limit: limit, p_mode: mode, p_show_hidden: showHidden, p_visibility: visibility, p_combinations: recipe?.combinations ?? null });
      if (error || !data) throw new Error("topic_search_unavailable");
      return buildTopicSearchResult({ ...(data as TopicSearchRaw), recipeId });
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "topic_search_unavailable" }, { status: 503 }); }
}
