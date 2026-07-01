import "server-only";
import Parser from "rss-parser";
import { googleNewsRss } from "@/config/news";
import { parseDateLoose } from "@/lib/time";
import type { Candidate } from "@/lib/ingest/types";

/**
 * Google News RSS adapter (FREE). Each item becomes a name-only candidate whose
 * "name" is the headline — the AI enrichment step extracts the actual company
 * and classifies territory. The article link is the signal's source_url.
 * Source-isolated: a failing feed never aborts the run.
 */
const parser = new Parser({ timeout: 12000 });

export interface NewsItem { source_name: string; source_url: string; raw_excerpt: string; signal_date: string | null }

/** Free Google News RSS fetch for an arbitrary query. Top N recent items. */
export async function fetchNewsItems(query: string, n = 6): Promise<NewsItem[]> {
  try {
    const feed = await parser.parseURL(googleNewsRss(query));
    return (feed.items ?? [])
      .slice(0, n)
      .map((item) => ({
        source_name: "Google News",
        source_url: (item.link ?? "").trim(),
        raw_excerpt: (item.title ?? "").trim(),
        signal_date: parseDateLoose(item.isoDate ?? item.pubDate),
      }))
      .filter((s) => s.source_url && s.raw_excerpt);
  } catch {
    return [];
  }
}

/** Free signal check for one named company (used by CSV import). Top N recent items. */
export async function fetchNewsForCompany(name: string, n = 2): Promise<NewsItem[]> {
  return fetchNewsItems(`"${name}"`, n);
}

/** Parse an arbitrary RSS/Atom feed URL (a company's own newsroom/blog). */
export async function fetchFeed(url: string, n = 8): Promise<NewsItem[]> {
  try {
    const feed = await parser.parseURL(url);
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
  const feeds = await Promise.allSettled(queries.map((q) => parser.parseURL(googleNewsRss(q))));
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
