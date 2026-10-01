import { NextRequest, NextResponse } from "next/server";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { intelligenceUiAuthorized, isUuid } from "@/lib/intelligence/http";
import { buildTopicSearchResult, operatingTopicFilter, type TopicSearchRaw } from "@/lib/intelligence/topicSearch";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS } from "@/lib/intelligence/operatingCatalog";
import { operatingRecipe } from "@/lib/intelligence/operatingSearchCatalog";
import { catalogFacetVersion } from "@/lib/intelligence/operatingCoverage";
import { loadApprovedCustomerCriteria } from "@/lib/intelligence/customerCriteriaServer";
import { runtimeFacetVersions } from "@/lib/intelligence/customerCatalogRuntime";
import { buildApprovedTopicSearchResult } from "@/lib/intelligence/topicSearch";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const library = req.nextUrl.searchParams.get("library") ?? "legacy";
  if (library === "approved") return approvedTopics(req);
  if (library !== "legacy") return NextResponse.json({ error: "invalid_topic_library" }, { status: 400 });
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
      if (error) throw error;
      if (!data) throw new Error("topic_search_unavailable");
      return buildTopicSearchResult({ ...(data as TopicSearchRaw), recipeId });
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Keep only standard database codes; query values, provider messages and
    // connection details must never appear in diagnostics or browser errors.
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    console.error("intelligence.topic_search_unavailable", {
      code: typeof code === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(code) ? code : "unknown",
    });
    return NextResponse.json({ error: "topic_search_unavailable" }, { status: 503 });
  }
}

async function approvedTopics(req: NextRequest) {
  const topics = [...new Set(req.nextUrl.searchParams.getAll("topic"))], after = req.nextUrl.searchParams.get("after");
  const version = req.nextUrl.searchParams.get("version"), mode = req.nextUrl.searchParams.get("mode") ?? "all";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 8), hidden = req.nextUrl.searchParams.get("showHidden") ?? "false";
  if (!version || version.length > 120 || topics.length > 8 || !["any", "all"].includes(mode) || !["true", "false"].includes(hidden)
    || (after && !isUuid(after)) || !Number.isInteger(limit) || limit < 1 || limit > 12 || req.nextUrl.searchParams.has("recipe")
    || ![null, "supported"].includes(req.nextUrl.searchParams.get("visibility"))) return NextResponse.json({ error: "invalid_approved_topic_filter" }, { status: 400 });
  try {
    const result = await withServiceDeadline(Date.now() + 24_000, async () => {
      const db = serviceClient(), bundle = await loadApprovedCustomerCriteria(db);
      if (!bundle || bundle.catalog.version !== version) throw new Error("approved_catalog_unavailable");
      if (topics.some(id => !bundle.catalog.facets.some(f => f.id === id))) return null;
      const versions = runtimeFacetVersions(bundle.runtime);
      const { data, error } = await db.rpc("intelligence_catalog_topic_search", { p_topics: topics, p_catalog_version: version,
        p_facet_versions: versions, p_after: after, p_limit: limit, p_mode: mode, p_show_hidden: hidden === "true", p_visibility: "supported", p_combinations: null });
      if (error || !data) throw new Error("approved_topic_search_unavailable");
      return buildApprovedTopicSearchResult(data, bundle.catalog, versions);
    });
    return result ? NextResponse.json(result, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "invalid_approved_topic_filter" }, { status: 400 });
  } catch { return NextResponse.json({ error: "approved_topic_search_unavailable" }, { status: 503 }); }
}
