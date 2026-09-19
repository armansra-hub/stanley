import "server-only";
import Parser from "rss-parser";
import { googleNewsRss } from "@/config/news";
import { parseDateLoose } from "@/lib/time";
import type { Candidate } from "@/lib/ingest/types";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { publicResponseOutcome, sourceErrorCode, type SourceErrorCode } from "./outcomes";

/**
 * Google News RSS adapter (FREE). Each item becomes a name-only candidate whose
 * "name" is the headline — the AI enrichment step extracts the actual company
 * and classifies territory. The article link is the signal's source_url.
 * Source-isolated: a failing feed never aborts the run.
 */
const parser = new Parser({ timeout: 12000, customFields: { item: [["source", "publisher", { keepArray: true }]] } });

async function parsePublicFeed(url: string) {
  const response = await fetchPublicHttpText(url, {
    timeoutMs: 12_000,
    maxBytes: 4_000_000,
    accept: "application/rss+xml,application/atom+xml,application/xml,text/xml",
  });
  if (response.status < 200 || response.status >= 300) throw new Error("feed request failed");
  return parser.parseString(response.body);
}

export interface NewsItem { source_name: string; source_url: string; raw_excerpt: string; signal_date: string | null; publisher_url?: string; feed_excerpt?: string }
export type NewsFetchResult = { items: NewsItem[]; status: "success" | "empty" | "unavailable"; error?: SourceErrorCode; httpStatus?: number };

/** A parsed empty feed is healthy. HTTP and parse errors are separately visible. */
export async function fetchNewsItemsResult(query: string, n = 6): Promise<NewsFetchResult> {
  let response;
  try {
    const url = googleNewsRss(query);
    response = await fetchPublicHttpText(url, { timeoutMs: 10000, maxBytes: 4000000, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" });
    const outcome = publicResponseOutcome(url, response.status, response.body);
    if (outcome.outcome !== "success") return { items: [], status: "unavailable", error: outcome.code ?? "http_error", httpStatus: response.status };
  } catch (error) { return { items: [], status: "unavailable", error: sourceErrorCode(error) }; }
  try {
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(response.body)) throw new Error("Not a feed");
    const feed = await parser.parseString(response.body);
    const items = (feed.items ?? []).slice(0, n).map(item => {
      const source = (item as typeof item & { publisher?: { $?: { url?: string }; _?: string }[] }).publisher?.[0];
      const publisher = source && typeof source === "object" ? source.$?.url : undefined;
      return { source_name: "Google News", source_url: (item.link ?? "").trim(), raw_excerpt: (item.title ?? "").trim(),
        signal_date: parseDateLoose(item.isoDate ?? item.pubDate), ...(publisher ? { publisher_url: publisher } : {}),
        ...(item.contentSnippet ? { feed_excerpt: item.contentSnippet.slice(0, 2000) } : {}) };
    }).filter(item => item.source_url && item.raw_excerpt);
    return { items, status: items.length ? "success" : "empty", httpStatus: response.status };
  } catch { return { items: [], status: "unavailable", error: "parse_error", httpStatus: response.status }; }
}

export const fetchNewsForCompanyResult = (name: string, n = 24) => fetchNewsItemsResult(`"${name}"`, n);

/** Free Google News RSS fetch for an arbitrary query. Top N recent items. */
export async function fetchNewsItems(query: string, n = 6): Promise<NewsItem[]> {
  return (await fetchNewsItemsResult(query, n)).items;
}

/** Free signal check for one named company (used by CSV import). Top N recent items. */
export async function fetchNewsForCompany(name: string, n = 2): Promise<NewsItem[]> {
  return fetchNewsItems(`"${name}"`, n);
}

/** Parse an arbitrary RSS/Atom feed URL (a company's own newsroom/blog). */
export async function fetchFeed(url: string, n = 8): Promise<NewsItem[]> {
  try {
    const feed = await parsePublicFeed(url);
    return (feed.items ?? []).slice(0, n).map((item) => ({
      source_name: "Company newsroom",
      source_url: (item.link ?? url).trim(),
      raw_excerpt: (item.title ?? "").trim(),
      signal_date: parseDateLoose(item.isoDate ?? item.pubDate),
    })).filter((s) => s.raw_excerpt);
  } catch { return []; }
}

export async function fetchGoogleNewsCandidates(
  queries: string[],
  perQuery = 3,
  maxTotal = Infinity,
): Promise<Candidate[]> {
  // Fetch all queries in parallel (source-isolated), then dedupe by article
  // link across queries and cap the total to bound enrichment cost.
  const feeds = await Promise.allSettled(queries.map((q) => parsePublicFeed(googleNewsRss(q))));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const f of feeds) {
    if (f.status !== "fulfilled") continue;
    let kept = 0;
    for (const item of f.value.items ?? []) {
      if (kept >= perQuery) break;
      const title = (item.title ?? "").trim();
      const link = (item.link ?? "").trim();
      if (!title || !link || seen.has(link)) continue;
      seen.add(link);
      const signal_date = parseDateLoose(item.isoDate ?? item.pubDate);
      out.push({
        name: title,
        source: "discovered",
        sources: ["google_news"],
        signals: [{ source_name: "Google News", source_url: link, raw_excerpt: title, signal_date }],
      });
      kept++;
      if (out.length >= maxTotal) return out;
    }
  }
  return out;
}
